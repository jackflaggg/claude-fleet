import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const ROOT = '/repo';
const HOME = '/home/u';

function load(env, { exists = () => true } = {}) {
  const lines = [];
  const config = loadConfig(env, { log: (line) => lines.push(line), exists, root: ROOT, home: HOME });
  return { config, lines };
}

test('пустое окружение даёт дефолты и ничего не пишет в лог', () => {
  const { config, lines } = load({});
  assert.equal(config.port, 4319);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.extraHosts, '');
  assert.equal(config.stateFile, '/repo/.fleet-state.json');
  assert.equal(config.staleMs, 6 * 60 * 60 * 1000);
  assert.equal(config.blankMs, 15 * 60 * 1000);
  assert.equal(config.transcriptsDir, '/home/u/.claude/projects');
  assert.equal(config.usageWindowMs, 5 * 60 * 60 * 1000);
  assert.equal(config.usageAlignMs, 30 * 60 * 1000);
  assert.equal(config.webstormLauncher, null);
  assert.equal(config.webstormApp, 'WebStorm');
  assert.equal(config.channelEnabled, false);
  assert.equal(config.token, '');
  assert.deepEqual(lines, []);
  assert.ok(Object.isFrozen(config), 'конфиг не меняется после старта');
});

test('ноль и мусор в числах дают дефолт со строкой в лог, а не молча', () => {
  const { config, lines } = load({ FLEET_STALE_HOURS: '0', FLEET_BLANK_MINUTES: 'abc', FLEET_PORT: '-5' });
  assert.equal(config.staleMs, 6 * 60 * 60 * 1000);
  assert.equal(config.blankMs, 15 * 60 * 1000);
  assert.equal(config.port, 4319);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /FLEET_PORT/);
  assert.match(lines[1], /FLEET_STALE_HOURS=0/);
  assert.match(lines[2], /FLEET_BLANK_MINUTES=abc/);
});

test('выравнивание окна можно выключить нулём: там min 0', () => {
  const { config, lines } = load({ FLEET_USAGE_ALIGN_MIN: '0' });
  assert.equal(config.usageAlignMs, 0);
  assert.deepEqual(lines, []);
});

test('пустая строка в переменной это «не задано», дефолт без лога', () => {
  const { config, lines } = load({ FLEET_PORT: '  ', FLEET_TRANSCRIPTS: '', FLEET_STATE_FILE: '' });
  assert.equal(config.port, 4319);
  assert.equal(config.transcriptsDir, '/home/u/.claude/projects');
  assert.equal(config.stateFile, '/repo/.fleet-state.json');
  assert.deepEqual(lines, []);
});

test('заданные значения проходят как есть', () => {
  const { config } = load({
    FLEET_PORT: '4399',
    FLEET_HOST: '0.0.0.0',
    FLEET_ALLOWED_HOSTS: '192.168.1.10:4319, tablet.local:4319',
    FLEET_STATE_FILE: '/tmp/state.json',
    FLEET_TRANSCRIPTS: '/tmp/transcripts',
    FLEET_USAGE_HOURS: '2',
    FLEET_WEBSTORM_APP: 'PhpStorm',
  });
  assert.equal(config.port, 4399);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.extraHosts, '192.168.1.10:4319, tablet.local:4319');
  assert.equal(config.stateFile, '/tmp/state.json');
  assert.equal(config.transcriptsDir, '/tmp/transcripts');
  assert.equal(config.usageWindowMs, 2 * 60 * 60 * 1000);
  assert.equal(config.webstormApp, 'PhpStorm');
});

test('токен LAN читается как есть, пробелы вокруг не считаются токеном', () => {
  assert.equal(load({ FLEET_TOKEN: 'abc' }).config.token, 'abc');
  assert.equal(load({ FLEET_TOKEN: '   ' }).config.token, '', 'пусто = выключено');
});

test('канал включается только строкой 1', () => {
  assert.equal(load({ FLEET_CHANNEL: '1' }).config.channelEnabled, true);
  assert.equal(load({ FLEET_CHANNEL: 'true' }).config.channelEnabled, false);
  assert.equal(load({ FLEET_CHANNEL: '0' }).config.channelEnabled, false);
});

test('лаунчер WebStorm берётся только если файл существует', () => {
  const seen = [];
  const exists = (path) => { seen.push(path); return path === '/usr/local/bin/webstorm'; };
  assert.equal(load({ FLEET_WEBSTORM: '/usr/local/bin/webstorm' }, { exists }).config.webstormLauncher, '/usr/local/bin/webstorm');
  assert.equal(load({ FLEET_WEBSTORM: '/opt/nope' }, { exists }).config.webstormLauncher, null);
  assert.deepEqual(seen, ['/usr/local/bin/webstorm', '/opt/nope']);
  // пустой путь не проверяем вовсе
  assert.equal(load({ FLEET_WEBSTORM: '' }, { exists }).config.webstormLauncher, null);
  assert.equal(seen.length, 2);
});
