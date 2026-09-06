import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookEvent } from '../src/fleet/hook-event.js';
import { AGENT } from '../public/js/lib/domain.js';

/*
 * Единственное место, где известна схема хуков Claude Code и Codex плюс заголовки report.sh.
 * Образцы взяты с живых событий.
 */

test('событие Claude: поля хука и заголовки репортёра собираются в одно нормализованное', () => {
  const event = normalizeHookEvent({
    session_id: 'abc-123',
    hook_event_name: 'PostToolUse',
    cwd: '/Users/x/Projects/claude-fleet',
    tool_name: 'Bash',
    tool_input: { command: 'node --test' },
    tool_response: { stdout: 'ok' },
  }, { 'x-fleet-app': 'com.jetbrains.WebStorm', 'x-fleet-pid': '4242' });
  assert.deepEqual(event, {
    agent: AGENT.CLAUDE,
    sessionId: 'abc-123',
    kind: 'PostToolUse',
    cwd: '/Users/x/Projects/claude-fleet',
    appId: 'com.jetbrains.WebStorm',
    pid: 4242,
    prompt: null,
    tool: 'Bash',
    toolInput: { command: 'node --test' },
    notification: '',
    message: null,
    isError: false,
  });
});

test('событие Codex: агент из заголовка, промпт из user_prompt, id остаётся исходным', () => {
  const event = normalizeHookEvent({
    session_id: 'c-1',
    hook_event_name: 'UserPromptSubmit',
    cwd: '/tmp/p',
    user_prompt: 'почини тест',
  }, { 'x-fleet-agent': 'codex' });
  assert.equal(event.agent, AGENT.CODEX);
  assert.equal(event.sessionId, 'c-1');
  assert.equal(event.prompt, 'почини тест');
});

test('ошибка инструмента читается из tool_response, StopFailure берёт текст из error', () => {
  const failed = normalizeHookEvent({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { is_error: true } });
  assert.equal(failed.isError, true);
  const stop = normalizeHookEvent({ session_id: 's', hook_event_name: 'StopFailure', error: 'API 529' });
  assert.equal(stop.message, 'API 529');
  const notice = normalizeHookEvent({ session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(notice.notification, 'permission_prompt');
  assert.equal(notice.message, 'Claude needs your permission');
});

test('мусор в заголовках и теле не становится полями: PID 1, чужой агент, не-строки', () => {
  const event = normalizeHookEvent({
    session_id: 42,
    hook_event_name: ['Stop'],
    cwd: null,
    tool_name: { name: 'Bash' },
    tool_input: 'ls',
    prompt: 7,
  }, { 'x-fleet-pid': '1', 'x-fleet-agent': 'gemini', 'x-fleet-app': '' });
  assert.equal(event.sessionId, null);
  assert.equal(event.kind, null);
  assert.equal(event.cwd, '');
  assert.equal(event.pid, null);
  assert.equal(event.agent, AGENT.CLAUDE);
  assert.equal(event.appId, null);
  assert.equal(event.tool, null);
  assert.equal(event.toolInput, null);
  assert.equal(event.prompt, null);
});

test('не объект вместо события даёт пустое нормализованное, а не исключение', () => {
  assert.equal(normalizeHookEvent(null).sessionId, null);
  assert.equal(normalizeHookEvent('строка').kind, null);
  assert.equal(normalizeHookEvent([]).agent, AGENT.CLAUDE);
});
