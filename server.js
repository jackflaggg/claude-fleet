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
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyEvent } from './state.js';

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
      writeFileSync(STATE_FILE, JSON.stringify(sessions));
    } catch {
      // персист не критичен, борд работает и без него
    }
  }, 500);
}

function snapshot() {
  return Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function payload() {
  return `data: ${JSON.stringify({ sessions: snapshot() })}\n\n`;
}

function broadcast() {
  const data = payload();
  for (const client of sseClients) client.write(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleEvent(req, res) {
  const raw = await readBody(req);
  res.writeHead(204).end();

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  // bundle-id терминала сессии приходит отдельным заголовком (report.sh не трогает тело).
  const appHeader = req.headers['x-fleet-app'];
  if (typeof appHeader === 'string' && appHeader) event.appId = appHeader;

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

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

/**
 * Куда вернуть по клику. Сессия живёт не обязательно в WebStorm - может быть Alacritty,
 * iTerm, Terminal (например `claude` из home). Открываем проект в WebStorm только если это
 * реальный проект (есть .idea) и терминал - WebStorm. Иначе просто выводим вперёд то
 * приложение-терминал, где сессия запущена. Так клик по home-сессии из Alacritty не пытается
 * открыть home как проект (иначе WebStorm показывает диалог доверия и падает).
 */
function resolveFocus(card) {
  const appId = typeof card.appId === 'string' ? card.appId : '';
  const cwd = typeof card.cwd === 'string' ? card.cwd : '';
  const isJetBrains = appId.startsWith('com.jetbrains.');
  const isProject = Boolean(cwd) && existsSync(join(cwd, '.idea'));

  if (isJetBrains && isProject && WEBSTORM_LAUNCHER) return { cmd: WEBSTORM_LAUNCHER, args: [cwd] };
  if (appId && !isJetBrains) return { cmd: 'open', args: ['-b', appId] };
  if (isJetBrains) return { cmd: 'open', args: ['-b', appId] };
  if (isProject && WEBSTORM_LAUNCHER) return { cmd: WEBSTORM_LAUNCHER, args: [cwd] };
  return null;
}

function handleFocus(res, id) {
  const card = sessions[id];
  if (!card) {
    res.writeHead(404).end('нет такой сессии');
    return;
  }
  const target = resolveFocus(card);
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

  if (req.method === 'POST' && url.pathname === '/event') return handleEvent(req, res);
  if (req.method === 'GET' && url.pathname === '/stream') return handleStream(req, res);

  if (req.method === 'POST' && url.pathname.startsWith('/focus/')) {
    const id = decodeURIComponent(url.pathname.slice('/focus/'.length));
    return handleFocus(res, id);
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return handleIndex(res);
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`claude-fleet слушает http://${HOST}:${PORT}\n`);
});
