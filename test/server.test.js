import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Тесты маршрутов server.js на настоящем процессе: сервер поднимается спавном на свободном
 * порту, со своим файлом состояния и пустой папкой транскриптов, чтобы живой борд и его
 * персист остались нетронутыми. Чистые ядра покрыты своими тестами; здесь ловим то, что
 * живёт только в склейке - падение процесса, буферы SSE, защита маршрутов.
 */
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-test-'));
  const stateFile = join(dir, 'state.json');
  const env = {
    ...process.env,
    FLEET_PORT: String(port),
    FLEET_HOST: '127.0.0.1',
    FLEET_ALLOWED_HOSTS: '',
    FLEET_STATE_FILE: stateFile,
    FLEET_TRANSCRIPTS: dir,
    FLEET_CHANNEL: '1',
    FLEET_WEBSTORM: '',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/stats`);
      if (response.ok) break;
    } catch {
      // ещё поднимается
    }
    if (child.exitCode !== null) throw new Error(`сервер не поднялся: ${stdout}${stderr}`);
    await sleep(50);
  }
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
  return {
    base,
    port,
    stateFile,
    child,
    stop,
    stats: async () => (await fetch(`${base}/stats`)).json(),
    logs: () => stdout + stderr,
    event: (body, headers = {}) => fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CROSS_SITE = { Origin: 'http://evil.com', 'Sec-Fetch-Site': 'cross-site' };

/** SSE-подписчик, который читает и считает сообщения `data:`. */
function subscribe(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${path}`, { headers }, (response) => {
      const state = { status: response.statusCode, messages: 0, bytes: 0, ended: false, request };
      response.on('data', (chunk) => {
        state.bytes += chunk.length;
        state.messages += String(chunk).split('data:').length - 1;
      });
      response.on('end', () => { state.ended = true; });
      response.on('close', () => { state.ended = true; });
      resolve(state);
    });
    request.on('error', reject);
  });
}

/** Клиент, который подключился к /stream и ничего не читает: как вкладка на уснувшем планшете. */
function stalledSubscriber(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
      socket.pause();
      resolve(socket);
    });
  });
}

test('битый percent-encoding в id отвечает 400, а не роняет процесс', async () => {
  const fleet = await startServer();
  try {
    const focus = await fetch(`${fleet.base}/focus/%`, { method: 'POST' });
    assert.equal(focus.status, 400);
    const drop = await fetch(`${fleet.base}/session/%E0%A4%A`, { method: 'DELETE' });
    assert.equal(drop.status, 400);
    const verdict = await fetch(`${fleet.base}/channel/permission/%`, { method: 'POST' });
    assert.equal(verdict.status, 400);
    const message = await fetch(`${fleet.base}/channel/message/%`, { method: 'POST' });
    assert.equal(message.status, 400);
    assert.equal(fleet.child.exitCode, null, 'процесс сервера должен остаться жив');
    assert.equal((await fleet.stats()).boards, 0);
  } finally {
    await fleet.stop();
  }
});

test('GET /channel/commands с чужой страницы получает 403 и канал не регистрирует', async () => {
  const fleet = await startServer();
  try {
    const evil = await subscribe(fleet.base, '/channel/commands?pid=7777', CROSS_SITE);
    assert.equal(evil.status, 403);
    assert.equal((await fleet.stats()).channels, 0);

    // процесс канала ходит без Origin и Sec-Fetch-Site - он проходит
    const real = await subscribe(fleet.base, '/channel/commands?pid=7777');
    assert.equal(real.status, 200);
    assert.equal((await fleet.stats()).channels, 1);
    real.request.destroy();
  } finally {
    await fleet.stop();
  }
});

test('SSE-клиент, который не читает, отключается, и память сервера не растёт под него', async () => {
  const fleet = await startServer();
  try {
    // толстый снимок: много сессий с длинными задачами
    for (let i = 0; i < 300; i += 1) {
      await fleet.event({
        session_id: `s${i}`, hook_event_name: 'UserPromptSubmit', cwd: `/tmp/p${i % 7}`,
        prompt: 'задача '.repeat(45),
      });
    }
    const before = await fleet.stats();
    assert.ok(before.snapshotKb > 100, `снимок должен быть толстым, а он ${before.snapshotKb} КБ`);

    const stalled = await stalledSubscriber(fleet.port);
    await sleep(100);
    assert.equal((await fleet.stats()).boards, 1);

    let dropped = false;
    const deadline = Date.now() + 8000;
    let i = 0;
    while (Date.now() < deadline) {
      await fleet.event({ session_id: `s${i % 300}`, hook_event_name: 'PreToolUse', cwd: '/tmp/p0', tool_name: 'Bash', tool_input: { command: `echo ${i}` } });
      i += 1;
      if (i % 50 === 0 && (await fleet.stats()).boards === 0) {
        dropped = true;
        break;
      }
    }
    const after = await fleet.stats();
    stalled.destroy();
    assert.ok(dropped, `зависший клиент должен быть отключён, а он держится после ${i} событий`);
    assert.ok(after.rssMb - before.rssMb < 60, `RSS вырос на ${(after.rssMb - before.rssMb).toFixed(1)} МБ`);
  } finally {
    await fleet.stop();
  }
});

test('шторм событий коалесцируется в несколько снимков, а не в снимок на событие', async () => {
  const fleet = await startServer();
  try {
    const reader = await subscribe(fleet.base, '/stream');
    assert.equal(reader.status, 200);
    const EVENTS = 200;
    for (let i = 0; i < EVENTS; i += 1) {
      await fleet.event({ session_id: 'storm', hook_event_name: 'PreToolUse', cwd: '/tmp/p', tool_name: 'Bash', tool_input: { command: `echo ${i}` } });
    }
    await sleep(200);
    reader.request.destroy();
    // первый снимок при подключении плюс редкие сбросы по таймеру
    assert.ok(reader.messages < EVENTS / 2, `борд получил ${reader.messages} снимков на ${EVENTS} событий`);
    assert.ok(reader.messages >= 2, 'но последнее состояние доехать обязано');
  } finally {
    await fleet.stop();
  }
});

test('ноль и мусор в числовом конфиге попадают в лог, а не подменяются молча', async () => {
  const fleet = await startServer({ FLEET_STALE_HOURS: '0', FLEET_BLANK_MINUTES: 'abc' });
  try {
    await sleep(100);
    const logs = fleet.logs();
    assert.match(logs, /FLEET_STALE_HOURS/);
    assert.match(logs, /FLEET_BLANK_MINUTES/);
  } finally {
    await fleet.stop();
  }
});

test('персист пишется с правами 0600: там промпты и команды Bash', async () => {
  const fleet = await startServer();
  try {
    await fleet.event({ session_id: 'p', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/p', prompt: 'секретная задача' });
    await sleep(800);
    const mode = statSync(fleet.stateFile).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  } finally {
    await fleet.stop();
  }
});

test('запрос разрешения с неожиданным request_id отклоняется с записью в лог', async () => {
  const fleet = await startServer();
  try {
    const channel = await subscribe(fleet.base, '/channel/commands?pid=4242');
    assert.equal(channel.status, 200);
    const response = await fetch(`${fleet.base}/channel/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: 4242, request_id: 'new-format-123', tool_name: 'Bash', description: 'x', input_preview: 'y' }),
    });
    assert.equal(response.status, 409);
    await sleep(50);
    assert.match(fleet.logs(), /request_id/);
    channel.request.destroy();
  } finally {
    await fleet.stop();
  }
});
