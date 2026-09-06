import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_STATUSES,
  AGENT,
  SECTION,
  STATUS,
  WAIT_REASON,
  agentOf,
  isAskingPermission,
  isAttention,
  sectionOf,
} from '../public/js/lib/domain.js';

test('в «ждут тебя» попадают только разрешение, вопрос и сбой', () => {
  assert.equal(sectionOf({ status: STATUS.WAITING, reason: WAIT_REASON.PERMISSION }), SECTION.ATTN);
  assert.equal(sectionOf({ status: STATUS.WAITING, reason: WAIT_REASON.QUESTION }), SECTION.ATTN);
  assert.equal(sectionOf({ status: STATUS.WAITING, reason: WAIT_REASON.FAILED }), SECTION.ATTN);
  // причина не распознана - лучше показать красным, чем спрятать
  assert.equal(sectionOf({ status: STATUS.WAITING }), SECTION.ATTN);
});

test('закончивший ход стоит в своей секции, а не в красной', () => {
  assert.equal(sectionOf({ status: STATUS.WAITING, reason: WAIT_REASON.FINISHED }), SECTION.DONE);
  assert.equal(isAttention({ status: STATUS.WAITING, reason: WAIT_REASON.FINISHED }), false);
  assert.equal(isAttention({ status: STATUS.WAITING, reason: WAIT_REASON.QUESTION }), true);
});

test('всё, что не ждёт, это строка в работе', () => {
  for (const status of Object.values(STATUS)) {
    if (status === STATUS.WAITING) continue;
    assert.equal(sectionOf({ status, reason: WAIT_REASON.FINISHED }), SECTION.BUSY);
  }
  assert.equal(sectionOf(undefined), SECTION.BUSY);
});

test('активные статусы это все, кроме готовности и ожидания', () => {
  const expected = Object.values(STATUS).filter((s) => s !== STATUS.READY && s !== STATUS.WAITING);
  assert.deepEqual([...ACTIVE_STATUSES].sort(), expected.sort());
});

test('агент по умолчанию Claude, Codex только по явной метке', () => {
  assert.equal(agentOf({ agent: AGENT.CODEX }), AGENT.CODEX);
  assert.equal(agentOf({ agent: AGENT.CLAUDE }), AGENT.CLAUDE);
  assert.equal(agentOf({}), AGENT.CLAUDE);
  assert.equal(agentOf(undefined), AGENT.CLAUDE);
  assert.equal(agentOf({ agent: 'gemini' }), AGENT.CLAUDE);
});

test('открытый запрос разрешения это ожидание именно с причиной permission', () => {
  assert.equal(isAskingPermission({ status: STATUS.WAITING, reason: WAIT_REASON.PERMISSION }), true);
  assert.equal(isAskingPermission({ status: STATUS.WAITING, reason: WAIT_REASON.QUESTION }), false);
  assert.equal(isAskingPermission({ status: STATUS.TOOL, reason: WAIT_REASON.PERMISSION }), false);
  assert.equal(isAskingPermission(undefined), false);
});
