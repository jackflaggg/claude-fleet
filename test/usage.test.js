import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStamps, foldStamps, describeWindow, isFreshTranscript } from '../usage.js';

const WINDOW = 5 * 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);

const assistantLine = (iso) =>
  `{"type":"assistant","timestamp":"${iso}","message":{"usage":{"output_tokens":214}}}`;

/** Разбирает кусок как сервер: возвращает и метки, и число разобранных байт. */
function parse(text) {
  const stamps = [];
  const consumed = collectStamps(Buffer.from(text), stamps);
  return { stamps, consumed };
}

test('collectStamps: берёт метку из записи ассистента', () => {
  const { stamps } = parse(assistantLine('2026-07-22T09:34:00.000Z') + '\n');
  assert.deepEqual(stamps, [at('2026-07-22T09:34:00.000Z')]);
});

test('collectStamps: запись пользователя запросом не считается', () => {
  const { stamps } = parse('{"type":"user","timestamp":"2026-07-22T09:34:00.000Z"}\n');
  assert.deepEqual(stamps, []);
});

test('collectStamps: служебные записи транскрипта пропускаем', () => {
  const { stamps } = parse(
    '{"type":"file-history-snapshot","timestamp":"2026-07-22T09:34:00.000Z"}\n' +
    '{"leafUuid":"x","sessionId":"y","type":"summary"}\n'
  );
  assert.deepEqual(stamps, []);
});

test('collectStamps: незавершённую строку не разбирает и не засчитывает в байты', () => {
  // хвост живого транскрипта почти всегда обрывается на середине записи
  const whole = assistantLine('2026-07-22T09:34:00.000Z') + '\n';
  const { stamps, consumed } = parse(whole + '{"type":"assistant","timesta');
  assert.deepEqual(stamps, [at('2026-07-22T09:34:00.000Z')]);
  assert.equal(consumed, Buffer.byteLength(whole));
});

test('collectStamps: кусок с середины строки не даёт ложной метки', () => {
  // первый прочитанный кусок большого файла начинается не с начала записи
  const { stamps } = parse('nt":"assistant","timestamp":"2026-07-22T09:34:00.000Z"}\n');
  assert.deepEqual(stamps, []);
});

test('collectStamps: метка чужой строки не приписывается соседней', () => {
  // маркер ассистента в одной строке, метка в следующей - границы строк обязаны соблюдаться
  const { stamps } = parse('{"type":"assistant"}\n{"type":"user","timestamp":"2026-07-22T09:34:00.000Z"}\n');
  assert.deepEqual(stamps, []);
});

test('collectStamps: битую дату не выдаём за метку', () => {
  const { stamps } = parse('{"type":"assistant","timestamp":"вчера"}\n');
  assert.deepEqual(stamps, []);
});

test('collectStamps: пустой кусок разбирать нечего', () => {
  const { stamps, consumed } = parse('');
  assert.deepEqual(stamps, []);
  assert.equal(consumed, 0);
});

test('collectStamps: многобайтовый текст не сбивает счёт байт', () => {
  // в промптах кириллица и эмодзи, а смещение в файле считается в байтах, не в символах
  const line = '{"type":"user","text":"привет 🚀"}\n';
  const whole = line + assistantLine('2026-07-22T09:34:00.000Z') + '\n';
  const { stamps, consumed } = parse(whole);
  assert.deepEqual(stamps, [at('2026-07-22T09:34:00.000Z')]);
  assert.equal(consumed, Buffer.byteLength(whole));
});

test('foldStamps: без меток окна нет', () => {
  assert.equal(foldStamps(null, [], WINDOW), null);
});

test('foldStamps: первая метка открывает окно', () => {
  const window = foldStamps(null, [at('2026-07-22T09:34:00Z')], WINDOW);
  assert.deepEqual(window, { start: at('2026-07-22T09:34:00Z'), last: at('2026-07-22T09:34:00Z'), requests: 1 });
});

test('foldStamps: метки внутри окна копятся в один блок', () => {
  const window = foldStamps(null, [
    at('2026-07-22T09:34:00Z'),
    at('2026-07-22T11:00:00Z'),
    at('2026-07-22T14:33:00Z'),
  ], WINDOW);
  assert.equal(window.start, at('2026-07-22T09:34:00Z'));
  assert.equal(window.requests, 3);
  assert.equal(window.last, at('2026-07-22T14:33:00Z'));
});

test('foldStamps: метка за границей открывает новое окно, счётчик обнуляется', () => {
  const window = foldStamps(null, [
    at('2026-07-22T09:34:00Z'),
    at('2026-07-22T11:00:00Z'),
    at('2026-07-22T14:34:00Z'),
  ], WINDOW);
  assert.equal(window.start, at('2026-07-22T14:34:00Z'));
  assert.equal(window.requests, 1);
});

test('foldStamps: метка ровно на границе уже относится к новому окну', () => {
  const start = at('2026-07-22T09:00:00Z');
  const window = foldStamps(null, [start, start + WINDOW], WINDOW);
  assert.equal(window.start, start + WINDOW);
  assert.equal(window.requests, 1);
});

test('foldStamps: порядок меток не важен - они приходят из разных файлов', () => {
  const stamps = [at('2026-07-22T11:00:00Z'), at('2026-07-22T09:34:00Z'), at('2026-07-22T10:00:00Z')];
  const window = foldStamps(null, stamps, WINDOW);
  assert.equal(window.start, at('2026-07-22T09:34:00Z'));
  assert.equal(window.requests, 3);
});

test('foldStamps: хвост файла применяется поверх прошлого состояния', () => {
  const first = foldStamps(null, [at('2026-07-22T09:34:00Z')], WINDOW);
  const second = foldStamps(first, [at('2026-07-22T09:40:00Z')], WINDOW);
  assert.equal(second.start, at('2026-07-22T09:34:00Z'));
  assert.equal(second.requests, 2);
});

test('foldStamps: запоздалая метка из закрытого окна счётчик не портит', () => {
  const window = foldStamps(null, [at('2026-07-22T14:34:00Z')], WINDOW);
  const later = foldStamps(window, [at('2026-07-22T09:00:00Z')], WINDOW);
  assert.deepEqual(later, window);
});

test('foldStamps: исходное состояние не мутируется', () => {
  const before = foldStamps(null, [at('2026-07-22T09:34:00Z')], WINDOW);
  const snapshot = { ...before };
  foldStamps(before, [at('2026-07-22T09:40:00Z')], WINDOW);
  assert.deepEqual(before, snapshot);
});

test('foldStamps: входной массив меток не мутируется сортировкой', () => {
  const stamps = [at('2026-07-22T11:00:00Z'), at('2026-07-22T09:34:00Z')];
  const copy = [...stamps];
  foldStamps(null, stamps, WINDOW);
  assert.deepEqual(stamps, copy);
});

test('foldStamps: старт окна выравнивается вниз до получаса', () => {
  // сверено с /usage: активность в 09:34 даёт окно 09:30 - 14:30, а не 09:34 - 14:34
  const window = foldStamps(null, [at('2026-07-22T09:34:00Z')], WINDOW, 30 * 60_000);
  assert.equal(window.start, at('2026-07-22T09:30:00Z'));
  assert.equal(window.last, at('2026-07-22T09:34:00Z'));
});

test('foldStamps: цепочка окон идёт по выровненным границам', () => {
  // метка сразу после сброса обязана открыть новое окно, а не досчитаться в старое
  const window = foldStamps(null, [
    at('2026-07-22T09:34:00Z'),
    at('2026-07-22T14:31:00Z'),
  ], WINDOW, 30 * 60_000);
  assert.equal(window.start, at('2026-07-22T14:30:00Z'));
  assert.equal(window.requests, 1);
});

test('foldStamps: метка до конца выровненного окна остаётся в нём', () => {
  const window = foldStamps(null, [
    at('2026-07-22T09:34:00Z'),
    at('2026-07-22T14:29:00Z'),
  ], WINDOW, 30 * 60_000);
  assert.equal(window.start, at('2026-07-22T09:30:00Z'));
  assert.equal(window.requests, 2);
});

test('foldStamps: без выравнивания старт остаётся минутой первого запроса', () => {
  const window = foldStamps(null, [at('2026-07-22T09:34:00Z')], WINDOW, 0);
  assert.equal(window.start, at('2026-07-22T09:34:00Z'));
});

test('describeWindow: активное окно знает свой конец', () => {
  const start = at('2026-07-22T14:34:00Z');
  const view = describeWindow({ start, last: start, requests: 17 }, start + 60_000, WINDOW);
  assert.deepEqual(view, { startedAt: start, endsAt: start + WINDOW, requests: 17, active: true });
});

test('describeWindow: истёкшее окно помечено закрытым', () => {
  const start = at('2026-07-22T09:34:00Z');
  const view = describeWindow({ start, last: start, requests: 3 }, start + WINDOW + 1, WINDOW);
  assert.equal(view.active, false);
});

test('describeWindow: без окна описывать нечего', () => {
  assert.equal(describeWindow(null, Date.now(), WINDOW), null);
});

test('isFreshTranscript: держим запас в два окна', () => {
  const now = at('2026-07-22T14:00:00Z');
  assert.equal(isFreshTranscript(now - 3 * 3600e3, now, WINDOW), true);
  assert.equal(isFreshTranscript(now - 9 * 3600e3, now, WINDOW), true);
  assert.equal(isFreshTranscript(now - 11 * 3600e3, now, WINDOW), false);
});
