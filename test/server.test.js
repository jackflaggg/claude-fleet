import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { CROSS_SITE, SERVER, sleep, stalledSubscriber, startServer } from './helpers/fleet-process.js';
import { fakeClock, startFleet } from './helpers/fleet-inprocess.js';

/*
 * Тесты маршрутов на экземпляре `createFleet` в этом же процессе (helpers/fleet-inprocess.js):
 * живой борд и его персист остаются нетронутыми. Чистые ядра покрыты своими тестами; здесь
 * ловим то, что живёт только в склейке - буферы SSE, защита маршрутов, персист, settle
 * разрешений. Спавн настоящего `server.js` остаётся ровно для двух случаев, где важен сам
 * процесс: битый id не должен его ронять, занятый порт должен его завершать.
 */

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

test('занятый порт завершает процесс с кодом 1 и строкой в логе, а не крутит launchd по кругу', async () => {
  const fleet = await startFleet();
  try {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, FLEET_PORT: String(fleet.port), FLEET_HOST: '127.0.0.1', FLEET_STATE_FILE: `${fleet.stateFile}.other` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(output, /уже занят/);
  } finally {
    await fleet.close();
  }
});

test('после close() сервер не слушает, таймеры сняты, серверных хендлов не осталось', async () => {
  // Закрытый хендл отпускается на следующем обороте цикла, поэтому замеры после sleep(0).
  const serverHandles = async () => {
    await sleep(0);
    return process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap').length;
  };
  const baseline = await serverHandles();
  mock.timers.enable({ apis: ['setInterval'] });
  const clock = fakeClock();
  const fleet = await startFleet({ clock });
  try {
    await fleet.event({ session_id: 'a', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/p', prompt: 'задача' });
    assert.equal((await fleet.stats()).sessions, 1);
    assert.equal(await serverHandles(), baseline + 1, 'пока экземпляр жив, серверный хендл открыт');
    await fleet.close();
    assert.equal(fleet.server.listening, false);
    assert.equal(await serverHandles(), baseline);
    await assert.rejects(fetch(`${fleet.base}/stats`), 'порт после close() закрыт');
    const calls = clock.calls;
    mock.timers.tick(10 * 60 * 1000);
    assert.equal(clock.calls, calls, 'уборка зомби после close() не тикает');
  } finally {
    await fleet.close();
    mock.timers.reset();
  }
});

test('GET /channel/commands с чужой страницы получает 403 и канал не регистрирует', async () => {
  const fleet = await startFleet();
  try {
    const evil = await fleet.subscribe('/channel/commands?pid=7777', CROSS_SITE);
    assert.equal(evil.status, 403);
    assert.equal((await fleet.stats()).channels, 0);

    // процесс канала ходит без Origin и Sec-Fetch-Site - он проходит
    const real = await fleet.subscribe('/channel/commands?pid=7777');
    assert.equal(real.status, 200);
    assert.equal((await fleet.stats()).channels, 1);
    real.request.destroy();
  } finally {
    await fleet.close();
  }
});

test('вход по ссылке с токеном ставит HttpOnly-cookie и уводит на / без query', async () => {
  const fleet = await startFleet({ env: { FLEET_TOKEN: 'x' } });
  try {
    const login = await fetch(`${fleet.base}/?token=x`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie.startsWith('fleet_token=x;'), cookie);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/']) {
      assert.ok(cookie.includes(attr), `${attr} в ${cookie}`);
    }

    const wrong = await fetch(`${fleet.base}/?token=nope`, { redirect: 'manual' });
    assert.equal(wrong.status, 403, 'неверный токен не даёт cookie');
    assert.equal(wrong.headers.get('set-cookie'), null);

    // loopback остаётся доверенным и без cookie: борд на этой машине работает как прежде
    assert.equal((await fetch(`${fleet.base}/`)).status, 200);
    assert.equal((await fetch(`${fleet.base}/stats`)).status, 200);
  } finally {
    await fleet.close();
  }
});

test('без FLEET_TOKEN параметр token игнорируется и cookie не ставится', async () => {
  const fleet = await startFleet();
  try {
    const res = await fetch(`${fleet.base}/?token=x`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await fleet.close();
  }
});

test('SSE-клиент, который не читает, отключается, и память сервера не растёт под него', async () => {
  const fleet = await startFleet();
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
    assert.match(fleet.logs(), /не читает/);
  } finally {
    await fleet.close();
  }
});

test('шторм событий коалесцируется в несколько снимков, а не в снимок на событие', async () => {
  const fleet = await startFleet();
  try {
    const reader = await fleet.subscribe('/stream');
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
    await fleet.close();
  }
});

test('ноль и мусор в числовом конфиге попадают в лог, а не подменяются молча', async () => {
  const fleet = await startFleet({ env: { FLEET_STALE_HOURS: '0', FLEET_BLANK_MINUTES: 'abc' } });
  try {
    assert.match(fleet.logs(), /FLEET_STALE_HOURS/);
    assert.match(fleet.logs(), /FLEET_BLANK_MINUTES/);
  } finally {
    await fleet.close();
  }
});

test('персист пишется с правами 0600 и дописывается при close(), не дожидаясь таймера', async () => {
  const fleet = await startFleet();
  try {
    await fleet.event({ session_id: 'p', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/p', prompt: 'секретная задача' });
  } finally {
    await fleet.close();
  }
  const mode = statSync(fleet.stateFile).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('запрос разрешения с неожиданным request_id отклоняется с записью в лог', async () => {
  const fleet = await startFleet();
  try {
    const channel = await fleet.subscribe('/channel/commands?pid=4242');
    assert.equal(channel.status, 200);
    const response = await fetch(`${fleet.base}/channel/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: 4242, request_id: 'new-format-123', tool_name: 'Bash', description: 'x', input_preview: 'y' }),
    });
    assert.equal(response.status, 409);
    assert.match(fleet.logs(), /request_id/);
    channel.request.destroy();
  } finally {
    await fleet.close();
  }
});

test('запрос разрешения, закрытый в терминале, снимается с карточки через паузу settle', async () => {
  const clock = fakeClock();
  const fleet = await startFleet({ clock });
  try {
    const channel = await fleet.subscribe('/channel/commands?pid=4242');
    assert.equal(channel.status, 200);
    // карточка работает (не ждёт разрешения), а канал уже принёс запрос
    await fleet.event({ session_id: 'c', hook_event_name: 'PreToolUse', cwd: '/tmp/p', tool_name: 'Bash', tool_input: { command: 'ls' } }, { 'X-Fleet-Pid': '4242' });
    const opened = await fetch(`${fleet.base}/channel/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: 4242, request_id: 'abcde', tool_name: 'Bash', description: 'ls', input_preview: 'ls' }),
    });
    assert.equal(opened.status, 204);
    let [card] = (await fleet.snapshot()).sessions;
    assert.equal(card.permission?.requestId, 'abcde', 'до паузы запрос виден: порядок прихода уведомления и события не гарантирован');

    clock.advance(3001);
    await fleet.event({ session_id: 'c', hook_event_name: 'PostToolUse', cwd: '/tmp/p', tool_name: 'Bash', tool_input: { command: 'ls' } }, { 'X-Fleet-Pid': '4242' });
    [card] = (await fleet.snapshot()).sessions;
    assert.equal(card.permission, null, 'после паузы без ожидания разрешения запрос считается закрытым в терминале');
    channel.request.destroy();
  } finally {
    await fleet.close();
  }
});

test('зомби-карточка убирается таймером по порогу простоя без ожидания в реальном времени', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const clock = fakeClock();
  const fleet = await startFleet({ clock });
  try {
    await fleet.event({ session_id: 'z', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/p', prompt: 'задача' });
    assert.equal((await fleet.stats()).sessions, 1);
    clock.advance(7 * 60 * 60 * 1000);
    mock.timers.tick(5 * 60 * 1000);
    assert.equal((await fleet.stats()).sessions, 0);
  } finally {
    await fleet.close();
    mock.timers.reset();
  }
});
