import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProcessAlive, pruneClosedSessions } from '../src/fleet/liveness.js';

test('PID probe использует signal 0 и только ESRCH считает смертью', () => {
  let called = null;
  assert.equal(isProcessAlive(123, (pid, signal) => { called = [pid, signal]; }), true);
  assert.deepEqual(called, [123, 0]);
  assert.equal(isProcessAlive(123, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(isProcessAlive(123, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), true);
});

test('живая сессия остаётся, закрытая удаляется только после двух проверок', () => {
  const sessions = {
    live: { agent: 'codex', processPid: 100 },
    closed: { agent: 'codex', processPid: 200 },
    claudeClosed: { agent: 'claude', processPid: 300 },
    claudeNoPid: { agent: 'claude' },
  };

  const first = pruneClosedSessions(sessions, new Set([100]), new Map(), 1000, 10_000);
  assert.equal(first.sessions, sessions, 'первая проверка ничего не удаляет');
  assert.equal(first.missingSince.get('closed'), 1000);
  assert.equal(first.missingSince.get('claudeClosed'), 1000, 'Claude проверяется тем же механизмом');

  const second = pruneClosedSessions(sessions, new Set([100]), first.missingSince, 11_000, 10_000);
  assert.ok(second.sessions.live);
  assert.ok(second.sessions.claudeNoPid, 'карточка без PID (старый персист) не трогается');
  assert.equal(second.sessions.closed, undefined);
  assert.equal(second.sessions.claudeClosed, undefined);
  assert.equal(second.missingSince.size, 0, 'метка удалённой карточки не остаётся в Map');
});

test('снова живой процесс сбрасывает подозрение на закрытие', () => {
  const sessions = { s1: { agent: 'codex', processPid: 100 } };
  const missing = new Map([['s1', 1000]]);
  const result = pruneClosedSessions(sessions, new Set([100]), missing, 50_000, 10_000);
  assert.equal(result.sessions, sessions);
  assert.equal(result.missingSince.size, 0);
});

test('реестр подозрений не растёт при многократной смене закрытых сессий', () => {
  let missing = new Map();
  for (let i = 0; i < 10_000; i += 1) {
    const sessions = { [`s${i}`]: { agent: 'codex', processPid: i + 100 } };
    const first = pruneClosedSessions(sessions, new Set(), missing, i * 2, 1);
    const second = pruneClosedSessions(sessions, new Set(), first.missingSince, i * 2 + 1, 1);
    assert.equal(Object.keys(second.sessions).length, 0);
    missing = second.missingSince;
  }
  assert.equal(missing.size, 0);
});
