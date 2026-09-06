import test from 'node:test';
import assert from 'node:assert/strict';
import { createLog } from '../src/log.js';

test('строка лога несёт метку времени и перевод строки', () => {
  const written = [];
  const log = createLog({ write: (line) => written.push(line), clock: () => new Date(2026, 8, 6, 18, 5, 9) });
  log('канал подключён: pid 7');
  assert.equal(written.length, 1);
  assert.match(written[0], /^06\.09\.2026, 18:05:09  канал подключён: pid 7\n$/);
});

test('префикс отделяет процесс канала от сервера в общем логе', () => {
  const written = [];
  const log = createLog({ write: (line) => written.push(line), prefix: 'fleet-channel[42]', clock: () => new Date(2026, 8, 6, 18, 5, 9) });
  log('борд недоступен');
  assert.equal(written[0], '06.09.2026, 18:05:09  fleet-channel[42] борд недоступен\n');
});

test('сбой записи не всплывает наружу: лог не должен ронять процесс', () => {
  const log = createLog({ write: () => { throw new Error('EPIPE'); } });
  assert.doesNotThrow(() => log('что угодно'));
});
