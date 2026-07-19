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
};

/** Причина, по которой сессия попала в "ждут тебя" (только для STATUS.WAITING). */
export const WAIT_REASON = {
  FINISHED: 'finished', // Claude закончил ход, нужен следующий шаг
  PERMISSION: 'permission', // Claude просит разрешение на инструмент
  QUESTION: 'question', // Claude ждёт твой ответ на вопрос (AskUserQuestion / план / простой)
};

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

function waitReasonFromNotification(event) {
  // Различаем причину только по тексту уведомления: у события Notification нет поля matcher
  // (matcher - это конфиг хука в settings.json, в payload он не приходит).
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
  const id = event?.session_id;
  const eventName = event?.hook_event_name;
  if (!id || !eventName) return next;

  if (eventName === 'SessionEnd') {
    delete next[id];
    return next;
  }

  const previous = next[id] ?? {
    sessionId: id,
    project: projectFromCwd(event.cwd),
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    appId: null,
    terminal: null,
    title: '',
    tool: null,
    toolInfo: null,
    status: STATUS.READY,
    reason: null,
    note: null,
  };

  const card = { ...previous, updatedAt: now };
  // момент, когда карточку впервые увидели; ставим один раз и не трогаем - для «идёт N мин».
  // Проставляем здесь (а не в дефолте выше), чтобы карточки, поднятые с диска до появления
  // поля, тоже получили его на ближайшем событии, а не остались навсегда без возраста.
  if (!card.createdAt) card.createdAt = now;
  if (typeof event.cwd === 'string' && event.cwd) {
    card.cwd = event.cwd;
    card.project = projectFromCwd(event.cwd);
  }
  // bundle-id приложения-терминала, где живёт сессия (для клика + метки на карточке).
  if (typeof event.appId === 'string' && event.appId) {
    card.appId = event.appId;
    card.terminal = terminalName(event.appId);
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
    case 'PostToolUse':
      card.status = isToolError(event.tool_response) ? STATUS.ERROR : STATUS.WORKING;
      card.reason = null;
      card.note = null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    case 'Notification':
      card.status = STATUS.WAITING;
      card.reason = waitReasonFromNotification(event);
      // Текст уведомления - единственное место, где видно, ЧЕГО именно от тебя хотят
      // ("Claude needs your permission to use Bash"). Без него карточка говорит только
      // "ждёт разрешения", и приходится идти в терминал, чтобы это выяснить.
      card.note = clip(event.message, MAX_NOTE) || null;
      break;
    case 'Stop':
      card.status = STATUS.WAITING;
      card.reason = WAIT_REASON.FINISHED;
      card.note = null;
      break;
    // SubagentStop намеренно не меняет статус: заканчивается субагент, а сама сессия
    // продолжает работать. Пометить её "закончил ход" - значит покрасить в красное
    // работающую сессию и утопить в "ждут тебя" настоящие. Обновляем только updatedAt.
    case 'SubagentStop':
      break;
    default:
      break;
  }

  next[id] = card;
  return next;
}

/** Карточка в состоянии STATUS.WAITING считается требующей внимания. */
export function isWaiting(card) {
  return card?.status === STATUS.WAITING;
}

/**
 * Возвращает набор сессий без протухших - тех, что не обновлялись дольше staleMs.
 * Нужна, потому что карточка удаляется по SessionEnd, а оно приходит только на аккуратный
 * выход (/exit). При закрытии окна терминала, kill или крэше события нет, и зомби-карточка
 * иначе висела бы на борде вечно. Чистая функция (время и порог - снаружи), вызывается
 * по таймеру из server.js. Возвращает новый объект; если ничего не протухло - все прежние
 * карточки на месте (сравнивай размеры на стороне вызова, чтобы не слать лишний broadcast).
 */
export function pruneStale(sessions, now, staleMs) {
  const next = {};
  for (const [id, card] of Object.entries(sessions)) {
    if (now - (card?.updatedAt ?? 0) < staleMs) next[id] = card;
  }
  return next;
}
