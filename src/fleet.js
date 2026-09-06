/**
 * Композиция борда: `createFleet({ config, root, log })` собирает HTTP-сервер со всем
 * состоянием (карточки, каналы, окно лимита, счётчики) и таймерами внутри и отдаёт
 * `{ server, close }`. Entry `server.js` только читает конфиг и зовёт `listen`.
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
 *
 * Синглтонов на уровне модуля нет: каждый вызов фабрики это независимый экземпляр, поэтому
 * тесты маршрутов могут поднимать его в своём процессе и закрывать в `finally`.
 */

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { extname, join, resolve, sep } from 'node:path';
import { applyEvent, pruneStale, isHandledEvent } from './fleet/state.js';
import { normalizeHookEvent } from './fleet/hook-event.js';
import { createSessionStore } from './fleet/store.js';
import { resolveFocus } from './focus/focus.js';
import { buildAllowLists, isAllowedHost, isCrossSite, boundedKey } from './http/guards.js';
import { describeWindow } from './usage/usage.js';
import { createUsageScanner } from './usage/scanner.js';
import { isProcessAlive, pruneClosedSessions } from './fleet/liveness.js';
import { createSseHub } from './http/sse-hub.js';
import { MAX_BODY, readBody } from './http/body.js';
import { createChannelRegistry } from './channel/registry.js';
import { createChannelRoutes } from './channel/routes.js';

const STATIC_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);
const LIVENESS_INTERVAL_MS = 10 * 1000;
const LIVENESS_GRACE_MS = 10 * 1000;

/**
 * Окно лимита Claude: папка транскриптов, длина и выравнивание окна приходят из конфига.
 * Опрос раз в минуту: старт окна двигается только первым запросом после паузы, чаще
 * смотреть нечего (обратный отсчёт тикает на фронте сам).
 */
const USAGE_POLL_MS = 60 * 1000;

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
 * Число строк в разбивке /stats ограничено ровно так же, как в unknownEvents: раньше здесь
 * копился любой присланный hook_event_name без предела, и поток событий с уникальными именами
 * раздувал Map (замерено: 3000 имён = +12 МБ RSS). Своих типов событий двенадцать,
 * запаса до лимита хватает с головой, остальное сваливается в «прочие».
 */
const MAX_EVENT_KINDS = 24;
/** Разных незнакомых имён храним ограниченно (см. boundedKey), больше десятка всё равно не читаемо. */
const MAX_UNKNOWN_KINDS = 12;

/**
 * Периодическая уборка зомби-карточек: сессий, чей терминал закрыли/убили без SessionEnd.
 * Пороги те же, что и при восстановлении с диска. Активная сессия шлёт события хуков
 * куда чаще, поэтому под нож попадают только реально мёртвые.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

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

/**
 * @param {object} deps
 * @param {object} deps.config замороженный конфиг из `loadConfig`
 * @param {string} deps.root корень репозитория: отсюда раздаётся `public/`
 * @param {(line: string) => void} deps.log
 * @param {() => number} [deps.clock] источник времени, в тестах подменяется
 * @param {(pid: number) => boolean} [deps.probe] проверка живости процесса
 * @param {typeof spawnProcess} [deps.spawn] запуск лаунчера фокуса
 * @param {number} [deps.bootMs] момент загрузки системы: персист старше него это прошлая жизнь
 */
export function createFleet({
  config,
  root,
  log,
  clock = Date.now,
  probe = isProcessAlive,
  spawn = spawnProcess,
  bootMs = Date.now() - os.uptime() * 1000,
}) {
  const {
    port: PORT,
    host: HOST,
    stateFile: STATE_FILE,
    staleMs: STALE_MS,
    blankMs: BLANK_MS,
    channelEnabled: CHANNEL_ENABLED,
    transcriptsDir: TRANSCRIPTS_DIR,
    usageWindowMs: USAGE_WINDOW_MS,
    usageAlignMs: USAGE_ALIGN_MS,
    webstormLauncher: WEBSTORM_LAUNCHER,
    webstormApp: WEBSTORM_APP,
  } = config;

  const PUBLIC_DIR = join(root, 'public');
  const INDEX_FILE = join(PUBLIC_DIR, 'index.html');

  const SSE_OPTIONS = { log, maxBuffered: SSE_MAX_BUFFERED, keepAliveMs: SSE_KEEPALIVE_MS, debounceMs: BROADCAST_DEBOUNCE_MS };
  /** Открытые борды: им уходит снимок состояния. Заголовки, heartbeat и уборка живут в хабе. */
  const boards = createSseHub(SSE_OPTIONS);
  /** Потоки команд к процессам канала: тот же хаб, но адресная запись, без рассылки снимка. */
  const channelStreams = createSseHub(SSE_OPTIONS);

  /**
   * Кто имеет право обращаться к борду. Списки и сами проверки живут в guards.js (чистое ядро
   * с тестами): Origin выводится из тех же хостов, что и Host, иначе борд с планшета
   * (FLEET_ALLOWED_HOSTS) открывался бы на просмотр, но клик по карточке ловил 403.
   */
  const { hosts: ALLOWED_HOSTS, origins: ALLOWED_ORIGINS } = buildAllowLists({
    host: HOST,
    port: PORT,
    extraHosts: config.extraHosts,
  });

  /** Персист: страховка на рестарт, при ребуте сбрасывается (bootMs), формат и миграции в store. */
  const store = createSessionStore({ file: STATE_FILE, log, clock, bootMs, staleMs: STALE_MS, blankMs: BLANK_MS });
  let sessions = store.load();

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
      if (probe(pid)) alivePids.add(pid);
    }
    const result = pruneClosedSessions(
      sessions,
      alivePids,
      closedSince,
      clock(),
      LIVENESS_GRACE_MS,
    );
    closedSince = result.missingSince;
    if (result.sessions !== sessions) {
      sessions = result.sessions;
      broadcast();
      persist();
    }
  }

  function persist() {
    store.schedule(sessions);
  }

  function snapshot() {
    const cards = Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return CHANNEL_ENABLED ? cards.map(channels.decorate) : cards;
  }

  /**
   * Ответ с борда идёт через канал Claude Code (research preview): отдельный MCP-процесс
   * `channel/fleet-channel.js` на каждую сессию, который Claude Code сам запускает и который
   * держит к нам SSE `/channel/commands`. Прототип за флагом FLEET_CHANNEL=1 (CHANNEL_ENABLED):
   * без него ни маршрутов, ни полей в снимке, борд выглядит и работает как раньше.
   */
  const channels = createChannelRegistry({ hub: channelStreams, clock, log, onChange: () => broadcast() });
  const channelRoutes = createChannelRoutes({
    registry: channels,
    findCard: (id) => sessions[id],
    broadcast: () => broadcast(),
  });

  /**
   * Счётчики для диагностики (`GET /stats`). Нужны, чтобы не гадать о цене хука: у события
   * PostToolUse в tool_response лежит результат инструмента, и на большом Read это могут быть
   * сотни КБ через curl на каждый вызов. Держим только числа: одна запись на тип события.
   */
  const stats = { startedAt: clock(), events: 0, bytes: 0, byEvent: new Map() };

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
      uptimeMin: +((clock() - stats.startedAt) / 60000).toFixed(1),
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      // Суммарное процессорное время за всю жизнь процесса: борд стоит открытым сутками,
      // и цену фонового опроса транскриптов иначе видно только профайлером.
      cpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(1),
      sessions: Object.keys(sessions).length,
      boards: boards.size,
      channels: channels.size,
      usageFiles: usage.files,
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

  function noteUnknownEvent(rawName) {
    const key = boundedKey(unknownEvents, rawName, MAX_UNKNOWN_KINDS);
    const seen = unknownEvents.get(key) ?? 0;
    unknownEvents.set(key, seen + 1);
    // в лог пишем только первый раз, чтобы поток событий не забил fleet.log
    if (seen === 0) log(`незнакомое событие хука: ${key} (борд его не понимает)`);
  }

  /** Окно лимита: одно на весь аккаунт. Файлы читает сканер, борд получает только границы. */
  const usage = createUsageScanner({
    dir: TRANSCRIPTS_DIR,
    windowMs: USAGE_WINDOW_MS,
    alignMs: USAGE_ALIGN_MS,
    log,
    clock,
    onChange: () => broadcast(),
  });

  function payload() {
    const unknown = [...unknownEvents].map(([name, count]) => ({ name, count }));
    const window = describeWindow(usage.window, clock(), USAGE_WINDOW_MS);
    return `data: ${JSON.stringify({ sessions: snapshot(), unknown, usage: window })}\n\n`;
  }

  /** Снимок уходит бордам не сразу, а пачкой за BROADCAST_DEBOUNCE_MS: дебаунс живёт в хабе. */
  function broadcast() {
    boards.broadcast(payload);
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

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    // Схема хука и заголовки репортёра известны только hook-event.js.
    const event = normalizeHookEvent(parsed, req.headers);
    if (event.kind) {
      noteEventSize(event.kind, raw.length);
      if (!isHandledEvent(event.kind)) noteUnknownEvent(event.kind);
    }

    const now = clock();
    sessions = applyEvent(sessions, event, now);
    if (CHANNEL_ENABLED) channels.dropSettled(now, Object.values(sessions));
    broadcast();
    persist();
  }

  function handleStream(req, res) {
    // Борд открыли после паузы: пока его никто не смотрел, транскрипты не читались,
    // и окно лимита успело уехать. Пересчитываем сразу, не дожидаясь тика опроса.
    if (boards.size === 0) usage.scan();
    if (boards.size === 0) scanLiveness();
    const handle = boards.open(req, res, 'fleet');
    boards.write(handle, payload());
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
      if (req.method === 'GET' && url.pathname === '/channel/commands') return channelRoutes.commands(req, res, url);
      if (req.method === 'POST' && url.pathname === '/channel/permission-request') {
        return guard(channelRoutes.permissionRequest(req, res), res, 'запрос разрешения не обработан');
      }
      if (req.method === 'POST' && url.pathname.startsWith('/channel/permission/')) {
        const id = decodeId(url.pathname, '/channel/permission/');
        if (id === null) return res.writeHead(400).end('плохой id');
        return guard(channelRoutes.permissionVerdict(req, res, id), res, 'вердикт не обработан');
      }
      if (req.method === 'POST' && url.pathname.startsWith('/channel/message/')) {
        const id = decodeId(url.pathname, '/channel/message/');
        if (id === null) return res.writeHead(400).end('плохой id');
        return guard(channelRoutes.message(req, res, id), res, 'ответ сессии не обработан');
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

  // .unref() - таймеры не держат процесс живым сами по себе; close() их снимает.
  const timers = [
    setInterval(() => {
      const pruned = pruneStale(sessions, clock(), STALE_MS, BLANK_MS);
      if (Object.keys(pruned).length !== Object.keys(sessions).length) {
        sessions = pruned;
        broadcast();
        persist();
      }
    }, PRUNE_INTERVAL_MS),
    // Закрытые сессии убираем быстро; без открытого борда даже дешёвые проверки не нужны.
    setInterval(() => {
      if (boards.size > 0) scanLiveness();
    }, LIVENESS_INTERVAL_MS),
    // Пересчёт окна лимита - только пока борд кто-то смотрит. Без открытых вкладок читать
    // транскрипты незачем: процесс должен стоять ровно на нуле, как и до этой фичи.
    setInterval(() => {
      if (boards.size > 0) usage.scan();
    }, USAGE_POLL_MS),
  ];
  for (const timer of timers) timer.unref();

  /**
   * Останавливает экземпляр целиком: таймеры, SSE-клиентов, отложенный персист (пишется
   * сразу, чтобы состояние не потерялось) и сам сервер. После разрешения промиса открытых
   * хендлов у экземпляра нет.
   */
  function close() {
    for (const timer of timers) clearInterval(timer);
    store.close();
    boards.close();
    channelStreams.close();
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, close };
}
