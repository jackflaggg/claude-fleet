/**
 * Локальный процесс дашборда. Слушает только localhost.
 *
 *   POST /event          - принимает JSON события хука Claude Code (от hooks/report.sh)
 *   GET  /stream         - SSE-поток текущего состояния всех сессий
 *   GET  /               - страница дашборда
 *   POST /focus/:id      - фокусит WebStorm на проект сессии (webstorm <cwd>)
 *
 * Состояние держим в памяти + лёгкий персист на диск, чтобы рестарт сервера не терял
 * живые карточки. При ребуте системы (сессии реально мертвы) состояние сбрасывается:
 * определяем по времени загрузки системы. Звука и системных уведомлений нет намеренно -
 * единственный сигнал это сам борд.
 */

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyEvent, pruneStale, isHandledEvent } from './state.js';
import { resolveFocus } from './focus.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Конфиг из .env (опционально). Node 22 читает .env без зависимостей.
// Файла нет или он битый - молча остаёмся на дефолтах.
const ENV_FILE = join(ROOT, '.env');
if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // битый .env не должен ронять сервер
  }
}

const PORT = Number(process.env.FLEET_PORT) || 4319;
const HOST = process.env.FLEET_HOST || '127.0.0.1';
const INDEX_FILE = join(ROOT, 'public', 'index.html');
const STATE_FILE = join(ROOT, '.fleet-state.json');
const STALE_MS = (Number(process.env.FLEET_STALE_HOURS) || 6) * 60 * 60 * 1000;

/** Событие крупнее этого отбрасываем целиком: JSON нельзя распарсить по кусочку. */
const MAX_BODY = 1024 * 1024;
/** А это уже не наш хук, а чей-то поток без конца - рвём соединение, не дочитывая. */
const HARD_BODY_LIMIT = 32 * 1024 * 1024;

/** Лог в fleet.log со временем: без него в логе стопка одинаковых строк без понимания, когда. */
function log(message) {
  process.stdout.write(`${new Date().toLocaleString('ru-RU')}  ${message}\n`);
}

/**
 * Защита от DNS rebinding. Браузер обязан слать Host, и при ребайнде там будет чужой домен
 * (evil.com), а не localhost - хотя пакет придёт на 127.0.0.1. Без этой проверки любая
 * открытая вкладка может прочитать /stream, а там все промпты, пути проектов и команды Bash.
 * Свои хосты (посмотреть борд с планшета) добавляются через FLEET_ALLOWED_HOSTS.
 */
const ALLOWED_HOSTS = new Set([
  `${HOST}:${PORT}`,
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
  ...(process.env.FLEET_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
]);

function isAllowedHost(req) {
  const host = req.headers.host;
  return typeof host === 'string' && ALLOWED_HOSTS.has(host);
}

const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

/**
 * Отсекает запросы, инициированные чужой страницей. Host-проверка ловит rebinding, но не
 * обычный CSRF: сайт может честно постить на http://127.0.0.1:4319 и Host будет верным.
 * report.sh ходит через curl - у него нет ни Sec-Fetch-Site, ни Origin, поэтому он проходит.
 */
function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin !== '' && !ALLOWED_ORIGINS.has(origin);
}

/**
 * Лаунчер WebStorm и имя приложения берём из .env, не хардкодим в коде: путь установки
 * отличается между машинами (/usr/local vs homebrew). `webstorm <path>` фокусит окно
 * нужного проекта, если он открыт; `open -a <app>` так не умеет (поднимает последнее окно).
 */
const WEBSTORM_LAUNCHER = (() => {
  const launcher = process.env.FLEET_WEBSTORM;
  return launcher && existsSync(launcher) ? launcher : null;
})();
const WEBSTORM_APP = process.env.FLEET_WEBSTORM_APP || 'WebStorm';

/**
 * Восстанавливает состояние с диска, но только если файл записан ПОСЛЕ последней загрузки
 * системы. Если раньше - значит был ребут, все прежние сессии мертвы, начинаем с чистого.
 * Дополнительно отсекаем карточки старше STALE_MS.
 */
function loadState() {
  try {
    const bootMs = Date.now() - os.uptime() * 1000;
    if (statSync(STATE_FILE).mtimeMs < bootMs) return {};
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const now = Date.now();
    const fresh = {};
    for (const [id, card] of Object.entries(saved)) {
      if (card && now - (card.updatedAt || 0) < STALE_MS) fresh[id] = card;
    }
    return fresh;
  } catch {
    return {};
  }
}

let sessions = loadState();
const sseClients = new Set();

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Пишем через временный файл + rename (атомарная операция в пределах ФС): иначе
      // падение ровно в момент записи оставит обрезанный JSON, а loadState молча вернёт {}
      // и все живые карточки исчезнут разом.
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(sessions));
      renameSync(tmp, STATE_FILE);
    } catch {
      // персист не критичен, борд работает и без него
    }
  }, 500);
}

function snapshot() {
  return Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Незнакомые типы событий: имя -> сколько раз пришло. Копится до рестарта, на диск не идёт. */
const unknownEvents = new Map();
/**
 * Разных имён храним ограниченно, остальное сваливаем в одну строку. Иначе поток событий
 * с уникальными именами (кривой хук, чужой софт на том же порту) раздувал бы Map без предела:
 * на 3000 разных имён это стоило почти 7 МБ. Больше десятка типов всё равно не читаемо.
 */
const MAX_UNKNOWN_KINDS = 12;
const MAX_UNKNOWN_NAME = 40;
const OTHER_UNKNOWN = 'прочие';

function noteUnknownEvent(rawName) {
  const name = String(rawName).slice(0, MAX_UNKNOWN_NAME);
  const known = unknownEvents.has(name);
  const key = known || unknownEvents.size < MAX_UNKNOWN_KINDS ? name : OTHER_UNKNOWN;
  const seen = unknownEvents.get(key) ?? 0;
  unknownEvents.set(key, seen + 1);
  // в лог пишем только первый раз, чтобы поток событий не забил fleet.log
  if (seen === 0) log(`незнакомое событие хука: ${key} (борд его не понимает)`);
}

function payload() {
  const unknown = [...unknownEvents].map(([name, count]) => ({ name, count }));
  return `data: ${JSON.stringify({ sessions: snapshot(), unknown })}\n\n`;
}

function broadcast() {
  const data = payload();
  for (const client of sseClients) {
    // Клиент мог отвалиться в момент между записями (событие 'close' ещё не пришло) -
    // запись в разрушённый поток кинет ошибку. Ловим и выкидываем клиента, чтобы одна
    // мёртвая вкладка не срывала рассылку остальным.
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    // Событие с содержимым большого файла в tool_response может весить сотни КБ.
    // Сверх лимита в память не копим, но поток дочитываем: оборвать его - значит
    // разрушить сокет, и отправитель не получит внятный ответ, а просто увидит обрыв.
    if (size > MAX_BODY) {
      overflow = true;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) throw new Error(`тело события ${size} байт при лимите ${MAX_BODY}`);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleEvent(req, res) {
  // Отказываем по заявленному размеру, не начиная читать: обрыв уже начатого чтения
  // разрушает сокет, и код ответа до клиента не доходит.
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) {
    log(`событие отброшено: заявлено ${declared} байт, лимит ${MAX_BODY}`);
    res.writeHead(413).end();
    req.destroy();
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    // запрос оборвался или тело не влезло в лимит - роняем событие, но не процесс.
    // Пишем в лог: иначе карточка молча залипнет на прошлом статусе и это не объяснить.
    log(`событие отброшено: ${error.message}`);
    if (!res.writableEnded) res.writeHead(413).end();
    return;
  }
  if (!res.writableEnded) res.writeHead(204).end();

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  // bundle-id терминала сессии приходит отдельным заголовком (report.sh не трогает тело).
  const appHeader = req.headers['x-fleet-app'];
  if (typeof appHeader === 'string' && appHeader) event.appId = appHeader;

  if (event?.hook_event_name && !isHandledEvent(event.hook_event_name)) {
    noteUnknownEvent(event.hook_event_name);
  }

  sessions = applyEvent(sessions, event, Date.now());
  broadcast();
  persist();
}

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(payload());
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // соединение уже мертво - уборку сделает 'close'/'error'
    }
  }, 25_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  // без обработчика 'error' сбой SSE-сокета всплыл бы как необработанное исключение процесса
  res.on('error', cleanup);
}

/** Папка открыта как проект IDE - по .idea рядом. Единственный IO в решении о фокусе. */
function isProjectDir(cwd) {
  return existsSync(join(cwd, '.idea'));
}

function handleFocus(res, id) {
  const card = sessions[id];
  if (!card) {
    res.writeHead(404).end('нет такой сессии');
    return;
  }
  const target = resolveFocus(card, {
    launcher: WEBSTORM_LAUNCHER,
    app: WEBSTORM_APP,
    isProjectDir,
  });
  if (!target) {
    res.writeHead(204).end();
    return;
  }
  try {
    spawn(target.cmd, target.args, { stdio: 'ignore', detached: true }).unref();
    res.writeHead(200).end('ok');
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
}

/**
 * Убрать карточку руками. Нужно для зомби: SessionEnd приходит только на аккуратный /exit,
 * а после закрытия окна терминала карточка иначе висит до срабатывания pruneStale (часы).
 */
function handleDelete(res, id) {
  if (!sessions[id]) {
    res.writeHead(404).end('нет такой сессии');
    return;
  }
  const { [id]: removed, ...rest } = sessions;
  sessions = rest;
  broadcast();
  persist();
  res.writeHead(204).end();
}

async function handleIndex(res) {
  try {
    const html = await readFile(INDEX_FILE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  } catch {
    res.writeHead(500).end('index.html не найден');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!isAllowedHost(req)) {
    res.writeHead(403).end('чужой Host');
    return;
  }
  if (req.method !== 'GET' && isCrossSite(req)) {
    res.writeHead(403).end('запрос с чужой страницы');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    handleEvent(req, res).catch(() => {});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stream') return handleStream(req, res);

  if (req.method === 'POST' && url.pathname.startsWith('/focus/')) {
    const id = decodeURIComponent(url.pathname.slice('/focus/'.length));
    return handleFocus(res, id);
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/session/')) {
    const id = decodeURIComponent(url.pathname.slice('/session/'.length));
    return handleDelete(res, id);
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return handleIndex(res);
  }

  res.writeHead(404).end('not found');
});

/**
 * Периодическая уборка зомби-карточек: сессий, чей терминал закрыли/убили без SessionEnd.
 * Порог тот же STALE_MS, что и при восстановлении с диска. Активная сессия шлёт события хуков
 * куда чаще, поэтому под нож попадают только реально мёртвые. .unref() - таймер не держит
 * процесс живым сам по себе.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const pruned = pruneStale(sessions, Date.now(), STALE_MS);
  if (Object.keys(pruned).length !== Object.keys(sessions).length) {
    sessions = pruned;
    broadcast();
    persist();
  }
}, PRUNE_INTERVAL_MS).unref();

// Без своего обработчика ошибка listen всплывает необработанным исключением, launchd
// поднимает процесс заново - и так по кругу, а в логе только стопка стартовых строк.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`порт ${PORT} уже занят - борд уже запущен? (lsof -i :${PORT})`);
  } else {
    log(`сервер не поднялся: ${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`claude-fleet слушает http://${HOST}:${PORT}`);
});
