import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutKey, rowOrder, splitSections, waitOrder } from '../public/js/ui/order.js';
import { AGENT, STATUS, WAIT_REASON } from '../public/js/lib/domain.js';

const T0 = Date.UTC(2026, 8, 6, 12, 0, 0);

test('строки идут проект → агент → старшая сессия выше, хвост по id', () => {
  const rows = [
    { sessionId: 'd', project: 'beta', agent: AGENT.CLAUDE, createdAt: T0 },
    { sessionId: 'c', project: 'alpha', agent: AGENT.CODEX, createdAt: T0 - 60_000 },
    { sessionId: 'b', project: 'alpha', agent: AGENT.CLAUDE, createdAt: T0 },
    { sessionId: 'a', project: 'alpha', agent: AGENT.CLAUDE, createdAt: T0 - 60_000 },
    { sessionId: 'f', project: 'alpha', agent: AGENT.CLAUDE, createdAt: T0 },
  ];
  const ids = [...rows].sort(rowOrder).map((c) => c.sessionId);
  assert.deepEqual(ids, ['a', 'b', 'f', 'c', 'd']);
});

test('карточка без проекта и без агента сортируется как Claude в пустом проекте', () => {
  const rows = [
    { sessionId: 'x', project: 'alpha', agent: AGENT.CLAUDE, createdAt: T0 },
    { sessionId: 'y', createdAt: T0 },
  ];
  assert.deepEqual([...rows].sort(rowOrder).map((c) => c.sessionId), ['y', 'x']);
});

test('дольше всех ждущий сверху, без waitingSince берётся updatedAt', () => {
  const cards = [
    { sessionId: 'new', waitingSince: T0 - 10_000, updatedAt: T0 },
    { sessionId: 'old', waitingSince: T0 - 600_000, updatedAt: T0 },
    { sessionId: 'legacy', updatedAt: T0 - 300_000 },
  ];
  assert.deepEqual([...cards].sort(waitOrder).map((c) => c.sessionId), ['old', 'legacy', 'new']);
});

test('ключ раскладки меняется только вместе с составом секций', () => {
  const key = layoutKey({ waiting: 1, done: 0, busy: 3, total: 4 });
  assert.equal(key, layoutKey({ waiting: 2, done: 0, busy: 7, total: 9 }), 'число внутри секции ключ не двигает');
  assert.notEqual(key, layoutKey({ waiting: 0, done: 0, busy: 3, total: 3 }), 'красная секция сменилась плашкой «никто не ждёт»');
  assert.notEqual(layoutKey({ waiting: 0, done: 0, busy: 3, total: 3 }), layoutKey({ waiting: 0, done: 0, busy: 0, total: 0 }), 'пустой борд без плашки');
  assert.notEqual(key, layoutKey({ waiting: 1, done: 1, busy: 3, total: 5 }));
});

test('снимок раскладывается по трём секциям уже отсортированным', () => {
  const list = [
    { sessionId: 'w2', status: STATUS.WAITING, reason: WAIT_REASON.QUESTION, waitingSince: T0 - 5_000 },
    { sessionId: 'b1', status: STATUS.WORKING, project: 'zeta', agent: AGENT.CLAUDE, createdAt: T0 },
    { sessionId: 'd1', status: STATUS.WAITING, reason: WAIT_REASON.FINISHED, waitingSince: T0 - 1_000 },
    { sessionId: 'w1', status: STATUS.WAITING, reason: WAIT_REASON.PERMISSION, waitingSince: T0 - 50_000 },
    { sessionId: 'b0', status: STATUS.READY, project: 'alpha', agent: AGENT.CLAUDE, createdAt: T0 },
  ];
  const { waiting, done, busy } = splitSections(list);
  assert.deepEqual(waiting.map((c) => c.sessionId), ['w1', 'w2']);
  assert.deepEqual(done.map((c) => c.sessionId), ['d1']);
  assert.deepEqual(busy.map((c) => c.sessionId), ['b0', 'b1']);
  assert.deepEqual(splitSections(undefined), { waiting: [], done: [], busy: [] });
});
