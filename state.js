/**
 * Чистое ядро дашборда: превращает поток событий хуков Claude Code
 * в набор карточек сессий. Без побочных эффектов, чтобы покрывать тестами.
 *
 * Одна карточка = одна сессия Claude Code (ключ - session_id).
 * Статус выводится приблизительно из типа события, точной телеметрии у хуков нет.
 */

export const STATUS = {
  READY: 'ready',
  THINKING: 'thinking',
  TOOL: 'tool',
  WORKING: 'working',
  ERROR: 'error',
  WAITING: 'waiting',
  COMPACTING: 'compacting',
};

/** Причина, по которой сессия попала в "ждут тебя" (только для STATUS.WAITING). */
export const WAIT_REASON = {
  FINISHED: 'finished', // Claude закончил ход, нужен следующий шаг
  PERMISSION: 'permission', // Claude просит разрешение на инструмент
  QUESTION: 'question', // Claude ждёт твой ответ на вопрос (AskUserQuestion / план / простой)
  FAILED: 'failed', // ход оборвался ошибкой API (StopFailure) - сессия встала сама
};

/**
 * События хука, которые борд понимает. Схема событий Claude Code не наша и может измениться
 * с обновлением: появится новый тип или переименуется старый. Тогда карточки начнут молча
 * врать (статус просто перестанет меняться), поэтому незнакомые имена считаем и показываем
 * в шапке борда - чтобы это было видно сразу, а не через неделю недоумения.
 */
export const HANDLED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
]);

export function isHandledEvent(name) {
  return HANDLED_EVENTS.has(name);
}

const MAX_TITLE = 300;
const MAX_TOOL_INFO = 70;
const MAX_NOTE = 120;

function clip(value, limit = MAX_TITLE) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/**
 * UserPromptSubmit прилетает не только на живой ввод человека, но и на системные инъекции
 * Claude Code: уведомление о завершении фоновой задачи (`<task-notification>`), слэш-команды,
 * ремайндеры, проброс вывода Bash. Такой текст не должен подменять реальную задачу пользователя
 * в заголовке карточки (иначе на борде вместо промпта висит служебный XML).
 */
const SERVICE_PROMPT_TAGS = [
  '<task-notification>',
  '<system-reminder>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];

function isServicePrompt(text) {
  if (typeof text !== 'string') return false;
  const head = text.trimStart();
  return SERVICE_PROMPT_TAGS.some((tag) => head.startsWith(tag));
}

function projectFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || 'unknown';
}

/**
 * Сессия в git-worktree живёт внутри родительского проекта (`.claude/worktrees/<имя>`), и по
 * последнему сегменту пути выглядела на борде отдельным проектом со своей группой и своей
 * монограммой. Это та же работа в изолированной копии: группы плодились на ровном месте,
 * а связь с родителем терялась. Имя ветки-копии оставляем отдельным полем - оно объясняет,
 * почему в одном проекте вдруг две сессии правят одно и то же.
 */
const WORKTREE_MARK = '/.claude/worktrees/';

function placeFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return { project: 'unknown', worktree: null };
  const at = cwd.indexOf(WORKTREE_MARK);
  if (at < 0) return { project: projectFromCwd(cwd), worktree: null };
  const name = cwd.slice(at + WORKTREE_MARK.length).replace(/\/+$/, '').split('/')[0];
  return { project: projectFromCwd(cwd.slice(0, at)), worktree: name || null };
}

/** bundle-id приложения-терминала -> человекочитаемое имя для метки на карточке. */
const TERMINAL_NAMES = {
  'com.jetbrains.WebStorm': 'WebStorm',
  'com.jetbrains.intellij': 'IntelliJ',
  'com.jetbrains.pycharm': 'PyCharm',
  'com.jetbrains.PhpStorm': 'PhpStorm',
  'com.jetbrains.goland': 'GoLand',
  'com.jetbrains.rubymine': 'RubyMine',
  'com.jetbrains.CLion': 'CLion',
  'com.jetbrains.datagrip': 'DataGrip',
  'com.jetbrains.rider': 'Rider',
  'org.alacritty': 'Alacritty',
  'io.alacritty': 'Alacritty',
  'com.googlecode.iterm2': 'iTerm',
  'com.apple.Terminal': 'Terminal',
  'dev.warp.Warp-Stable': 'Warp',
  'net.kovidgoyal.kitty': 'kitty',
  'com.github.wez.wezterm': 'WezTerm',
  'com.mitchellh.ghostty': 'Ghostty',
};

function terminalName(appId) {
  if (typeof appId !== 'string' || !appId) return '';
  if (TERMINAL_NAMES[appId]) return TERMINAL_NAMES[appId];
  return appId.split('.').pop() || '';
}

/** Последние 2 сегмента пути, чтобы было понятно что за файл, но не занимало всю карточку. */
function shortPath(p) {
  if (typeof p !== 'string' || !p) return '';
  const segments = p.split('/').filter(Boolean);
  return segments.slice(-2).join('/');
}

/** Короткое человекочитаемое "над чем сейчас работает" из tool_input конкретного инструмента. */
function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Bash':
      return clip(input.command, MAX_TOOL_INFO);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return clip(shortPath(input.file_path || input.notebook_path), MAX_TOOL_INFO);
    case 'Grep':
    case 'Glob':
      return clip(input.pattern, MAX_TOOL_INFO);
    case 'Task':
      return clip(input.description || input.subagent_type, MAX_TOOL_INFO);
    case 'WebFetch':
    case 'WebSearch':
      return clip(input.url || input.query, MAX_TOOL_INFO);
    default: {
      const firstString = Object.values(input).find((v) => typeof v === 'string');
      return firstString ? clip(firstString, MAX_TOOL_INFO) : '';
    }
  }
}

function isToolError(toolResponse) {
  return Boolean(
    toolResponse &&
      typeof toolResponse === 'object' &&
      (toolResponse.error || toolResponse.is_error || toolResponse.isError),
  );
}

/**
 * Тип уведомления Claude Code присылает отдельным полем notification_type. Оно точнее
 * текста: формулировка message меняется между версиями, а разбор по подстроке "permission"
 * ломается молча. Текстовый фолбэк ниже оставлен намеренно - поле есть не во всех версиях,
 * и без него борд должен продолжать работать как раньше.
 */
const NOTIFICATION_REASON = {
  permission_prompt: WAIT_REASON.PERMISSION,
  idle_prompt: WAIT_REASON.QUESTION,
  agent_needs_input: WAIT_REASON.QUESTION,
  elicitation_dialog: WAIT_REASON.QUESTION,
};

/**
 * Уведомления, которые ничего от тебя не хотят (успешный логин, закрытый диалог). Раньше
 * любой Notification красил карточку в красное - и борд звал к сессии, которой ты не нужен.
 *
 * agent_completed здесь по той же причине, по которой статус не трогает SubagentStop:
 * закончился фоновый агент, а сессия работает дальше. Причём у фонового агента свой
 * session_id, так что уведомление прилетает не в родительскую карточку, а в собственную -
 * пустую, без промпта и без терминала за спиной. Пока оно значило "закончил ход", такая
 * карточка навсегда зависала красной в "ждут тебя" и топила там настоящие. Реальный конец
 * хода даёт Stop, он карточку и красит.
 */
const INFO_NOTIFICATIONS = new Set([
  'auth_success',
  'elicitation_complete',
  'elicitation_response',
  'agent_completed',
]);

function notificationKind(event) {
  return typeof event.notification_type === 'string' ? event.notification_type : '';
}

function waitReasonFromNotification(event) {
  const known = NOTIFICATION_REASON[notificationKind(event)];
  if (known) return known;
  // Фолбэк для версий без notification_type: различаем причину по тексту уведомления.
  const message = typeof event.message === 'string' ? event.message.toLowerCase() : '';
  const isPermission =
    message.includes('permission') ||
    message.includes('approve') ||
    message.includes('разреш');
  // Всё, что не про разрешение (вопрос, элиситация, простой), считаем "нужен твой ответ".
  return isPermission ? WAIT_REASON.PERMISSION : WAIT_REASON.QUESTION;
}

/**
 * Применяет одно событие хука к текущему набору сессий и возвращает новый набор
 * (иммутабельно). Малформленные события (без session_id / hook_event_name) игнорирует.
 *
 * @param {Record<string, object>} sessions текущее состояние
 * @param {object} event распарсенный JSON события хука
 * @param {number} now метка времени в мс (передаётся снаружи ради чистоты функции)
 * @returns {Record<string, object>} новый набор сессий
 */
export function applyEvent(sessions, event, now) {
  const next = { ...sessions };
  const sourceId = event?.session_id;
  const eventName = event?.hook_event_name;
  if (!sourceId || !eventName) return next;
  const agent = event?.agent === 'codex' ? 'codex' : 'claude';
  // Пространства id разделены явно: схема обоих агентов использует session_id, и хотя UUID
  // почти наверняка не столкнутся, карточка и DELETE/focus не должны зависеть от «почти».
  const id = agent === 'codex' ? `codex:${sourceId}` : sourceId;

  if (eventName === 'SessionEnd') {
    delete next[id];
    return next;
  }

  const place = placeFromCwd(event.cwd);
  const previous = next[id] ?? {
    sessionId: id,
    sourceSessionId: sourceId,
    agent,
    project: place.project,
    worktree: place.worktree,
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    appId: null,
    terminal: null,
    processPid: null,
    title: '',
    tool: null,
    toolInfo: null,
    status: STATUS.READY,
    reason: null,
    note: null,
    waitingSince: null,
  };

  const card = { ...previous, updatedAt: now };
  // Старый персист появился до поддержки нескольких агентов. Отсутствующее поле всегда
  // означает Claude: такие карточки должны пережить обновление без миграции файла состояния.
  if (!card.agent) card.agent = agent;
  // момент, когда карточку впервые увидели; ставим один раз и не трогаем - для «идёт N мин».
  // Проставляем здесь (а не в дефолте выше), чтобы карточки, поднятые с диска до появления
  // поля, тоже получили его на ближайшем событии, а не остались навсегда без возраста.
  if (!card.createdAt) card.createdAt = now;
  if (typeof event.cwd === 'string' && event.cwd) {
    card.cwd = event.cwd;
    card.project = place.project;
    card.worktree = place.worktree;
  }
  // bundle-id приложения-терминала, где живёт сессия (для клика + метки на карточке).
  if (typeof event.appId === 'string' && event.appId) {
    card.appId = event.appId;
    card.terminal = terminalName(event.appId);
  }
  if (agent === 'codex' && Number.isSafeInteger(event.processPid) && event.processPid > 1) {
    card.processPid = event.processPid;
  }

  switch (eventName) {
    case 'SessionStart':
      card.status = STATUS.READY;
      card.tool = null;
      card.toolInfo = null;
      card.reason = null;
      card.note = null;
      break;
    case 'UserPromptSubmit':
      card.status = STATUS.THINKING;
      card.tool = null;
      card.toolInfo = null;
      card.reason = null;
      card.note = null;
      {
        const prompt = event.prompt ?? event.user_prompt;
        // Служебную инъекцию не пишем в заголовок - сохраняем прошлую реальную задачу.
        if (typeof prompt === 'string' && prompt.trim() && !isServicePrompt(prompt)) {
          card.title = clip(prompt);
        }
      }
      break;
    case 'PreToolUse':
      card.status = STATUS.TOOL;
      card.reason = null;
      card.note = null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    case 'PermissionRequest':
      card.status = STATUS.WAITING;
      card.reason = WAIT_REASON.PERMISSION;
      card.note = clip(event.tool_input?.description, MAX_NOTE) || null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    case 'PostToolUse':
      card.status = isToolError(event.tool_response) ? STATUS.ERROR : STATUS.WORKING;
      card.reason = null;
      card.note = null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    // Выделенное событие ошибки инструмента: точнее, чем нюхать tool_response вслепую.
    case 'PostToolUseFailure':
      card.status = STATUS.ERROR;
      card.reason = null;
      card.note = null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    case 'Notification': {
      const kind = notificationKind(event);
      // Информационное уведомление - не повод звать человека к сессии.
      if (INFO_NOTIFICATIONS.has(kind)) break;
      // idle_prompt значит "ты давно не отвечал", а не новую причину ожидания. Оно прилетает
      // повторно, пока сессия ждёт, и раньше подменяло исходную причину: карточка "закончил
      // ход" превращалась в "нужен ответ". Уже ждущую карточку такое уведомление не трогает.
      if (kind === 'idle_prompt' && previous.status === STATUS.WAITING) break;
      card.status = STATUS.WAITING;
      card.reason = waitReasonFromNotification(event);
      // Текст уведомления - единственное место, где видно, ЧЕГО именно от тебя хотят
      // ("Claude needs your permission to use Bash"). Без него карточка говорит только
      // "ждёт разрешения", и приходится идти в терминал, чтобы это выяснить.
      card.note = clip(event.message, MAX_NOTE) || null;
      break;
    }
    case 'Stop':
      card.status = STATUS.WAITING;
      card.reason = WAIT_REASON.FINISHED;
      card.note = null;
      break;
    // Ход оборвался ошибкой API. Без этого события сессия оставалась в статусе "думает",
    // выглядела живой и только через IDLE_MS тускнела - то есть мёртвая сессия была
    // неотличима от работающей ровно там, ради чего борд и существует.
    case 'StopFailure':
      card.status = STATUS.WAITING;
      card.reason = WAIT_REASON.FAILED;
      card.tool = null;
      card.toolInfo = null;
      card.note = clip(event.message ?? event.error, MAX_NOTE) || null;
      break;
    // Компакция контекста идёт без единого события инструмента: карточка замирала на
    // последнем туле и уходила в "нет активности", хотя сессия жива и занята делом.
    case 'PreCompact':
      card.status = STATUS.COMPACTING;
      card.tool = null;
      card.toolInfo = null;
      card.reason = null;
      card.note = null;
      break;
    case 'PostCompact':
      card.status = STATUS.THINKING;
      card.tool = null;
      card.toolInfo = null;
      break;
    // SubagentStop намеренно не меняет статус: заканчивается субагент, а сама сессия
    // продолжает работать. Пометить её "закончил ход" - значит покрасить в красное
    // работающую сессию и утопить в "ждут тебя" настоящие. Обновляем только updatedAt.
    case 'SubagentStop':
      break;
    default:
      break;
  }

  // Момент входа в ожидание. Отдельно от updatedAt, потому что updatedAt - это "последняя
  // активность" и его двигает любое событие: повторный idle-Notification, SubagentStop.
  // Пока время ожидания считалось от updatedAt, счётчик "ждёт N мин" обнулялся сам собой,
  // и карточка проваливалась вниз секции, отсортированной "дольше всех ждущий сверху" -
  // то есть секция прятала ровно то, ради чего её и завели.
  if (card.status === STATUS.WAITING) {
    if (previous.status !== STATUS.WAITING || !previous.waitingSince) card.waitingSince = now;
  } else {
    card.waitingSince = null;
  }

  next[id] = card;
  return next;
}

/** Карточка в состоянии STATUS.WAITING считается требующей внимания. */
export function isWaiting(card) {
  return card?.status === STATUS.WAITING;
}

/**
 * Карточка, которая за всю жизнь не показала ни задачи, ни инструмента. Так выглядит не
 * работа, а мусор: фоновый агент со своим session_id, остаток от перехода в worktree,
 * забытая пустая сессия. Сообщить ей нечего, поэтому держать её на борде наравне с живой
 * работой незачем - а на первом же настоящем событии она вернётся сама.
 */
function isBlank(card) {
  return !card?.title && !card?.tool;
}

/**
 * Возвращает набор сессий без протухших - тех, что не обновлялись дольше staleMs
 * (пустые - дольше blankMs, он короче).
 * Нужна, потому что карточка удаляется по SessionEnd, а оно приходит только на аккуратный
 * выход (/exit). При закрытии окна терминала, kill или крэше события нет, и зомби-карточка
 * иначе висела бы на борде вечно. Чистая функция (время и пороги - снаружи), вызывается
 * по таймеру из server.js. Возвращает новый объект; если ничего не протухло - все прежние
 * карточки на месте (сравнивай размеры на стороне вызова, чтобы не слать лишний broadcast).
 */
export function pruneStale(sessions, now, staleMs, blankMs = staleMs) {
  const next = {};
  for (const [id, card] of Object.entries(sessions)) {
    const limit = isBlank(card) ? blankMs : staleMs;
    if (now - (card?.updatedAt ?? 0) < limit) next[id] = card;
  }
  return next;
}
