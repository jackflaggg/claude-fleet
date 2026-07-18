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

function clip(value, limit = MAX_TITLE) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function projectFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || 'unknown';
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
  const message = typeof event.message === 'string' ? event.message.toLowerCase() : '';
  const matcher = typeof event.matcher === 'string' ? event.matcher.toLowerCase() : '';
  const isPermission =
    matcher.includes('permission') ||
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
    title: '',
    tool: null,
    toolInfo: null,
    status: STATUS.READY,
    reason: null,
  };

  const card = { ...previous, updatedAt: now };
  if (typeof event.cwd === 'string' && event.cwd) {
    card.cwd = event.cwd;
    card.project = projectFromCwd(event.cwd);
  }
  // bundle-id приложения-терминала, где живёт сессия (для решения "куда вернуть по клику").
  if (typeof event.appId === 'string' && event.appId) card.appId = event.appId;

  switch (eventName) {
    case 'SessionStart':
      card.status = STATUS.READY;
      card.tool = null;
      card.toolInfo = null;
      card.reason = null;
      break;
    case 'UserPromptSubmit':
      card.status = STATUS.THINKING;
      card.tool = null;
      card.toolInfo = null;
      card.reason = null;
      {
        const prompt = event.prompt ?? event.user_prompt;
        if (typeof prompt === 'string' && prompt.trim()) card.title = clip(prompt);
      }
      break;
    case 'PreToolUse':
      card.status = STATUS.TOOL;
      card.reason = null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    case 'PostToolUse':
      card.status = isToolError(event.tool_response) ? STATUS.ERROR : STATUS.WORKING;
      card.reason = null;
      if (typeof event.tool_name === 'string') {
        card.tool = event.tool_name;
        card.toolInfo = toolTarget(event.tool_name, event.tool_input);
      }
      break;
    case 'Notification':
      card.status = STATUS.WAITING;
      card.reason = waitReasonFromNotification(event);
      break;
    case 'Stop':
    case 'SubagentStop':
      card.status = STATUS.WAITING;
      card.reason = WAIT_REASON.FINISHED;
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
