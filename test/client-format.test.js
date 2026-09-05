import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ageText,
  durationText,
  escapeHtml,
  plural,
  projectMark,
  relativeTime,
  timerText,
  waitingText,
} from '../public/js/lib/format.js';
import { sparkBars, ACTIVITY_BARS } from '../public/js/lib/activity.js';

test('клиентские форматтеры времени сохраняют подписи борда', () => {
  const now = Date.UTC(2026, 7, 2, 12, 0, 0);
  assert.equal(relativeTime(now - 90_000, now), '1 мин назад');
  assert.equal(durationText(now - 2 * 60 * 60_000, now), 'идёт 2 ч');
  assert.equal(waitingText(now - 45_000, now), '45 с');
});

test('возраст строки и таймер карточки читаются как на табло', () => {
  const now = Date.UTC(2026, 7, 2, 12, 0, 0);
  assert.equal(ageText(now - 41_000, now), '41 с');
  assert.equal(ageText(now - 41 * 60_000, now), '41 мин');
  assert.equal(ageText(now - 65 * 60_000, now), '1 ч 05 мин');
  assert.equal(timerText(now - 192_000, now), '3:12');
  assert.equal(timerText(now - 3_725_000, now), '1:02:05');
  assert.equal(timerText(0, now), '');
});

test('искра досдвигается по текущей минуте на стороне борда', () => {
  const minute = 1000;
  const activity = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3];
  assert.deepEqual(sparkBars(activity, minute, minute * 60_000 + 30_000), activity, 'та же минута - без сдвига');
  assert.deepEqual(sparkBars(activity, minute, (minute + 2) * 60_000), [0, 0, 0, 0, 0, 1, 2, 3, 0, 0]);
  assert.equal(sparkBars(undefined, undefined, 0).length, ACTIVITY_BARS, 'карточка без буфера даёт пустую искру');
});

test('динамический текст экранируется перед вставкой в HTML', () => {
  assert.equal(escapeHtml('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');
});

test('монограмма проекта стабильна и понимает разделители и camelCase', () => {
  assert.equal(projectMark('claude-fleet').letters, 'CF');
  assert.equal(projectMark('LearningMy').letters, 'LM');
  assert.equal(projectMark('claude-fleet').hue, projectMark('claude-fleet').hue);
});

test('русские формы числа выбираются корректно', () => {
  const form = (count) => plural(count, 'сессия', 'сессии', 'сессий');
  assert.equal(form(1), 'сессия');
  assert.equal(form(2), 'сессии');
  assert.equal(form(5), 'сессий');
  assert.equal(form(11), 'сессий');
  assert.equal(form(21), 'сессия');
});
