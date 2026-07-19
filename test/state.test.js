import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, pruneStale, STATUS, WAIT_REASON } from '../state.js';

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

test('UserPromptSubmit со служебной инъекцией не затирает реальную задачу', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'почини фронт редактор' }), NOW);
  assert.equal(state.s1.title, 'почини фронт редактор');
  // прилетело уведомление о завершении фоновой задачи - в title не пишем
  state = applyEvent(state, ev({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification> <status>completed</status> служебка' }), NOW + 1);
  assert.equal(state.s1.title, 'почини фронт редактор');
  assert.equal(state.s1.status, STATUS.THINKING);
});

test('служебные теги в промпте распознаются (system-reminder, слэш-команда, bash)', () => {
  const base = applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'живая задача' }), NOW);
  for (const junk of ['<system-reminder>напоминание', '  <command-name>/foo', '<bash-stdout>вывод']) {
    const next = applyEvent(base, ev({ hook_event_name: 'UserPromptSubmit', prompt: junk }), NOW + 1);
    assert.equal(next.s1.title, 'живая задача', `не должно затираться: ${junk}`);
  }
});

test('промпт, где служебный тег не в начале, считается обычным', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'посмотри на <system-reminder> в коде' }), NOW);
  assert.equal(state.s1.title, 'посмотри на <system-reminder> в коде');
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

test('Notification кладёт текст уведомления в note (видно, чего именно хотят)', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), NOW);
  assert.equal(state.s1.note, 'Claude needs your permission to use Bash');
});

test('note сбрасывается, когда сессия снова пошла работать', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), NOW);
  assert.ok(state.s1.note);
  state = applyEvent(state, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), NOW + 1);
  assert.equal(state.s1.note, null, 'разрешение выдано - текст уведомления больше не актуален');
});

test('Stop не оставляет note от прошлого уведомления', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'нужно разрешение' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'Stop' }), NOW + 1);
  assert.equal(state.s1.note, null);
});

test('слишком длинный текст уведомления обрезается', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'я'.repeat(400) }), NOW);
  assert.ok(state.s1.note.length <= 120, `note длиной ${state.s1.note.length} не влезает в карточку`);
});

test('SubagentStop не помечает работающую сессию как "закончил ход"', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'разведка' } }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'SubagentStop' }), NOW + 1000);
  assert.equal(state.s1.status, STATUS.TOOL, 'сессия продолжает работать, субагент закончился не она');
  assert.notEqual(state.s1.reason, WAIT_REASON.FINISHED);
  assert.equal(state.s1.updatedAt, NOW + 1000, 'но признак жизни обновлён');
});

test('terminal - человекочитаемое имя из appId (WebStorm / Alacritty / фолбэк)', () => {
  const ws = applyEvent({}, ev({ hook_event_name: 'SessionStart', appId: 'com.jetbrains.WebStorm' }), NOW);
  assert.equal(ws.s1.terminal, 'WebStorm');
  const al = applyEvent({}, ev({ hook_event_name: 'SessionStart', appId: 'org.alacritty' }), NOW);
  assert.equal(al.s1.terminal, 'Alacritty');
  const unknown = applyEvent({}, ev({ hook_event_name: 'SessionStart', appId: 'com.foo.BarTerm' }), NOW);
  assert.equal(unknown.s1.terminal, 'BarTerm');
});

test('createdAt ставится при создании карточки и не обновляется дальше', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  assert.equal(state.s1.createdAt, NOW);
  state = applyEvent(state, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), NOW + 5000);
  assert.equal(state.s1.createdAt, NOW, 'момент старта неизменен');
  assert.equal(state.s1.updatedAt, NOW + 5000, 'а updatedAt идёт за последним событием');
});

test('карточка без createdAt (поднятая с диска старого формата) получает его на событии', () => {
  const restored = { s1: { sessionId: 's1', status: STATUS.WORKING, updatedAt: NOW - 1000 } };
  const state = applyEvent(restored, ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: {} }), NOW);
  assert.equal(state.s1.createdAt, NOW, 'проставлен на ближайшем событии, а не остался undefined');
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

const HOUR = 60 * 60 * 1000;

test('pruneStale убирает протухшие карточки и оставляет свежие', () => {
  const sessions = {
    live: { sessionId: 'live', updatedAt: NOW - 1 * HOUR },
    zombie: { sessionId: 'zombie', updatedAt: NOW - 10 * HOUR },
  };
  const pruned = pruneStale(sessions, NOW, 6 * HOUR);
  assert.ok(pruned.live, 'свежая остаётся');
  assert.equal(pruned.zombie, undefined, 'протухшая удаляется');
});

test('pruneStale не мутирует вход и возвращает новый объект', () => {
  const sessions = { z: { sessionId: 'z', updatedAt: NOW - 10 * HOUR } };
  const pruned = pruneStale(sessions, NOW, 6 * HOUR);
  assert.notEqual(pruned, sessions);
  assert.ok(sessions.z, 'исходный объект нетронут');
  assert.equal(Object.keys(pruned).length, 0);
});

test('pruneStale: карточка ровно на пороге считается протухшей', () => {
  const sessions = { edge: { sessionId: 'edge', updatedAt: NOW - 6 * HOUR } };
  const pruned = pruneStale(sessions, NOW, 6 * HOUR);
  assert.equal(pruned.edge, undefined);
});

test('pruneStale: карточка без updatedAt считается протухшей', () => {
  const sessions = { nold: { sessionId: 'nold' } };
  const pruned = pruneStale(sessions, NOW, 6 * HOUR);
  assert.equal(pruned.nold, undefined);
});
