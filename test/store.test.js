import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore, SCHEMA } from '../src/fleet/store.js';
import { AGENT } from '../public/js/lib/domain.js';

/*
 * Store на fake fs: файл в памяти, mtime и права видны тесту, диска нет.
 */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([path, entry]) => [path, { mode: 0o644, ...entry }]));
  return {
    files,
    statSync(path) {
      const entry = files.get(path);
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: entry.mtimeMs };
    },
    readFileSync(path) {
      const entry = files.get(path);
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entry.content;
    },
    writeFileSync(path, content, { mode } = {}) {
      files.set(path, { content, mtimeMs: Date.now(), mode });
    },
    renameSync(from, to) {
      const entry = files.get(from);
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.delete(from);
      files.set(to, entry);
    },
  };
}

const FILE = '/state/fleet.json';
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const BOOT = NOW - 10 * HOUR;

function setup(fsInitial, options = {}) {
  const lines = [];
  const fs = fakeFs(fsInitial);
  const store = createSessionStore({
    file: FILE,
    fs,
    log: (line) => lines.push(line),
    clock: () => NOW,
    bootMs: BOOT,
    staleMs: 6 * HOUR,
    blankMs: 15 * 60 * 1000,
    debounceMs: 5,
    ...options,
  });
  return { store, fs, lines };
}

test('нет файла: пусто и без строки в логе, это обычный первый запуск', () => {
  const { store, lines } = setup({});
  assert.deepEqual(store.load(), {});
  assert.deepEqual(lines, []);
});

test('файл записан до загрузки системы: был ребут, сессии мертвы, начинаем с чистого', () => {
  const { store } = setup({
    [FILE]: { content: JSON.stringify({ schema: SCHEMA, sessions: { a: { sessionId: 'a', updatedAt: NOW } } }), mtimeMs: BOOT - 1 },
  });
  assert.deepEqual(store.load(), {});
});

test('обрезанный JSON даёт пусто и строку в логе, а не молчание', () => {
  const { store, lines } = setup({ [FILE]: { content: '{"schema":2,"sessions":{"a":{"sess', mtimeMs: NOW } });
  assert.deepEqual(store.load(), {});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /состояние/);
});

test('старый формат (карта карточек без schema) мигрирует один раз: agent и createdAt появляются', () => {
  const { store, fs } = setup({
    [FILE]: {
      content: JSON.stringify({
        old: { sessionId: 'old', title: 'задача', status: 'working', updatedAt: NOW - HOUR },
        codex: { sessionId: 'codex:x', agent: AGENT.CODEX, title: 'задача', status: 'working', createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR },
        stale: { sessionId: 'stale', title: 'давно', updatedAt: NOW - 7 * HOUR },
      }),
      mtimeMs: NOW,
    },
  });
  const sessions = store.load();
  assert.equal(sessions.old.agent, AGENT.CLAUDE, 'отсутствующий агент значит Claude');
  assert.equal(sessions.old.createdAt, NOW - HOUR, 'возраст считается от последнего известного события');
  assert.equal(sessions.codex.agent, AGENT.CODEX);
  assert.equal(sessions.codex.createdAt, NOW - 2 * HOUR, 'свои поля не перетираются');
  assert.equal(sessions.stale, undefined, 'протухшие отсекаются теми же порогами, что в рантайме');
  store.flush(sessions);
  const written = JSON.parse(fs.files.get(FILE).content);
  assert.equal(written.schema, SCHEMA, 'после первой записи файл в новом формате');
});

test('текущий формат читается как есть, пустая карточка отсекается по короткому порогу', () => {
  const { store } = setup({
    [FILE]: {
      content: JSON.stringify({
        schema: SCHEMA,
        sessions: {
          busy: { sessionId: 'busy', agent: AGENT.CLAUDE, title: 'задача', createdAt: NOW - HOUR, updatedAt: NOW - 20 * 60 * 1000 },
          blank: { sessionId: 'blank', agent: AGENT.CLAUDE, title: '', tool: null, createdAt: NOW - HOUR, updatedAt: NOW - 20 * 60 * 1000 },
        },
      }),
      mtimeMs: NOW,
    },
  });
  const sessions = store.load();
  assert.deepEqual(Object.keys(sessions), ['busy']);
});

test('запись атомарная и с правами 0600: временный файл, затем rename', async () => {
  const { store, fs } = setup({});
  const sessions = { a: { sessionId: 'a', title: 'секретная задача', updatedAt: NOW } };
  store.schedule(sessions);
  store.schedule({ ...sessions, b: { sessionId: 'b', updatedAt: NOW } });
  assert.equal(fs.files.has(FILE), false, 'пока таймер не сработал, на диске ничего нет');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const entry = fs.files.get(FILE);
  assert.equal(entry.mode, 0o600);
  assert.equal(fs.files.has(`${FILE}.tmp`), false, 'временный файл переименован');
  const written = JSON.parse(entry.content);
  assert.deepEqual(Object.keys(written.sessions), ['a', 'b'], 'пишется последнее состояние, а не первое');
});

test('close() дописывает отложенное состояние сразу и снимает таймер', async () => {
  const { store, fs } = setup({});
  store.schedule({ a: { sessionId: 'a', updatedAt: NOW } });
  store.close();
  assert.ok(fs.files.has(FILE), 'состояние на диске без ожидания таймера');
  const before = fs.files.get(FILE).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.files.get(FILE).mtimeMs, before, 'таймер после close() не пишет второй раз');
});

test('сбой записи не роняет процесс, а попадает в лог', () => {
  const { store, fs, lines } = setup({});
  fs.writeFileSync = () => { throw new Error('EACCES'); };
  store.flush({ a: { sessionId: 'a', updatedAt: NOW } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /EACCES/);
});
