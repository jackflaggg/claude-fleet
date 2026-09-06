/**
 * Локальный процесс дашборда. Слушает только localhost.
 *
 *   POST /event          - принимает JSON события хука Claude Code (от hooks/report.sh)
 *   GET  /stream         - SSE-поток текущего состояния всех сессий
 *   GET  /               - страница дашборда
 *   POST /focus/:id      - фокусит WebStorm на проект сессии (webstorm <cwd>)
 *   /channel/*           - ответ с борда через канал Claude Code, только при FLEET_CHANNEL=1
 *
 * Состояние держим в памяти + лёгкий персист на диск, чтобы рестарт сервера не терял
 * живые карточки. При ребуте системы (сессии реально мертвы) состояние сбрасывается:
 * определяем по времени загрузки системы. Звука и системных уведомлений нет намеренно -
 * единственный сигнал это сам борд.
 */

import http from 'node:http';
import os from 'node:os';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { applyEvent, pruneStale, isHandledEvent } from './src/fleet/state.js';
import { resolveFocus } from './src/focus/focus.js';
import { buildAllowLists, isAllowedHost, isCrossSite, boundedKey } from './src/http/guards.js';
import { collectStamps, foldStamps, describeWindow, isFreshTranscript } from './src/usage/usage.js';
import { isProcessAlive, pruneClosedSessions } from './src/fleet/liveness.js';
import { AGENT, isAskingPermission } from './public/js/lib/domain.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Лог в fleet.log со временем: без него в логе стопка одинаковых строк без понимания, когда. */
function log(message) {
  process.stdout.write(`${new Date().toLocaleString('ru-RU')}  ${message}\n`);
}

// Конфиг из .env (опционально). Node 22 читает .env без зависимостей; уже заданные
// переменные окружения файл не перебивает. Файла нет - дефолты; битый - дефолты и строка в лог.
const ENV_FILE = join(ROOT, '.env');
if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    log(`.env не прочитался (${error.message}), работаю на дефолтах`);
  }
}

/**
 * Число из окружения. Не задано - дефолт молча; задано, но не число или меньше min - дефолт
 * со строкой в лог. Прежний `Number(x) || 6` превращал FLEET_STALE_HOURS=0 в шесть часов,
 * и опечатка в конфиге не проявлялась ничем.
 */
function envNumber(name, fallback, min = Number.MIN_VALUE) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min) return value;
  log(`${name}=${raw}: ожидалось число не меньше ${min}, беру ${fallback}`);
  return fallback;
}

const PORT = envNumber('FLEET_PORT', 4319, 1);
const HOST = process.env.FLEET_HOST || '127.0.0.1';
const PUBLIC_DIR = join(ROOT, 'public');
const INDEX_FILE = join(PUBLIC_DIR, 'index.html');
const STATIC_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);
// Путь персиста настраиваемый ради тестов: они поднимают настоящий server.js спавном и не
// должны затирать состояние живого борда в этом же репозитории.
const STATE_FILE = process.env.FLEET_STATE_FILE || join(ROOT, '.fleet-state.json');
const STALE_MS = envNumber('FLEET_STALE_HOURS', 6) * 60 * 60 * 1000;
// Отдельный, куда более короткий порог для карточек без задачи и без инструмента: за ними
// нет работы, которую можно потерять (см. isBlank в state.js).
const BLANK_MS = envNumber('FLEET_BLANK_MINUTES', 15) * 60 * 1000;
const LIVENESS_INTERVAL_MS = 10 * 1000;
const LIVENESS_GRACE_MS = 10 * 1000;

/**
 * Ответ с борда идёт через канал Claude Code (research preview): отдельный MCP-процесс
 * `channel/fleet-channel.js` на каждую сессию, который Claude Code сам запускает и который
 * держит к нам SSE `/channel/commands`. Прототип за флагом: без него ни маршрутов, ни полей
 * в снимке, борд выглядит и работает как раньше.
 */
const CHANNEL_ENABLED = process.env.FLEET_CHANNEL === '1';
/** Каналов не больше, чем живых сессий; потолок страхует Map от роста при бесконечных реконнектах. */
const MAX_CHANNELS = 64;
/** Тело команды с борда: текст ответа, а не результат инструмента. */
const MAX_CHANNEL_BODY = 16 * 1024;
const MAX_CHANNEL_TEXT = 4000;
/**
 * Запрос разрешения, на который карточка так и не встала в ожидание, считаем закрытым
 * в терминале. Пауза нужна из-за порядка событий: уведомление канала и hook-событие
 * идут разными путями, и любое из них может прийти первым.
 */
const PERMISSION_SETTLE_MS = 3000;

/**
 * Окно лимита Claude. Папка транскриптов и длина окна - в .env: путь машинно-зависимый,
 * а пять часов это свойство тарифа, а не наше решение. Опрос раз в минуту: старт окна
 * двигается только первым запросом после паузы, чаще смотреть нечего (обратный отсчёт
 * тикает на фронте сам).
 */
const TRANSCRIPTS_DIR = process.env.FLEET_TRANSCRIPTS || join(os.homedir(), '.claude', 'projects');
const USAGE_WINDOW_MS = envNumber('FLEET_USAGE_HOURS', 5) * 60 * 60 * 1000;
/**
 * Claude открывает окно не по секунде первого запроса, а по границе получаса вниз (сверено
 * с `/usage`, см. usage.js). 0 отключает выравнивание, если в тарифе это изменится.
 */
const USAGE_ALIGN_MS = envNumber('FLEET_USAGE_ALIGN_MIN', 30, 0) * 60 * 1000;
const USAGE_POLL_MS = 60 * 1000;
/**
 * Потолок на первое чтение незнакомого файла. Транскрипт долгой сессии доходит до 16 МБ,
 * такой читается целиком; лимит нужен, чтобы файл-патология не втянул в память сотни МБ.
 */
const USAGE_MAX_TAIL = 24 * 1024 * 1024;
/**
 * Единственный буфер чтения на весь процесс, аллоцируется один раз.
 *
 * Так и задумано: чтение потоком аллоцировало новый буфер на каждый кусок, и на 48 МБ свежих
 * транскриптов это давало 48 МБ мусора быстрее, чем GC успевал прибирать - RSS подскакивал
 * с 60 до 120 МБ. Сканы идут строго последовательно (флаг usageScanning), поэтому общий
 * буфер безопасен. Мегабайта хватает: в него должна помещаться одна запись транскрипта.
 */
const READ_BUFFER = Buffer.allocUnsafe(1024 * 1024);

/**
 * Событие крупнее этого отбрасываем целиком: JSON нельзя распарсить по кусочку. Четыре
 * мегабайта, а не один: в fleet.log 03.09 два PostToolUse по 1.0 и 1.3 МБ (tool_response
 * с большим файлом) были отброшены, и карточка залипла на прошлом статусе до следующего тула.
 */
const MAX_BODY = 4 * 1024 * 1024;
/** А это уже не наш хук, а чей-то поток без конца - рвём соединение, не дочитывая. */
const HARD_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * Рассылка снимка коалесцируется: шторм событий хука (несколько в секунду на активную сессию)
 * иначе давал снимок всего состояния на каждое событие - замерено 20 КБ на событие при
 * двадцати сессиях, 123 МБ на один борд за 6000 событий. Полсотни миллисекунд глаз не видит.
 */
const BROADCAST_DEBOUNCE_MS = 50;
/**
 * Потолок несброшенного буфера одного SSE-клиента. Клиент, который перестал читать (вкладка на
 * уснувшем планшете, half-open TCP), иначе копит снимки в памяти сервера без предела:
 * замерено +203 МБ RSS за 6000 событий. Такого клиента рвём, EventSource переподключится сам.
 */
const SSE_MAX_BUFFERED = 1024 * 1024;
/** TCP keepalive на SSE-сокетах, чтобы мёртвый пир закрылся сам, а не висел в реестре. */
const SSE_KEEPALIVE_MS = 30_000;

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
 * Дополнительно отсекаем карточки старше STALE_MS (пустые - старше BLANK_MS), теми же
 * порогами, что и рантайм-уборка зомби.
 */
function loadState() {
  try {
    const bootMs = Date.now() - os.uptime() * 1000;
    if (statSync(STATE_FILE).mtimeMs < bootMs) return {};
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return pruneStale(saved, Date.now(), STALE_MS, BLANK_MS);
  } catch {
    return {};
  }
}

let sessions = loadState();
const sseClients = new Set();

let closedSince = new Map();

/**
 * В отличие от SessionEnd (у Claude его нет при закрытии окна, у Codex он приходит через
 * 30 минут), PID отражает реальную живую сессию. signal 0 ничего не посылает процессу,
 * только проверяет его существование. Два последовательных промаха не дают
 * переподключению мигать карточкой.
 */
function scanLiveness() {
  const pids = [...new Set(Object.values(sessions)
    .filter((card) => Number.isSafeInteger(card?.processPid))
    .map((card) => card.processPid))];
  const alivePids = new Set();
  for (const pid of pids) {
    if (isProcessAlive(pid)) alivePids.add(pid);
  }
  const result = pruneClosedSessions(
    sessions,
    alivePids,
    closedSince,
    Date.now(),
    LIVENESS_GRACE_MS,
  );
  closedSince = result.missingSince;
  if (result.sessions !== sessions) {
    sessions = result.sessions;
    broadcast();
    persist();
  }
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Пишем через временный файл + rename (атомарная операция в пределах ФС): иначе
      // падение ровно в момент записи оставит обрезанный JSON, а loadState молча вернёт {}
      // и все живые карточки исчезнут разом.
      // В файле промпты и команды Bash сессий: читать его должен только владелец.
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
      renameSync(tmp, STATE_FILE);
    } catch {
      // персист не критичен, борд работает и без него
    }
  }, 500);
}

function snapshot() {
  const cards = Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return CHANNEL_ENABLED ? cards.map(withChannel) : cards;
}

/**
 * Канал ответа: pid процесса агента -> открытый SSE-ответ процессу канала. Ключ тот же,
 * что у карточки (`processPid`), так карточка и канал находят друг друга без общего id:
 * процесс канала знает только своего родителя (`process.ppid`), а hook-команда - своего.
 * В состоянии карточек этого нет намеренно: канал живёт ровно столько, сколько соединение.
 */
const channels = new Map();
/** pid -> открытый запрос разрешения из Claude Code, пока борд или терминал не ответили. */
const pendingPermissions = new Map();

function withChannel(card) {
  const pid = card.processPid;
  const pending = pendingPermissions.get(pid);
  return {
    ...card,
    channel: channels.has(pid),
    permission: pending
      ? { requestId: pending.requestId, toolName: pending.toolName, description: pending.description, inputPreview: pending.inputPreview }
      : null,
  };
}

function sendChannelCommand(pid, command) {
  const channel = channels.get(pid);
  if (!channel) return false;
  return writeSse(channel.res, `data: ${JSON.stringify(command)}\n\n`);
}

/**
 * Запись в SSE-поток с защитой от клиента, который перестал читать. Возврат `write` и буфер
 * `writableLength` раньше игнорировались, и мёртвый пир копил снимки в памяти без предела.
 * Разрушенный сокет прибирает его же обработчик 'close'.
 */
function writeSse(res, data) {
  if (res.writableLength > SSE_MAX_BUFFERED) {
    log(`SSE-клиент не читает (${res.writableLength} байт в буфере), отключаю`);
    res.destroy();
    return false;
  }
  try {
    res.write(data);
    return true;
  } catch {
    res.destroy();
    return false;
  }
}

function openSse(req, res, comment) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  req.socket.setKeepAlive(true, SSE_KEEPALIVE_MS);
  res.write(`: ${comment}\n\n`);
  return setInterval(() => writeSse(res, ': ping\n\n'), 25_000);
}

/** Процесс канала держит этот поток открытым всю жизнь сессии; команды борда идут по нему. */
function handleChannelCommands(req, res, url) {
  const pid = Number(url.searchParams.get('pid'));
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    res.writeHead(400).end('нужен pid');
    return;
  }
  if (!channels.has(pid) && channels.size >= MAX_CHANNELS) {
    res.writeHead(503).end('слишком много каналов');
    return;
  }
  // Переподключение того же процесса: прежний поток закрываем, иначе команды уйдут в пустоту.
  const previous = channels.get(pid);
  if (previous) {
    try { previous.res.end(); } catch { /* уже закрыт */ }
  }
  const heartbeat = openSse(req, res, 'fleet channel');
  channels.set(pid, { res, since: Date.now() });
  const cleanup = () => {
    clearInterval(heartbeat);
    if (channels.get(pid)?.res !== res) return;
    channels.delete(pid);
    pendingPermissions.delete(pid);
    broadcast();
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
  log(`канал подключён: pid ${pid}`);
  broadcast();
}

/**
 * Форма request_id, которую Claude Code отдавал каналу на момент прототипа: пять строчных
 * букв. Это наблюдение, а не контракт, поэтому отказ по нему обязан попадать в лог: иначе
 * смена формата в новой версии выглядит как «кнопки разрешения просто не появляются».
 */
const REQUEST_ID_RE = /^[a-km-z]{5}$/;

/** Claude Code открыл диалог разрешения и отдал его каналу; тот пересылает сюда. */
async function handlePermissionRequest(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_CHANNEL_BODY));
  } catch {
    res.writeHead(400).end('плохое тело');
    return;
  }
  const pid = Number(body?.pid);
  const requestId = String(body?.request_id ?? '');
  if (!channels.has(pid)) {
    res.writeHead(409).end('канал не подключён');
    return;
  }
  if (!REQUEST_ID_RE.test(requestId)) {
    log(`запрос разрешения отклонён: request_id «${requestId.slice(0, 40)}» не похож на формат Claude Code, обновился формат?`);
    res.writeHead(409).end('плохой request_id');
    return;
  }
  pendingPermissions.set(pid, {
    requestId,
    toolName: String(body.tool_name ?? '').slice(0, 80),
    description: String(body.description ?? '').slice(0, 400),
    inputPreview: String(body.input_preview ?? '').slice(0, 1200),
    at: Date.now(),
  });
  res.writeHead(204).end();
  broadcast();
}

/** Кнопка «Разрешить»/«Отказать» на карточке. */
async function handlePermissionVerdict(req, res, id) {
  const card = sessions[id];
  const pending = card && pendingPermissions.get(card.processPid);
  if (!pending) {
    res.writeHead(409).end('запрос разрешения уже закрыт');
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_CHANNEL_BODY));
  } catch {
    res.writeHead(400).end('плохое тело');
    return;
  }
  const behavior = body?.behavior === 'allow' ? 'allow' : body?.behavior === 'deny' ? 'deny' : null;
  if (!behavior) {
    res.writeHead(400).end('behavior: allow | deny');
    return;
  }
  const sent = sendChannelCommand(card.processPid, { type: 'permission', request_id: pending.requestId, behavior });
  pendingPermissions.delete(card.processPid);
  res.writeHead(sent ? 204 : 409).end();
  broadcast();
}

/** Строка ответа на карточке: текст уходит в сессию как следующий ход. */
async function handleChannelMessage(req, res, id) {
  const card = sessions[id];
  if (!card || !channels.has(card.processPid)) {
    res.writeHead(409).end('у сессии нет канала');
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_CHANNEL_BODY));
  } catch {
    res.writeHead(400).end('плохое тело');
    return;
  }
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_CHANNEL_TEXT) : '';
  if (!text) {
    res.writeHead(400).end('пустой текст');
    return;
  }
  const sent = sendChannelCommand(card.processPid, { type: 'message', text });
  res.writeHead(sent ? 204 : 409).end();
}

/**
 * Запрос разрешения, который закрыли в терминале, нам никто не сообщит: Claude Code шлёт
 * каналу только открытие. Признак - карточка не стоит (или уже не стоит) в ожидании
 * разрешения, с паузой на разный порядок прихода уведомления и hook-события.
 */
function dropSettledPermissions(now) {
  if (!pendingPermissions.size) return;
  const byPid = new Map();
  for (const card of Object.values(sessions)) {
    if (Number.isSafeInteger(card?.processPid)) byPid.set(card.processPid, card);
  }
  for (const [pid, pending] of pendingPermissions) {
    if (now - pending.at < PERMISSION_SETTLE_MS) continue;
    if (!isAskingPermission(byPid.get(pid))) pendingPermissions.delete(pid);
  }
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
  const cpu = process.cpuUsage();
  const body = {
    uptimeMin: +((Date.now() - stats.startedAt) / 60000).toFixed(1),
    rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
    // Суммарное процессорное время за всю жизнь процесса: борд стоит открытым сутками,
    // и цену фонового опроса транскриптов иначе видно только профайлером.
    cpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(1),
    sessions: Object.keys(sessions).length,
    boards: sseClients.size,
    channels: channels.size,
    usageFiles: transcriptOffsets.size,
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

/**
 * Окно лимита: одно на весь аккаунт, поэтому и состояние одно, а не по сессии.
 * Смещения по файлам нужны, чтобы после первого разбора дочитывать только хвосты:
 * на живых данных свежие транскрипты весят 44 МБ и разбираются 110 мс, а прирост
 * за минуту это десятки килобайт.
 */
let usageWindow = null;
let usageScanning = false;
const transcriptOffsets = new Map();

/** Файлы, которые ещё могут содержать записи текущего окна (обход дерева стоит ~2 мс). */
async function listFreshTranscripts(now) {
  const fresh = [];
  let dirs;
  try {
    dirs = await readdir(TRANSCRIPTS_DIR, { withFileTypes: true });
  } catch {
    return fresh; // папки нет - Claude Code сюда не пишет, окно просто не показываем
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const projectDir = join(TRANSCRIPTS_DIR, dir.name);
    let files;
    try {
      files = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const path = join(projectDir, file.name);
      try {
        const info = await stat(path);
        if (isFreshTranscript(info.mtimeMs, now, USAGE_WINDOW_MS)) fresh.push({ path, size: info.size });
      } catch {
        // файл исчез между readdir и stat - обычное дело, сессия могла закончиться
      }
    }
  }
  return fresh;
}

/**
 * Дочитывает хвост одного транскрипта и складывает найденные метки в stamps.
 *
 * Читаем потоком по кускам и разбираем их буфером (см. collectStamps): в памяти живёт
 * highWaterMark плюс одна незавершённая строка, независимо от того, 16 МБ в файле или 200.
 * Ранняя остановка «дочитали до старых записей - хватит» тут не нужна: замерено, что почти
 * весь объём свежих транскриптов и так относится к последним десяти часам (48 МБ из 65).
 */
async function readNewStamps(file, stamps) {
  const seen = transcriptOffsets.get(file.path);
  // Файл короче запомненного смещения - его усекли или подменили: знакомимся заново.
  // Метки при этом посчитаются повторно и счётчик запросов в подсказке завысится; граница
  // окна (единственное, что стоит в шапке) не съедет - её задаёт самая ранняя метка.
  // Транскрипты только дописываются, так что случай редкий и цена ошибки копеечная.
  const stale = seen == null || seen > file.size;
  const from = stale ? Math.max(0, file.size - USAGE_MAX_TAIL) : seen;
  if (from >= file.size) return;

  // Транскрипт дописывают прямо сейчас, поэтому хвост почти всегда обрывается на середине
  // строки. Незавершённый остаток переносим в следующий кусок и не учитываем в смещении -
  // дочитаем его следующим проходом, когда строка станет целой.
  let handle;
  let tail = 0; // байт незавершённой строки, перенесённых в начало буфера
  try {
    handle = await open(file.path, 'r');
    let position = from;
    while (position < file.size) {
      const { bytesRead } = await handle.read(READ_BUFFER, tail, READ_BUFFER.length - tail, position);
      if (!bytesRead) break;
      position += bytesRead;
      const view = READ_BUFFER.subarray(0, tail + bytesRead);
      const consumed = collectStamps(view, stamps);
      tail = view.length - consumed;
      // Незавершённую строку переносим в начало буфера и дочитываем следующим куском.
      if (tail > 0 && consumed > 0) READ_BUFFER.copy(READ_BUFFER, 0, consumed, view.length);
      // Одна запись длиннее всего буфера (в tool_response попадают большие файлы): дальше
      // копить некуда, роняем её и читаем дальше. Потеря одной метки границу окна не двигает -
      // её задаёт самая ранняя метка, а рядом всегда есть соседние записи.
      if (tail === READ_BUFFER.length) tail = 0;
    }
    transcriptOffsets.set(file.path, file.size - tail);
  } catch {
    // нет доступа или файл пропал - окно переживёт пропуск одного транскрипта
  } finally {
    await handle?.close();
  }
}

async function scanUsage() {
  if (usageScanning) return;
  usageScanning = true;
  try {
    const fresh = await listFreshTranscripts(Date.now());
    // Реестр смещений не должен расти вечно: выпавшие из окна свежести файлы забываем,
    // иначе за месяцы работы в Map осядут тысячи путей давно закрытых сессий.
    const alive = new Set(fresh.map((file) => file.path));
    for (const path of transcriptOffsets.keys()) {
      if (!alive.has(path)) transcriptOffsets.delete(path);
    }

    const stamps = [];
    for (const file of fresh) await readNewStamps(file, stamps);

    const next = foldStamps(usageWindow, stamps, USAGE_WINDOW_MS, USAGE_ALIGN_MS);
    const changed = next?.start !== usageWindow?.start || next?.requests !== usageWindow?.requests;
    usageWindow = next;
    if (changed) broadcast();
  } catch (error) {
    log(`окно лимита не пересчиталось: ${error.message}`);
  } finally {
    usageScanning = false;
  }
}

function payload() {
  const unknown = [...unknownEvents].map(([name, count]) => ({ name, count }));
  const usage = describeWindow(usageWindow, Date.now(), USAGE_WINDOW_MS);
  return `data: ${JSON.stringify({ sessions: snapshot(), unknown, usage })}\n\n`;
}

let broadcastTimer = null;

/** Снимок уходит бордам не сразу, а пачкой за BROADCAST_DEBOUNCE_MS: см. константу. */
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(flushBroadcast, BROADCAST_DEBOUNCE_MS);
}

function flushBroadcast() {
  broadcastTimer = null;
  if (!sseClients.size) return;
  const data = payload();
  for (const client of sseClients) writeSse(client, data);
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    // Событие с содержимым большого файла в tool_response может весить сотни КБ.
    // Сверх лимита в память не копим, но поток дочитываем: оборвать его - значит
    // разрушить сокет, и отправитель не получит внятный ответ, а просто увидит обрыв.
    if (size > limit) {
      overflow = true;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) throw new Error(`тело события ${size} байт при лимите ${limit}`);
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
  // Тело hook-события у Claude и Codex почти одинаковое. Источник задаёт наш репортёр
  // отдельным заголовком, чтобы не переписывать/не буферизовать JSON на горячем пути.
  const agentHeader = req.headers['x-fleet-agent'];
  if (agentHeader === AGENT.CODEX) event.agent = AGENT.CODEX;
  const pidHeader = Number(req.headers['x-fleet-pid']);
  if (Number.isSafeInteger(pidHeader) && pidHeader > 1) event.processPid = pidHeader;

  if (event?.hook_event_name) {
    noteEventSize(event.hook_event_name, raw.length);
    if (!isHandledEvent(event.hook_event_name)) noteUnknownEvent(event.hook_event_name);
  }

  const now = Date.now();
  sessions = applyEvent(sessions, event, now);
  if (CHANNEL_ENABLED) dropSettledPermissions(now);
  broadcast();
  persist();
}

function handleStream(req, res) {
  // Борд открыли после паузы: пока его никто не смотрел, транскрипты не читались,
  // и окно лимита успело уехать. Пересчитываем сразу, не дожидаясь тика опроса.
  if (sseClients.size === 0) scanUsage();
  if (sseClients.size === 0) scanLiveness();
  const heartbeat = openSse(req, res, 'fleet');
  res.write(payload());
  sseClients.add(res);
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
    const child = spawn(target.cmd, target.args, { stdio: 'ignore', detached: true });
    // spawn бросает синхронно не всё: ENOENT (лаунчера нет по пути из .env) приходит
    // событием 'error' и без обработчика роняет весь процесс борда
    child.on('error', (error) => log(`фокус не удался (${target.cmd}): ${error.message}`));
    child.unref();
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

/**
 * Статические клиентские слои. Разрешаем только известные типы внутри public: серверу не
 * нужен универсальный файловый браузер, а проверка корня не даёт URL выйти через ../.
 */
async function handlePublicAsset(res, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400).end('bad path');
    return;
  }
  const file = resolve(PUBLIC_DIR, relativePath);
  const contentType = STATIC_TYPES.get(extname(file));
  if (!file.startsWith(PUBLIC_DIR + sep) || !contentType) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const content = await readFile(file);
    // Шрифты не меняются, а весят треть мегабайта: их браузер держит в кэше, остальное
    // перепроверяет на каждом обновлении вкладки.
    const cache = extname(file) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cache,
    }).end(content);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/**
 * id сессии из хвоста пути. Битое percent-encoding даёт null, а не URIError: раньше один
 * `POST /focus/%` ронял весь процесс, и launchd поднимал его лишь через ThrottleInterval.
 */
function decodeId(pathname, prefix) {
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

/** Ошибку асинхронного обработчика не глотаем молча: иначе карточка залипает без следа в логе. */
function guard(promise, res, what) {
  promise.catch((error) => {
    log(`${what}: ${error.message}`);
    if (!res.headersSent) res.writeHead(500).end();
  });
}

function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!isAllowedHost(req.headers, ALLOWED_HOSTS)) {
    res.writeHead(403).end('чужой Host');
    return;
  }
  // Мутирует состояние не только не-GET: GET /channel/commands регистрирует канал и рвёт
  // прежний. Без этой проверки чужая страница перехватывала канал и забивала реестр до 503.
  const mutating = req.method !== 'GET' || url.pathname.startsWith('/channel/');
  if (mutating && isCrossSite(req.headers, ALLOWED_ORIGINS)) {
    res.writeHead(403).end('запрос с чужой страницы');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    return guard(handleEvent(req, res), res, 'событие не обработано');
  }
  if (req.method === 'GET' && url.pathname === '/stream') return handleStream(req, res);
  if (req.method === 'GET' && url.pathname === '/stats') return handleStats(res);

  if (req.method === 'POST' && url.pathname.startsWith('/focus/')) {
    const id = decodeId(url.pathname, '/focus/');
    return id === null ? res.writeHead(400).end('плохой id') : handleFocus(res, id);
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/session/')) {
    const id = decodeId(url.pathname, '/session/');
    return id === null ? res.writeHead(400).end('плохой id') : handleDelete(res, id);
  }

  if (CHANNEL_ENABLED && url.pathname.startsWith('/channel/')) {
    if (req.method === 'GET' && url.pathname === '/channel/commands') return handleChannelCommands(req, res, url);
    if (req.method === 'POST' && url.pathname === '/channel/permission-request') {
      return guard(handlePermissionRequest(req, res), res, 'запрос разрешения не обработан');
    }
    if (req.method === 'POST' && url.pathname.startsWith('/channel/permission/')) {
      const id = decodeId(url.pathname, '/channel/permission/');
      if (id === null) return res.writeHead(400).end('плохой id');
      return guard(handlePermissionVerdict(req, res, id), res, 'вердикт не обработан');
    }
    if (req.method === 'POST' && url.pathname.startsWith('/channel/message/')) {
      const id = decodeId(url.pathname, '/channel/message/');
      if (id === null) return res.writeHead(400).end('плохой id');
      return guard(handleChannelMessage(req, res, id), res, 'ответ сессии не обработан');
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return handleIndex(res);
  }
  if (req.method === 'GET' && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/js/'))) {
    return handlePublicAsset(res, url.pathname);
  }

  res.writeHead(404).end('not found');
}

// Синхронная ошибка в маршруте иначе всплывает необработанным исключением и убивает процесс
// вместе со всеми SSE-подключениями; 500 одному запросу дешевле.
const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (error) {
    log(`маршрут ${req.method} ${req.url} упал: ${error.stack}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

/**
 * Периодическая уборка зомби-карточек: сессий, чей терминал закрыли/убили без SessionEnd.
 * Пороги те же, что и при восстановлении с диска. Активная сессия шлёт события хуков
 * куда чаще, поэтому под нож попадают только реально мёртвые. .unref() - таймер не держит
 * процесс живым сам по себе.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const pruned = pruneStale(sessions, Date.now(), STALE_MS, BLANK_MS);
  if (Object.keys(pruned).length !== Object.keys(sessions).length) {
    sessions = pruned;
    broadcast();
    persist();
  }
}, PRUNE_INTERVAL_MS).unref();

// Закрытые сессии убираем быстро; без открытого борда даже дешёвые проверки не нужны.
setInterval(() => {
  if (sseClients.size > 0) scanLiveness();
}, LIVENESS_INTERVAL_MS).unref();

/**
 * Пересчёт окна лимита - только пока борд кто-то смотрит. Без открытых вкладок читать
 * транскрипты незачем: процесс должен стоять ровно на нуле, как и до этой фичи.
 */
setInterval(() => {
  if (sseClients.size > 0) scanUsage();
}, USAGE_POLL_MS).unref();

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
