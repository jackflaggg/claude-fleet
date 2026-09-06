import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actsHtml,
  badgeFor,
  cardHtml,
  cardSig,
  killHtml,
  rowHtml,
} from '../public/js/ui/markup.js';
import { ACTIVITY_BARS } from '../public/js/lib/activity.js';
import { AGENT, STATUS, WAIT_REASON } from '../public/js/lib/domain.js';
import { STATUS_META, WAIT_BADGE } from '../public/js/board-config.js';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

function card(extra = {}) {
  return {
    sessionId: 'abc-123',
    agent: AGENT.CLAUDE,
    project: 'claude-fleet',
    cwd: '/Users/me/Projects/claude-fleet',
    status: STATUS.WAITING,
    reason: WAIT_REASON.PERMISSION,
    title: 'починить тесты',
    note: 'Claude needs your permission to use Bash',
    tool: 'Bash',
    toolInfo: 'git status',
    terminal: 'WebStorm',
    createdAt: NOW - 20 * 60_000,
    updatedAt: NOW - 10_000,
    waitingSince: NOW - 192_000,
    ...extra,
  };
}

test('кнопки ответа рисуются только при подключённом канале', () => {
  assert.equal(actsHtml(card({ permission: { requestId: 'r1' } })), '', 'без канала ничего');
  assert.equal(actsHtml(card({ channel: { since: 1 } })), '', 'ждёт разрешения без pending-запроса: кнопок нет');

  const verdict = actsHtml(card({ channel: { since: 1 }, permission: { requestId: 'r1' } }));
  assert.match(verdict, /data-verdict="allow"/);
  assert.match(verdict, /data-verdict="deny"/);
  assert.doesNotMatch(verdict, /<form/);

  const reply = actsHtml(card({ channel: { since: 1 }, reason: WAIT_REASON.FINISHED }));
  assert.match(reply, /<form class="reply"/);
  assert.match(reply, /maxlength="4000"/);
  assert.doesNotMatch(reply, /data-verdict/);

  const withoutChannel = cardHtml(card({ permission: { requestId: 'r1' } }), NOW);
  assert.doesNotMatch(withoutChannel, /class="act/, 'карточка без канала не показывает кнопки-обманки');
});

test('строка без промпта показывает плейсхолдер, с промптом - сам промпт', () => {
  const fresh = rowHtml(card({ status: STATUS.READY, reason: undefined, title: undefined }), NOW);
  assert.match(fresh, /<span class="none">новая сессия, промпта ещё нет<\/span>/);

  const withTitle = rowHtml(card({ status: STATUS.WORKING, reason: undefined }), NOW);
  assert.match(withTitle, /починить тесты/);
  assert.doesNotMatch(withTitle, /class="none"/);
});

test('динамический текст экранируется во всех строителях', () => {
  const evil = card({
    sessionId: 'id" onclick="x',
    project: '<b>proj</b>',
    title: '<img src=x onerror=alert(1)>',
    note: '<script>alert(2)</script>',
    toolInfo: 'echo "<x>"',
    terminal: '<i>term</i>',
    worktree: '<u>wt</u>',
  });
  for (const html of [cardHtml(evil, NOW), rowHtml({ ...evil, status: STATUS.WORKING, reason: undefined }, NOW)]) {
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<b>proj/);
    assert.doesNotMatch(html, /<i>term/);
    assert.doesNotMatch(html, /<u>wt/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  assert.match(killHtml(evil), /data-kill="id&quot; onclick=&quot;x"/);
});

test('бейдж ждущей карточки идёт из WAIT_BADGE, строки из STATUS_META', () => {
  assert.deepEqual(badgeFor(card({ reason: WAIT_REASON.FINISHED })), { cls: 'done', label: WAIT_BADGE[WAIT_REASON.FINISHED] });
  assert.deepEqual(badgeFor(card({ reason: WAIT_REASON.PERMISSION })), { cls: 'waiting', label: WAIT_BADGE[WAIT_REASON.PERMISSION] });
  assert.deepEqual(badgeFor(card({ reason: 'mystery' })), { cls: 'waiting', label: 'ждёт тебя' }, 'незнакомая причина всё равно зовёт');
  assert.equal(badgeFor(card({ status: STATUS.WORKING })), STATUS_META[STATUS.WORKING]);
  assert.equal(badgeFor(card({ status: 'mystery' })), STATUS_META[STATUS.READY], 'незнакомый статус читается как готовность');
});

test('карточка «закончил ход» без свечения и с подписью «простаивает», красная - со свечением', () => {
  const done = cardHtml(card({ reason: WAIT_REASON.FINISHED }), NOW);
  assert.doesNotMatch(done, /class="glow"/);
  assert.match(done, /простаивает/);
  assert.doesNotMatch(done, /class="tool"/, 'закончившей ход инструмент показывать незачем');

  const attn = cardHtml(card(), NOW);
  assert.match(attn, /<i class="glow"><\/i>/);
  assert.match(attn, /ждёт<\/span>/);
  assert.match(attn, /class="tool"/, 'при разрешении видно, на что спрашивают');
  assert.match(attn, /data-ts="\d+">3:12</, 'таймер считается от waitingSince');
});

test('строка прячет инструмент у готовой сессии и рисует искру на все столбики', () => {
  const ready = rowHtml(card({ status: STATUS.READY, reason: undefined }), NOW);
  assert.doesNotMatch(ready, /class="tool"/);
  const working = rowHtml(card({ status: STATUS.WORKING, reason: undefined }), NOW);
  assert.match(working, /class="tool"/);
  assert.equal((working.match(/<i><\/i>/g) || []).length, ACTIVITY_BARS);
  assert.match(working, /class="age" data-created="\d+">20 мин</);
  assert.match(working, /class="origin c-origin"/);
});

test('сигнатура карточки меняется от полей рендера и не меняется от тиков', () => {
  const base = card();
  assert.equal(cardSig(base), cardSig({ ...base, updatedAt: NOW, activity: [1, 2], activityMinute: 5 }));
  assert.notEqual(cardSig(base), cardSig({ ...base, title: 'другая задача' }));
  assert.notEqual(cardSig(base), cardSig({ ...base, channel: { since: 1 } }));
  assert.notEqual(cardSig(base), cardSig({ ...base, permission: { requestId: 'r2' } }));
  assert.notEqual(cardSig(base), cardSig({ ...base, waitingSince: NOW }));
});
