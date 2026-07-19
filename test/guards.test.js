import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllowLists, isAllowedHost, isCrossSite, boundedKey, OTHER_KIND } from '../guards.js';

const PORT = 4319;
const local = () => buildAllowLists({ host: '127.0.0.1', port: PORT });
const withTablet = () =>
  buildAllowLists({ host: '127.0.0.1', port: PORT, extraHosts: '192.168.1.10:4319' });

// --- Host: защита от DNS rebinding -----------------------------------------------------

test('localhost во всех написаниях пускается', () => {
  const { hosts } = local();
  for (const host of ['127.0.0.1:4319', 'localhost:4319', '[::1]:4319']) {
    assert.equal(isAllowedHost({ host }, hosts), true, host);
  }
});

test('чужой домен не пускается, даже если пакет пришёл на localhost', () => {
  const { hosts } = local();
  assert.equal(isAllowedHost({ host: 'evil.com' }, hosts), false);
  assert.equal(isAllowedHost({ host: 'evil.com:4319' }, hosts), false);
});

test('запрос без Host не пускается', () => {
  const { hosts } = local();
  assert.equal(isAllowedHost({}, hosts), false);
  assert.equal(isAllowedHost({ host: undefined }, hosts), false);
});

test('свой хост из FLEET_ALLOWED_HOSTS пускается, посторонний нет', () => {
  const { hosts } = withTablet();
  assert.equal(isAllowedHost({ host: '192.168.1.10:4319' }, hosts), true);
  assert.equal(isAllowedHost({ host: '192.168.1.99:4319' }, hosts), false);
});

test('FLEET_ALLOWED_HOSTS: пробелы и пустые куски игнорируются', () => {
  const { hosts } = buildAllowLists({ host: '127.0.0.1', port: PORT, extraHosts: ' a:1 , , b:2 ,' });
  assert.equal(isAllowedHost({ host: 'a:1' }, hosts), true);
  assert.equal(isAllowedHost({ host: 'b:2' }, hosts), true);
  assert.equal(isAllowedHost({ host: '' }, hosts), false);
});

// --- Origin: защита от CSRF -------------------------------------------------------------

test('curl из report.sh проходит: у него нет ни Sec-Fetch-Site, ни Origin', () => {
  const { origins } = local();
  assert.equal(isCrossSite({}, origins), false);
});

test('запрос со своей же страницы проходит', () => {
  const { origins } = local();
  assert.equal(
    isCrossSite({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:4319' }, origins),
    false,
  );
});

test('запрос с чужой страницы рубится', () => {
  const { origins } = local();
  assert.equal(isCrossSite({ 'sec-fetch-site': 'cross-site', origin: 'http://evil.com' }, origins), true);
  // чужой Origin рубится, даже если Sec-Fetch-Site браузер не прислал
  assert.equal(isCrossSite({ origin: 'http://evil.com' }, origins), true);
});

test('борд с планшета: клик по карточке НЕ считается запросом с чужой страницы', () => {
  // Регресс: Origin был захардкожен на localhost, поэтому страница, открытая по
  // FLEET_ALLOWED_HOSTS, показывалась, но POST /focus и DELETE /session ловили 403.
  const { hosts, origins } = withTablet();
  const headers = {
    host: '192.168.1.10:4319',
    origin: 'http://192.168.1.10:4319',
    'sec-fetch-site': 'same-origin',
  };
  assert.equal(isAllowedHost(headers, hosts), true, 'страница должна открываться');
  assert.equal(isCrossSite(headers, origins), false, 'и клик по карточке должен работать');
});

test('за реверс-прокси https-Origin своего хоста тоже свой', () => {
  const { origins } = withTablet();
  assert.equal(isCrossSite({ origin: 'https://192.168.1.10:4319' }, origins), false);
});

test('хост из allowlist не даёт прохода чужому Origin', () => {
  const { origins } = withTablet();
  assert.equal(isCrossSite({ origin: 'http://192.168.1.11:4319' }, origins), true);
});

// --- boundedKey: счётчики не растут без предела ------------------------------------------

test('пока ключей меньше лимита, имя идёт как есть', () => {
  const map = new Map();
  for (const name of ['A', 'B', 'C']) map.set(boundedKey(map, name, 5), 1);
  assert.deepEqual([...map.keys()], ['A', 'B', 'C']);
});

test('сверх лимита новые имена сваливаются в одну строку', () => {
  const map = new Map();
  for (let i = 0; i < 3000; i++) map.set(boundedKey(map, `Bogus${i}`, 12), 1);
  assert.equal(map.size, 13, 'двенадцать имён плюс строка «прочие», а не 3000');
  assert.ok(map.has(OTHER_KIND));
});

test('уже известное имя продолжает считаться после исчерпания лимита', () => {
  const map = new Map();
  for (let i = 0; i < 50; i++) map.set(boundedKey(map, `Kind${i}`, 3), 1);
  // Kind0 попал в лимит и должен по-прежнему возвращаться сам собой, а не «прочие»
  assert.equal(boundedKey(map, 'Kind0', 3), 'Kind0');
});

test('слишком длинное имя обрезается и не раздувает ключ', () => {
  const map = new Map();
  const key = boundedKey(map, 'я'.repeat(500), 12);
  assert.ok(key.length <= 40, `ключ длиной ${key.length}`);
});

test('нестроковое имя не роняет счётчик', () => {
  const map = new Map();
  for (const weird of [null, undefined, 42, {}]) {
    assert.equal(typeof boundedKey(map, weird, 12), 'string');
  }
});
