/**
 * Антикоррупционный слой над схемой хуков: здесь, и только здесь, известны имена полей
 * событий Claude Code и Codex (`session_id`, `hook_event_name`, `tool_input`, `user_prompt`
 * у Codex, `tool_response.is_error`...) и заголовки `report.sh` (`X-Fleet-App`, `X-Fleet-Agent`,
 * `X-Fleet-Pid`). Ядро состояния получает `FleetEvent` и о сырой схеме не знает: обновится
 * Claude Code - правится один файл и его тест на образцах.
 *
 * Тело хука у Claude и Codex почти одинаковое. Источник задаёт репортёр отдельным заголовком,
 * чтобы не переписывать и не буферизовать JSON на горячем пути.
 */

import { AGENT } from '../../public/js/lib/domain.js';

/**
 * @typedef {object} FleetEvent
 * @property {string} agent         AGENT.CLAUDE | AGENT.CODEX
 * @property {string|null} sessionId  session_id как прислал агент
 * @property {string|null} kind      hook_event_name
 * @property {string} cwd
 * @property {string|null} appId     bundle-id терминала сессии
 * @property {number|null} pid       PID процесса агента ($PPID hook-команды)
 * @property {string|null} prompt    текст промпта (UserPromptSubmit)
 * @property {string|null} tool      имя инструмента
 * @property {object|null} toolInput tool_input как есть
 * @property {string} notification   notification_type ('' если нет)
 * @property {string|null} message   текст уведомления или ошибки
 * @property {boolean} isError       инструмент ответил ошибкой
 */

const text = (value) => (typeof value === 'string' ? value : null);

function isToolError(toolResponse) {
  return Boolean(
    toolResponse &&
      typeof toolResponse === 'object' &&
      (toolResponse.error || toolResponse.is_error || toolResponse.isError),
  );
}

/**
 * @param {unknown} raw распарсенный JSON события хука
 * @param {Record<string, string|string[]|undefined>} [headers] заголовки запроса от report.sh
 * @returns {FleetEvent}
 */
export function normalizeHookEvent(raw, headers = {}) {
  const event = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pid = Number(headers['x-fleet-pid']);
  return {
    agent: headers['x-fleet-agent'] === AGENT.CODEX ? AGENT.CODEX : AGENT.CLAUDE,
    sessionId: text(event.session_id),
    kind: text(event.hook_event_name),
    cwd: text(event.cwd) ?? '',
    appId: text(headers['x-fleet-app']) || null,
    pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
    prompt: text(event.prompt ?? event.user_prompt),
    tool: text(event.tool_name),
    toolInput: event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : null,
    notification: text(event.notification_type) ?? '',
    message: text(event.message ?? event.error),
    isError: isToolError(event.tool_response),
  };
}
