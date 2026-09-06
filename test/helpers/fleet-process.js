import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Настоящий server.js спавном на свободном порту, со своим файлом состояния и пустой папкой
 * транскриптов: живой борд и его персист остаются нетронутыми. Общий хелпер тестов маршрутов
 * и сквозного прогона канала.
 */
export const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');

export const CROSS_SITE = { Origin: 'http://evil.com', 'Sec-Fetch-Site': 'cross-site' };

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

export async function startServer(extraEnv = {}) {
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
    snapshot: () => snapshot(base),
  };
}

/** SSE-подписчик, который читает и считает сообщения `data:`. */
export function subscribe(base, path, headers = {}) {
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
export function stalledSubscriber(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
      socket.pause();
      resolve(socket);
    });
  });
}

/** Первый снимок из /stream: то, что видит борд при открытии. Поток после него закрываем. */
export function snapshot(base) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/stream`, (response) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const at = buffer.indexOf('\ndata: ');
        if (at < 0) return;
        const end = buffer.indexOf('\n\n', at);
        if (end < 0) return;
        request.destroy();
        resolve(JSON.parse(buffer.slice(at + 7, end)));
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}
