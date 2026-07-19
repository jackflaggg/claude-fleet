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
import { buildAllowLists, isAllowedHost, isCrossSite, boundedKey } from './guards.js';

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
 * Кто имеет право обращаться к борду. Списки и сами проверки живут в guards.js (чистое ядро
 * с тестами): Origin выводится из тех же хостов, что и Host, иначе борд с планшета
 * (FLEET_ALLOWED_HOSTS) открывался бы на просмотр, но клик по карточке ловил 403.
 */
const { hosts: ALLOWED_HOSTS, origins: ALLOWED_ORIGINS } = buildAllowLists({
  host: HOST,
  port: PORT,
  extraHosts: process.env.FLEET_ALLOWED_HOSTS,
});

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

/**
 * Счётчики для диагностики (`GET /stats`). Нужны, чтобы не гадать о цене хука: у события
 * PostToolUse в tool_response лежит результат инструмента, и на большом Read это могут быть
 * сотни КБ через curl на каждый вызов. Держим только числа: одна запись на тип события.
 */
const stats = { startedAt: Date.now(), events: 0, bytes: 0, byEvent: new Map() };

/**
 * Число строк в разбивке ограничено ровно так же, как в unknownEvents: раньше здесь копился
 * любой присланный hook_event_name без предела, и поток событий с уникальными именами
 * раздувал Map (замерено: 3000 имён = +12 МБ RSS). Своих типов событий двенадцать,
 * запаса до лимита хватает с головой, остальное сваливается в «прочие».
 */
const MAX_EVENT_KINDS = 24;

function noteEventSize(name, bytes) {
  stats.events += 1;
  stats.bytes += bytes;
  const key = boundedKey(stats.byEvent, name, MAX_EVENT_KINDS);
  const row = stats.byEvent.get(key) ?? { count: 0, bytes: 0, max: 0 };
  row.count += 1;
  row.bytes += bytes;
  if (bytes > row.max) row.max = bytes;
  stats.byEvent.set(key, row);
}

function handleStats(res) {
  const byEvent = [...stats.byEvent]
    .map(([name, row]) => ({
      name,
      count: row.count,
      maxKb: +(row.max / 1024).toFixed(1),
      avgKb: +(row.bytes / row.count / 1024).toFixed(2),
    }))
    .sort((a, b) => b.maxKb - a.maxKb);
  const body = {
    uptimeMin: +((Date.now() - stats.startedAt) / 60000).toFixed(1),
    rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
    sessions: Object.keys(sessions).length,
    boards: sseClients.size,
    events: stats.events,
    totalMb: +(stats.bytes / 1048576).toFixed(2),
    snapshotKb: +(payload().length / 1024).toFixed(1),
    byEvent,
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

/** Незнакомые типы событий: имя -> сколько раз пришло. Копится до рестарта, на диск не идёт. */
const unknownEvents = new Map();
/** Разных имён храним ограниченно (см. boundedKey), больше десятка всё равно не читаемо. */
const MAX_UNKNOWN_KINDS = 12;

function noteUnknownEvent(rawName) {
  const key = boundedKey(unknownEvents, rawName, MAX_UNKNOWN_KINDS);
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

  if (event?.hook_event_name) {
    noteEventSize(event.hook_event_name, raw.length);
    if (!isHandledEvent(event.hook_event_name)) noteUnknownEvent(event.hook_event_name);
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

  if (!isAllowedHost(req.headers, ALLOWED_HOSTS)) {
    res.writeHead(403).end('чужой Host');
    return;
  }
  if (req.method !== 'GET' && isCrossSite(req.headers, ALLOWED_ORIGINS)) {
    res.writeHead(403).end('запрос с чужой страницы');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    handleEvent(req, res).catch(() => {});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stream') return handleStream(req, res);
  if (req.method === 'GET' && url.pathname === '/stats') return handleStats(res);

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
