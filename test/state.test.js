import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, STATUS, WAIT_REASON } from '../state.js';

const NOW = 1_700_000_000_000;

function ev(overrides) {
  return { session_id: 's1', cwd: '/Users/x/Projects/school-back', ...overrides };
}

test('SessionStart создаёт карточку с проектом из cwd', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'SessionStart', source: 'startup' }), NOW);
  assert.equal(state.s1.project, 'school-back');
  assert.equal(state.s1.status, STATUS.READY);
  assert.equal(state.s1.updatedAt, NOW);
});

test('UserPromptSubmit переводит в thinking и кладёт промпт в заголовок', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'UserPromptSubmit', prompt: '  почини баг с формулами  ' }), NOW + 1);
  assert.equal(state.s1.status, STATUS.THINKING);
  assert.equal(state.s1.title, 'почини баг с формулами');
  assert.equal(state.s1.tool, null);
});

test('PreToolUse показывает статус tool, имя тула и что делает', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }), NOW);
  assert.equal(state.s1.status, STATUS.TOOL);
  assert.equal(state.s1.tool, 'Bash');
  assert.equal(state.s1.toolInfo, 'npm test');
});

test('toolInfo для файловых тулов - короткий путь (2 сегмента)', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/Users/x/Projects/school-back/src/app.service.ts' } }), NOW);
  assert.equal(state.s1.tool, 'Edit');
  assert.equal(state.s1.toolInfo, 'src/app.service.ts');
});

test('UserPromptSubmit сбрасывает tool/toolInfo прошлого хода', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'новая задача' }), NOW + 1);
  assert.equal(state.s1.tool, null);
  assert.equal(state.s1.toolInfo, null);
  assert.equal(state.s1.title, 'новая задача');
});

test('PostToolUse без ошибки - working, с ошибкой - error', () => {
  const ok = applyEvent({}, ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { ok: true } }), NOW);
  assert.equal(ok.s1.status, STATUS.WORKING);

  const bad = applyEvent({}, ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { error: 'boom' } }), NOW);
  assert.equal(bad.s1.status, STATUS.ERROR);
});

test('Notification про разрешение - waiting/permission', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), NOW);
  assert.equal(state.s1.status, STATUS.WAITING);
  assert.equal(state.s1.reason, WAIT_REASON.PERMISSION);
});

test('Notification-вопрос (не про разрешение) - waiting/question', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }), NOW);
  assert.equal(state.s1.status, STATUS.WAITING);
  assert.equal(state.s1.reason, WAIT_REASON.QUESTION);
});

test('Stop - waiting/finished (закончил ход, нужен следующий шаг)', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'Stop' }), NOW);
  assert.equal(state.s1.status, STATUS.WAITING);
  assert.equal(state.s1.reason, WAIT_REASON.FINISHED);
});

test('appId (где живёт сессия) сохраняется и переживает следующие события', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart', appId: 'org.alacritty' }), NOW);
  assert.equal(state.s1.appId, 'org.alacritty');
  state = applyEvent(state, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), NOW + 1);
  assert.equal(state.s1.appId, 'org.alacritty');
});

test('SessionEnd удаляет карточку', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'SessionEnd', reason: 'clear' }), NOW + 1);
  assert.equal(state.s1, undefined);
});

test('малформленное событие без session_id игнорируется', () => {
  const state = applyEvent({}, { hook_event_name: 'Stop' }, NOW);
  assert.deepEqual(state, {});
});

test('событие без cwd даёт project=unknown', () => {
  const state = applyEvent({}, { session_id: 's9', hook_event_name: 'SessionStart' }, NOW);
  assert.equal(state.s9.project, 'unknown');
});

test('несколько сессий живут независимо', () => {
  let state = applyEvent({}, { session_id: 'a', cwd: '/p/alpha', hook_event_name: 'PreToolUse', tool_name: 'Grep' }, NOW);
  state = applyEvent(state, { session_id: 'b', cwd: '/p/beta', hook_event_name: 'Stop' }, NOW);
  assert.equal(state.a.status, STATUS.TOOL);
  assert.equal(state.a.project, 'alpha');
  assert.equal(state.b.status, STATUS.WAITING);
  assert.equal(state.b.project, 'beta');
});

test('иммутабельность: исходный объект не мутируется', () => {
  const original = {};
  const result = applyEvent(original, ev({ hook_event_name: 'SessionStart' }), NOW);
  assert.deepEqual(original, {});
  assert.notEqual(result, original);
});
