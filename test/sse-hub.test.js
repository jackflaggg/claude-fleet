import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createSseHub } from '../src/http/sse-hub.js';

/*
 * Хаб на настоящем http.createServer в этом же процессе: то, что раньше проверялось только
 * спавном server.js (нечитающий клиент, heartbeat, дебаунс рассылки), теперь без процесса.
 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** Читающий клиент: копит всё, что пришло. */
function reader(port, path = '/') {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${path}`, (response) => {
      const state = { response, chunks: [], ended: false, request };
      response.setEncoding('utf8');
      response.on('data', (chunk) => state.chunks.push(chunk));
      response.on('end', () => { state.ended = true; });
      response.on('close', () => { state.ended = true; });
      resolve(state);
    });
    request.on('error', reject);
  });
}

/** Клиент, который подключился и ничего не читает: как вкладка на уснувшем планшете. */
function stalled(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      socket.pause();
      resolve(socket);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(probe, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await sleep(10);
  }
  throw new Error(`не дождались: ${what}`);
}

test('клиент открывается заголовками SSE и приветственным комментарием, размер считается', async () => {
  const hub = createSseHub({ log: () => {} });
  const { server, port } = await listen((req, res) => hub.open(req, res, 'fleet'));
  try {
    const client = await reader(port);
    assert.equal(client.response.statusCode, 200);
    assert.equal(client.response.headers['content-type'], 'text/event-stream');
    assert.equal(client.response.headers['cache-control'], 'no-cache');
    await until(() => client.chunks.join('').includes(': fleet\n\n'), 'приветствие');
    assert.equal(hub.size, 1);
    client.request.destroy();
    await until(() => hub.size === 0, 'клиент снят с учёта после обрыва');
  } finally {
    hub.close();
    await closeServer(server);
  }
});

test('нечитающий клиент отключается по потолку буфера, память под него не копится', async () => {
  const lines = [];
  const hub = createSseHub({ log: (line) => lines.push(line), maxBuffered: 64 * 1024 });
  const { server, port } = await listen((req, res) => hub.open(req, res, 'fleet'));
  try {
    const socket = await stalled(port);
    await until(() => hub.size === 1, 'подключение');
    const chunk = `data: ${'x'.repeat(8 * 1024)}\n\n`;
    let dropped = false;
    for (let i = 0; i < 200 && !dropped; i += 1) {
      hub.broadcastNow(chunk);
      dropped = hub.size === 0;
    }
    assert.ok(dropped, 'зависший клиент должен быть отключён');
    assert.ok(lines.some((line) => /не читает/.test(line)), 'отключение попадает в лог');
    socket.destroy();
  } finally {
    hub.close();
    await closeServer(server);
  }
});

test('heartbeat идёт всем клиентам по таймеру и прекращается после close()', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const hub = createSseHub({ log: () => {}, heartbeatMs: 1000 });
  const { server, port } = await listen((req, res) => hub.open(req, res, 'fleet'));
  try {
    const client = await reader(port);
    await until(() => client.chunks.length > 0, 'приветствие');
    mock.timers.tick(1000);
    await until(() => client.chunks.join('').includes(': ping\n\n'), 'ping');
    hub.close();
    await until(() => client.ended, 'клиент закрыт хабом');
    const before = client.chunks.join('');
    mock.timers.tick(5000);
    await sleep(20);
    assert.equal(client.chunks.join(''), before, 'после close() пингов нет');
    assert.equal(hub.size, 0);
  } finally {
    mock.timers.reset();
    hub.close();
    await closeServer(server);
  }
});

test('рассылка коалесцируется: сотня вызовов дают один снимок и одно вычисление payload', async () => {
  const hub = createSseHub({ log: () => {}, debounceMs: 30 });
  const { server, port } = await listen((req, res) => hub.open(req, res, 'fleet'));
  try {
    const client = await reader(port);
    await until(() => hub.size === 1, 'подключение');
    let produced = 0;
    for (let i = 0; i < 100; i += 1) {
      hub.broadcast(() => { produced += 1; return `data: ${i}\n\n`; });
    }
    await sleep(120);
    assert.equal(produced, 1);
    assert.equal(client.chunks.join('').split('data: ').length - 1, 1);
    assert.match(client.chunks.join(''), /data: 99\n\n/, 'доезжает последнее состояние');
  } finally {
    hub.close();
    await closeServer(server);
  }
});

test('без клиентов отложенная рассылка не вычисляет payload вовсе', async () => {
  const hub = createSseHub({ log: () => {}, debounceMs: 10 });
  let produced = 0;
  hub.broadcast(() => { produced += 1; return 'data: x\n\n'; });
  await sleep(50);
  assert.equal(produced, 0);
  hub.close();
});

test('onClose клиента вызывается один раз и после close() хаба тоже', async () => {
  const hub = createSseHub({ log: () => {} });
  let closed = 0;
  const { server, port } = await listen((req, res) => hub.open(req, res, 'fleet', { onClose: () => { closed += 1; } }));
  try {
    const client = await reader(port);
    await until(() => hub.size === 1, 'подключение');
    hub.close();
    await until(() => client.ended, 'закрытие');
    await sleep(20);
    assert.equal(closed, 1);
  } finally {
    await closeServer(server);
  }
});

test('write в конкретного клиента возвращает false после его обрыва', async () => {
  const hub = createSseHub({ log: () => {} });
  let handle;
  const { server, port } = await listen((req, res) => { handle = hub.open(req, res, 'fleet'); });
  try {
    const client = await reader(port);
    await until(() => Boolean(handle), 'подключение');
    assert.equal(hub.write(handle, 'data: 1\n\n'), true);
    await until(() => client.chunks.join('').includes('data: 1'), 'доставка');
    client.request.destroy();
    await until(() => hub.size === 0, 'обрыв');
    assert.equal(hub.write(handle, 'data: 2\n\n'), false);
  } finally {
    hub.close();
    await closeServer(server);
  }
});
