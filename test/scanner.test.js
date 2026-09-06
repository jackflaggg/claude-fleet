import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, truncateSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageScanner } from '../src/usage/scanner.js';

/*
 * Сканер на настоящей временной папке: то, что живёт только в склейке с файлами - смещения,
 * дочитывание хвоста, забывание выпавших файлов, усечённый файл.
 */
const WINDOW = 5 * 60 * 60 * 1000;
const ALIGN = 30 * 60 * 1000;
const MINUTE = 60 * 1000;

const assistantLine = (ms) =>
  `{"type":"assistant","timestamp":"${new Date(ms).toISOString()}","message":{"usage":{"output_tokens":214}}}\n`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-usage-'));
  const project = join(dir, '-Users-x-proj');
  mkdirSync(project);
  const lines = [];
  let changes = 0;
  const scanner = createUsageScanner({
    dir,
    windowMs: WINDOW,
    alignMs: ALIGN,
    log: (line) => lines.push(line),
    onChange: () => { changes += 1; },
  });
  return { dir, project, scanner, lines, changes: () => changes };
}

test('первый скан открывает окно от первой метки, выровненной вниз до получаса', async () => {
  const { project, scanner, changes } = setup();
  const now = Date.now();
  const first = now - 40 * MINUTE;
  writeFileSync(join(project, 'a.jsonl'), assistantLine(first) + assistantLine(now - 10 * MINUTE));
  await scanner.scan();
  assert.equal(scanner.window.start, Math.floor(first / ALIGN) * ALIGN);
  assert.equal(scanner.window.requests, 2);
  assert.equal(scanner.files, 1);
  assert.equal(changes(), 1);
});

test('следующий скан дочитывает только хвост, без изменений борд не дёргается', async () => {
  const { project, scanner, changes } = setup();
  const now = Date.now();
  const file = join(project, 'a.jsonl');
  writeFileSync(file, assistantLine(now - 30 * MINUTE));
  await scanner.scan();
  await scanner.scan();
  assert.equal(changes(), 1, 'ничего не изменилось: без рассылки');
  appendFileSync(file, assistantLine(now - 5 * MINUTE));
  await scanner.scan();
  assert.equal(scanner.window.requests, 2);
  assert.equal(changes(), 2);
});

test('незавершённая строка в хвосте ждёт следующего прохода и не теряется', async () => {
  const { project, scanner } = setup();
  const now = Date.now();
  const file = join(project, 'a.jsonl');
  const whole = assistantLine(now - 20 * MINUTE);
  writeFileSync(file, whole + '{"type":"assistant","timesta');
  await scanner.scan();
  assert.equal(scanner.window.requests, 1);
  appendFileSync(file, `mp":"${new Date(now - 10 * MINUTE).toISOString()}"}\n`);
  await scanner.scan();
  assert.equal(scanner.window.requests, 2, 'склеенная строка засчитана');
});

test('транскрипт старше двух окон не читается, папки без транскриптов не ломают скан', async () => {
  const { dir, project, scanner } = setup();
  const now = Date.now();
  const old = join(project, 'old.jsonl');
  writeFileSync(old, assistantLine(now - 3 * WINDOW));
  const ago = (now - 3 * WINDOW) / 1000;
  utimesSync(old, ago, ago);
  writeFileSync(join(dir, 'мусор.txt'), 'не папка');
  await scanner.scan();
  assert.equal(scanner.window, null);
  assert.equal(scanner.files, 0);
});

test('усечённый файл читается заново, а не с прежнего смещения', async () => {
  const { project, scanner } = setup();
  const now = Date.now();
  const file = join(project, 'a.jsonl');
  writeFileSync(file, assistantLine(now - 30 * MINUTE) + assistantLine(now - 20 * MINUTE));
  await scanner.scan();
  truncateSync(file, 0);
  writeFileSync(file, assistantLine(now - 5 * MINUTE));
  await scanner.scan();
  assert.equal(scanner.files, 1);
  assert.ok(scanner.window.requests >= 3, 'метка из перезаписанного файла учтена');
});

test('папки транскриптов нет: окна нет, ошибки нет', async () => {
  const lines = [];
  const scanner = createUsageScanner({ dir: join(tmpdir(), 'fleet-nope-' + Date.now()), windowMs: WINDOW, alignMs: ALIGN, log: (line) => lines.push(line) });
  await scanner.scan();
  assert.equal(scanner.window, null);
  assert.deepEqual(lines, []);
});
