import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { createFleet } from '../../src/fleet.js';
import { freePort, snapshot, subscribe } from './fleet-process.js';

/*
 * Экземпляр борда в процессе теста: `createFleet` с конфигом на свободном порту, своим файлом
 * состояния и пустой папкой транскриптов. Порт резервируется заранее и идёт в `config.port`,
 * а не `listen(0)`: списки Host/Origin строятся от порта до `listen`, и с нулём каждый запрос
 * ловил бы 403. Время, живость PID и лог подменяются параметрами, `close()` зовётся в finally.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startFleet({ env = {}, clock, probe, bootMs } = {}) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-inproc-'));
  const stateFile = join(dir, 'state.json');
  const lines = [];
  const log = (line) => lines.push(line);
  const config = loadConfig({
    FLEET_PORT: String(port),
    FLEET_HOST: '127.0.0.1',
    FLEET_ALLOWED_HOSTS: '',
    FLEET_STATE_FILE: stateFile,
    FLEET_TRANSCRIPTS: dir,
    FLEET_CHANNEL: '1',
    FLEET_WEBSTORM: '',
    ...env,
  }, { log, exists: () => false, root: ROOT });
  const fleet = createFleet({ config, root: ROOT, log, clock, probe, bootMs });
  await new Promise((resolve, reject) => {
    fleet.server.once('error', reject);
    fleet.server.listen(port, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    stateFile,
    server: fleet.server,
    close: fleet.close,
    logs: () => lines.join('\n'),
    stats: async () => (await fetch(`${base}/stats`)).json(),
    event: (body, headers = {}) => fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    snapshot: () => snapshot(base),
    subscribe: (path, headers) => subscribe(base, path, headers),
  };
}

/** Подменяемые часы: `now` двигается тестом, число вызовов видно снаружи. */
export function fakeClock(start = Date.now()) {
  const clock = () => {
    clock.calls += 1;
    return clock.now;
  };
  clock.now = start;
  clock.calls = 0;
  clock.advance = (ms) => { clock.now += ms; };
  return clock;
}
