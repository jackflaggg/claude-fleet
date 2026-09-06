import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LABEL, AGENT_ORDER, STATUS_META, WAIT_BADGE } from '../public/js/board-config.js';
import { AGENT, STATUS, WAIT_REASON } from '../public/js/lib/domain.js';

test('у каждой причины ожидания есть подпись бейджа', () => {
  for (const reason of Object.values(WAIT_REASON)) {
    assert.ok(WAIT_BADGE[reason], `нет подписи для ${reason}`);
  }
  assert.deepEqual(Object.keys(WAIT_BADGE).sort(), Object.values(WAIT_REASON).sort());
});

test('у каждого статуса кроме ожидания есть класс и подпись бейджа', () => {
  for (const status of Object.values(STATUS)) {
    if (status === STATUS.WAITING) continue;
    assert.ok(STATUS_META[status]?.cls && STATUS_META[status]?.label, `нет меты для ${status}`);
  }
  assert.equal(STATUS_META[STATUS.WAITING], undefined, 'ожидание подписывает WAIT_BADGE');
});

test('у каждого агента есть подпись и место в порядке строк', () => {
  for (const agent of Object.values(AGENT)) {
    assert.ok(AGENT_LABEL[agent], `нет подписи для ${agent}`);
    assert.ok(AGENT_ORDER.includes(agent), `нет в порядке: ${agent}`);
  }
});
