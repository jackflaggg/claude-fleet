import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durationText,
  escapeHtml,
  plural,
  projectMark,
  relativeTime,
  waitingText,
} from '../public/js/lib/format.js';

test('клиентские форматтеры времени сохраняют подписи борда', () => {
  const now = Date.UTC(2026, 7, 2, 12, 0, 0);
  assert.equal(relativeTime(now - 90_000, now), '1 мин назад');
  assert.equal(durationText(now - 2 * 60 * 60_000, now), 'идёт 2 ч');
  assert.equal(waitingText(now - 45_000, now), '45 с');
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
