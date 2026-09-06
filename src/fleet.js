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
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { extname, join, resolve, sep } from 'node:path';
import { applyEvent, pruneStale, isHandledEvent } from './fleet/state.js';
import { resolveFocus } from './focus/focus.js';
import { buildAllowLists, isAllowedHost, isCrossSite, boundedKey } from './http/guards.js';
import { collectStamps, foldStamps, describeWindow, isFreshTranscript } from './usage/usage.js';
import { isProcessAlive, pruneClosedSessions } from './fleet/liveness.js';
import { AGENT } from '../public/js/lib/domain.js';
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
 * Буфер один на процесс, а не на экземпляр: два экземпляра в одном процессе бывают только
 * в тестах, и сканы у них последовательны внутри каждого, а транскрипты там пустые.
 */
const READ_BUFFER = Buffer.allocUnsafe(1024 * 1024);

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

  /**
   * Восстанавливает состояние с диска, но только если файл записан ПОСЛЕ последней загрузки
   * системы. Если раньше - значит был ребут, все прежние сессии мертвы, начинаем с чистого.
   * Дополнительно отсекаем карточки старше STALE_MS (пустые - старше BLANK_MS), теми же
   * порогами, что и рантайм-уборка зомби.
   */
  function loadState() {
    try {
      if (statSync(STATE_FILE).mtimeMs < bootMs) return {};
      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return pruneStale(saved, clock(), STALE_MS, BLANK_MS);
    } catch {
      return {};
    }
  }

  let sessions = loadState();

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

  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeState();
    }, 500);
  }

  function writeState() {
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
      const fresh = await listFreshTranscripts(clock());
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
    const usage = describeWindow(usageWindow, clock(), USAGE_WINDOW_MS);
    return `data: ${JSON.stringify({ sessions: snapshot(), unknown, usage })}\n\n`;
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

    const now = clock();
    sessions = applyEvent(sessions, event, now);
    if (CHANNEL_ENABLED) channels.dropSettled(now, Object.values(sessions));
    broadcast();
    persist();
  }

  function handleStream(req, res) {
    // Борд открыли после паузы: пока его никто не смотрел, транскрипты не читались,
    // и окно лимита успело уехать. Пересчитываем сразу, не дожидаясь тика опроса.
    if (boards.size === 0) scanUsage();
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
      if (boards.size > 0) scanUsage();
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
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      writeState();
    }
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
