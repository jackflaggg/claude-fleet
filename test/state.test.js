import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRawEvent, pruneStale, isHandledEvent, shiftActivity, ACTIVITY_BARS } from '../src/fleet/state.js';
import { STATUS, WAIT_REASON } from '../public/js/lib/domain.js';

const NOW = 1_700_000_000_000;

function ev(overrides) {
  return { session_id: 's1', cwd: '/Users/x/Projects/school-back', ...overrides };
}

/**
 * Короткая запись тестов: agent, appId и processPid лежат в событии рядом с полями хука.
 * В жизни они приходят заголовками report.sh, поэтому здесь переезжают в заголовки.
 */
function applyEvent(sessions, raw, now) {
  const { agent, appId, processPid, ...event } = raw;
  const headers = {};
  if (agent) headers['x-fleet-agent'] = agent;
  if (appId) headers['x-fleet-app'] = appId;
  if (processPid != null) headers['x-fleet-pid'] = String(processPid);
  return applyRawEvent(sessions, event, now, headers);
}

test('SessionStart создаёт карточку с проектом из cwd', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'SessionStart', source: 'startup' }), NOW);
  assert.equal(state.s1.project, 'school-back');
  assert.equal(state.s1.status, STATUS.READY);
  assert.equal(state.s1.updatedAt, NOW);
  assert.equal(state.s1.agent, 'claude');
});

test('Codex использует отдельное пространство id и общую модель карточки', () => {
  const state = applyEvent({}, ev({
    agent: 'codex',
    hook_event_name: 'SessionStart',
    processPid: 12345,
  }), NOW);
  assert.ok(state['codex:s1']);
  assert.equal(state['codex:s1'].sourceSessionId, 's1');
  assert.equal(state['codex:s1'].agent, 'codex');
  assert.equal(state['codex:s1'].processPid, 12345);
  assert.equal(state.s1, undefined, 'Claude-сессия с таким id останется отдельной');
});

test('PermissionRequest Codex показывает ожидание разрешения и инструмент', () => {
  const state = applyEvent({}, ev({
    agent: 'codex',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm publish', description: 'Нужен доступ к сети' },
  }), NOW);
  const card = state['codex:s1'];
  assert.equal(card.status, STATUS.WAITING);
  assert.equal(card.reason, WAIT_REASON.PERMISSION);
  assert.equal(card.tool, 'Bash');
  assert.equal(card.toolInfo, 'npm publish');
  assert.equal(card.note, 'Нужен доступ к сети');
});

test('SessionEnd Codex удаляет только Codex-карточку с совпадающим source id', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  state = applyEvent(state, ev({ agent: 'codex', hook_event_name: 'SessionStart' }), NOW);
  state = applyEvent(state, ev({ agent: 'codex', hook_event_name: 'SessionEnd' }), NOW + 1);
  assert.ok(state.s1);
  assert.equal(state['codex:s1'], undefined);
});

test('сессия в git-worktree остаётся в группе родительского проекта', () => {
  const state = applyEvent({}, ev({
    hook_event_name: 'SessionStart',
    cwd: '/Users/x/Projects/LearningMy/.claude/worktrees/fix+agent-harness',
  }), NOW);
  assert.equal(state.s1.project, 'LearningMy', 'иначе на борде заводится проект-однодневка');
  assert.equal(state.s1.worktree, 'fix+agent-harness', 'но имя копии видно - работ в проекте две');
});

test('обычная сессия worktree не получает', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  assert.equal(state.s1.worktree, null);
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

test('промпт от другой сессии и с борда показывается без XML-обёртки', () => {
  const peer = '<cross-session-message from="uds:/tmp/cc-socks/5377.sock" from-name="learningmy-d4" from-mode="prompting">\nЗакоммить handoff и обновить доку\n</cross-session-message>';
  assert.equal(applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: peer }), NOW).s1.title, 'Закоммить handoff и обновить доку');
  const channel = '<channel source="fleet" origin="board">продолжай, тесты зелёные</channel>';
  assert.equal(applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: channel }), NOW).s1.title, 'продолжай, тесты зелёные');
  const base = applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'живая задача' }), NOW);
  const emptyWrap = applyEvent(base, ev({ hook_event_name: 'UserPromptSubmit', prompt: '<channel source="fleet"></channel>' }), NOW + 1);
  assert.equal(emptyWrap.s1.title, 'живая задача', 'пустая обёртка не затирает задачу');
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

test('PID процесса запоминается для любого агента, не только Codex', () => {
  const state = applyEvent({}, ev({ hook_event_name: 'SessionStart', processPid: 4242 }), NOW);
  assert.equal(state.s1.agent, 'claude');
  assert.equal(state.s1.processPid, 4242);
  assert.equal(applyEvent(state, ev({ hook_event_name: 'Stop', processPid: 1 }), NOW).s1.processPid, 4242, 'PID 1 и мусор не затирают прежний');
});

// --- искра активности ---------------------------------------------------------------
// Десять столбиков, по одному на минуту. Буфер ограничен по построению: сколько бы событий
// ни пришло, на карточке живут ровно ACTIVITY_BARS чисел.

test('события считаются по минутам, буфер не растёт', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  assert.equal(state.s1.activity.length, ACTIVITY_BARS);
  assert.equal(state.s1.activity.at(-1), 1);
  for (let i = 0; i < 5000; i += 1) {
    state = applyEvent(state, ev({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), NOW + i);
  }
  assert.equal(state.s1.activity.length, ACTIVITY_BARS, 'шторм событий не раздувает буфер');
  assert.equal(state.s1.activity.at(-1), 5001, 'все события той же минуты в последнем столбике');
});

test('пауза сдвигает столбики влево, долгая пауза обнуляет их', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'SessionStart' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'Stop' }), NOW + 3 * 60_000);
  assert.deepEqual(state.s1.activity.slice(-4), [1, 0, 0, 1]);
  state = applyEvent(state, ev({ hook_event_name: 'Stop' }), NOW + 60 * 60_000);
  assert.deepEqual(state.s1.activity, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 'через час старая активность не видна');
});

test('shiftActivity терпит карточку без буфера и мусор в нём', () => {
  assert.deepEqual(shiftActivity(undefined, undefined, 10), new Array(ACTIVITY_BARS).fill(0));
  assert.deepEqual(shiftActivity([1, 'x', null, 2, 3, 4, 5, 6, 7, 8], 5, 6), [0, 0, 2, 3, 4, 5, 6, 7, 8, 0]);
  assert.deepEqual(shiftActivity([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 4), new Array(ACTIVITY_BARS).fill(0), 'часы назад не ходят');
});

test('toolTarget знает текущие имена инструментов Claude Code', () => {
  const at = (tool_name, tool_input) =>
    applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name, tool_input }), NOW).s1.toolInfo;
  assert.equal(at('Agent', { description: 'разведка', subagent_type: 'Explore' }), 'разведка');
  assert.equal(at('Task', { description: 'старое имя' }), 'старое имя');
  assert.equal(at('AskUserQuestion', { questions: [{ question: 'Какой порт?' }] }), 'Какой порт?');
  assert.equal(at('Skill', { skill: 'bugfix', args: 'x' }), 'bugfix');
  assert.equal(at('ToolSearch', { query: 'select:Monitor' }), 'select:Monitor');
});

test('SubagentStop не помечает работающую сессию как "закончил ход"', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'разведка' } }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'SubagentStop' }), NOW + 1000);
  assert.equal(state.s1.status, STATUS.TOOL, 'сессия продолжает работать, субагент закончился не она');
  assert.notEqual(state.s1.reason, WAIT_REASON.FINISHED);
  assert.equal(state.s1.updatedAt, NOW + 1000, 'но признак жизни обновлён');
});

// --- время ожидания -----------------------------------------------------------------
// updatedAt двигает любое входящее событие, поэтому "сколько уже ждёт" считается от
// отдельной метки. Иначе счётчик обнуляется прямо во время ожидания, и карточка проваливается
// вниз секции "ждут тебя", отсортированной "дольше всех ждущий сверху".

test('waitingSince ставится в момент входа в ожидание', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), NOW);
  assert.equal(state.s1.waitingSince, null, 'работающая сессия ничего не ждёт');
  state = applyEvent(state, ev({ hook_event_name: 'Stop' }), NOW + 5000);
  assert.equal(state.s1.waitingSince, NOW + 5000);
});

test('повторный idle-Notification не обнуляет счётчик ожидания', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'Stop' }), NOW);
  assert.equal(state.s1.waitingSince, NOW);
  // Claude Code напоминает о простое, пока ты не ответил
  state = applyEvent(state, ev({
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
  }), NOW + 60_000);
  assert.equal(state.s1.waitingSince, NOW, 'ждёт по-прежнему с NOW, а не с последнего напоминания');
  assert.equal(state.s1.updatedAt, NOW + 60_000, 'а признак жизни обновился');
});

test('idle-Notification не подменяет причину у уже ждущей карточки', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'Stop' }), NOW);
  assert.equal(state.s1.reason, WAIT_REASON.FINISHED);
  state = applyEvent(state, ev({
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
  }), NOW + 60_000);
  assert.equal(state.s1.reason, WAIT_REASON.FINISHED, 'сессия закончила ход, а не задала вопрос');
});

test('SubagentStop не обнуляет счётчик ожидания', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'Stop' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'SubagentStop' }), NOW + 3000);
  assert.equal(state.s1.waitingSince, NOW);
});

test('waitingSince сбрасывается, когда сессия снова пошла работать', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'Stop' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'дальше' }), NOW + 1000);
  assert.equal(state.s1.waitingSince, null);
  state = applyEvent(state, ev({ hook_event_name: 'Stop' }), NOW + 2000);
  assert.equal(state.s1.waitingSince, NOW + 2000, 'новое ожидание считается заново');
});

// --- разбор уведомлений ---------------------------------------------------------------

test('причина ожидания берётся из notification_type, а не из текста', () => {
  // текст намеренно не содержит слова permission - раньше это давало бы "нужен ответ"
  const state = applyEvent({}, ev({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Разрешить запуск команды?',
  }), NOW);
  assert.equal(state.s1.reason, WAIT_REASON.PERMISSION);
});

test('без notification_type причина по-прежнему определяется по тексту', () => {
  const perm = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), NOW);
  assert.equal(perm.s1.reason, WAIT_REASON.PERMISSION);
  const question = applyEvent({}, ev({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }), NOW);
  assert.equal(question.s1.reason, WAIT_REASON.QUESTION);
});

test('завершение фонового агента не зовёт человека к сессии', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), NOW);
  state = applyEvent(state, ev({
    hook_event_name: 'Notification',
    notification_type: 'agent_completed',
    message: 'Определение текущего этапа проекта failed',
  }), NOW + 1000);
  assert.equal(state.s1.status, STATUS.TOOL, 'закончился агент, а сессия работает дальше');
  assert.equal(state.s1.waitingSince, null);
  // у фонового агента свой session_id: уведомление приходит в пустую карточку-однодневку,
  // и она не должна становиться красной только потому, что агент завершился
  const lone = applyEvent({}, ev({
    hook_event_name: 'Notification',
    notification_type: 'agent_completed',
    message: 'Определение текущего этапа проекта failed',
  }), NOW);
  assert.notEqual(lone.s1.status, STATUS.WAITING, 'карточка агента никого не ждёт');
});

test('информационное уведомление не красит карточку в "ждут тебя"', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'Notification', notification_type: 'auth_success', message: 'Login successful' }), NOW + 1);
  assert.equal(state.s1.status, STATUS.TOOL, 'успешный логин ничего от тебя не хочет');
  assert.equal(state.s1.waitingSince, null);
});

// --- слепые зоны: сессия занята или мертва, но событий инструментов нет -----------------

test('StopFailure поднимает сессию в "ждут тебя" с причиной "сбой"', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'собери проект' }), NOW);
  assert.equal(state.s1.status, STATUS.THINKING);
  state = applyEvent(state, ev({ hook_event_name: 'StopFailure', message: 'API error: overloaded' }), NOW + 2000);
  assert.equal(state.s1.status, STATUS.WAITING, 'иначе мёртвая сессия выглядит как думающая');
  assert.equal(state.s1.reason, WAIT_REASON.FAILED);
  assert.equal(state.s1.note, 'API error: overloaded');
  assert.equal(state.s1.waitingSince, NOW + 2000);
});

test('PreCompact показывает, что сессия занята сжатием, а не подвисла', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b/c.ts' }, tool_response: {} }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'PreCompact', trigger: 'auto' }), NOW + 1000);
  assert.equal(state.s1.status, STATUS.COMPACTING);
  assert.equal(state.s1.tool, null, 'старый тул убран - он больше не отражает происходящее');
});

test('PostCompact возвращает сессию в работу', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreCompact', trigger: 'auto' }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'PostCompact' }), NOW + 1000);
  assert.equal(state.s1.status, STATUS.THINKING);
});

test('PostToolUseFailure помечает карточку ошибкой и сохраняет тул', () => {
  const state = applyEvent({}, ev({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  }), NOW);
  assert.equal(state.s1.status, STATUS.ERROR);
  assert.equal(state.s1.tool, 'Bash');
  assert.equal(state.s1.toolInfo, 'npm test');
});

test('новые события считаются знакомыми (не попадут в счётчик незнакомых)', () => {
  for (const name of ['StopFailure', 'PreCompact', 'PostCompact', 'PostToolUseFailure']) {
    assert.equal(isHandledEvent(name), true, `${name} должен быть в HANDLED_EVENTS`);
  }
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

test('isHandledEvent знает все события, которые обрабатывает applyEvent', () => {
  for (const name of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd']) {
    assert.ok(isHandledEvent(name), `${name} должен считаться известным`);
  }
});

test('незнакомое событие видно как незнакомое (сигнал, что схема хуков разъехалась)', () => {
  // существующее в Claude Code, но намеренно не подключённое событие: борд его не понимает
  assert.equal(isHandledEvent('WorktreeCreate'), false);
  assert.equal(isHandledEvent(undefined), false);
});

test('незнакомое событие не портит карточку, только освежает updatedAt', () => {
  let state = applyEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), NOW);
  state = applyEvent(state, ev({ hook_event_name: 'ЧтоТоНовое' }), NOW + 500);
  assert.equal(state.s1.status, STATUS.TOOL);
  assert.equal(state.s1.tool, 'Bash');
  assert.equal(state.s1.updatedAt, NOW + 500);
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

// Пустая карточка - это фоновый агент со своим session_id, остаток от перехода в worktree
// или брошенная сессия: сказать ей нечего, а место на борде она занимает наравне с работой.
test('pruneStale: пустая карточка убирается по короткому порогу', () => {
  const MINUTE = 60 * 1000;
  const sessions = {
    blank: { sessionId: 'blank', updatedAt: NOW - 30 * MINUTE },
    titled: { sessionId: 'titled', title: 'починить сборку', updatedAt: NOW - 30 * MINUTE },
    busy: { sessionId: 'busy', tool: 'Bash', updatedAt: NOW - 30 * MINUTE },
  };
  const pruned = pruneStale(sessions, NOW, 6 * HOUR, 15 * MINUTE);
  assert.equal(pruned.blank, undefined, 'ни задачи, ни инструмента - показывать нечего');
  assert.ok(pruned.titled, 'сессия с задачей живёт по общему порогу');
  assert.ok(pruned.busy, 'сессия за инструментом тоже');
});

test('pruneStale: без короткого порога поведение прежнее', () => {
  const sessions = { blank: { sessionId: 'blank', updatedAt: NOW - 30 * 60 * 1000 } };
  assert.ok(pruneStale(sessions, NOW, 6 * HOUR).blank, 'четвёртый аргумент необязателен');
});
