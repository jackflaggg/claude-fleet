import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionOf } from '../public/js/board-config.js';

test('в «ждут тебя» попадают только разрешение, вопрос и сбой', () => {
  assert.equal(sectionOf({ status: 'waiting', reason: 'permission' }), 'attn');
  assert.equal(sectionOf({ status: 'waiting', reason: 'question' }), 'attn');
  assert.equal(sectionOf({ status: 'waiting', reason: 'failed' }), 'attn');
  // причина не распознана - лучше показать красным, чем спрятать
  assert.equal(sectionOf({ status: 'waiting' }), 'attn');
});

test('закончивший ход стоит в своей секции, а не в красной', () => {
  assert.equal(sectionOf({ status: 'waiting', reason: 'finished' }), 'done');
});

test('всё, что не ждёт, это строка в работе', () => {
  for (const status of ['ready', 'thinking', 'tool', 'working', 'error', 'compacting']) {
    assert.equal(sectionOf({ status, reason: 'finished' }), 'busy');
  }
  assert.equal(sectionOf(undefined), 'busy');
});
