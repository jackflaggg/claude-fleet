import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseHub } from '../src/http/sse-hub.js';
import { createChannelRegistry } from '../src/channel/registry.js';
import { STATUS, WAIT_REASON } from '../public/js/lib/domain.js';

/*
 * Реестр на настоящем хабе, но с фейковым res: сокет тут не нужен, важны переходы реестра.
 */
class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.ended = false;
    this.writableLength = 0;
  }

  writeHead() { return this; }

  write(data) { this.written.push(data); return true; }

  end() { this.ended = true; this.emit('close'); }

  destroy() { this.ended = true; this.emit('close'); }
}

const req = { socket: { setKeepAlive() {} } };

function setup(options = {}) {
  const lines = [];
  let changes = 0;
  const hub = createSseHub({ log: (line) => lines.push(line) });
  const registry = createChannelRegistry({
    hub,
    clock: () => 1_000_000,
    log: (line) => lines.push(line),
    onChange: () => { changes += 1; },
    ...options,
  });
  return { hub, registry, lines, changes: () => changes };
}

test('переподключение того же pid закрывает прежний поток и оставляет один канал', () => {
  const { hub, registry } = setup();
  const first = new FakeRes();
  const second = new FakeRes();
  assert.equal(registry.connect(4242, req, first).status, 200);
  assert.equal(registry.connect(4242, req, second).status, 200);
  assert.equal(first.ended, true, 'прежний поток закрыт, иначе команды ушли бы в пустоту');
  assert.equal(registry.size, 1);
  assert.equal(hub.size, 1);
  assert.equal(registry.send(4242, { type: 'message', text: 'привет' }), true);
  assert.deepEqual(first.written.filter((line) => line.startsWith('data:')), []);
  assert.match(second.written.at(-1), /"text":"привет"/);
});

test('обрыв потока снимает канал и открытый запрос разрешения', () => {
  const { registry, changes } = setup();
  const res = new FakeRes();
  registry.connect(4242, req, res);
  assert.equal(registry.openPermission(4242, { request_id: 'abcde', tool_name: 'Bash' }).status, 204);
  assert.equal(registry.decorate({ processPid: 4242 }).permission?.requestId, 'abcde');
  const before = changes();
  res.emit('close');
  assert.equal(registry.has(4242), false);
  assert.equal(registry.decorate({ processPid: 4242 }).channel, false);
  assert.equal(registry.decorate({ processPid: 4242 }).permission, null);
  assert.equal(changes(), before + 1, 'борд узнаёт о пропавшем канале');
});

test('потолок каналов даёт 503 новому pid, но пускает переподключение известного', () => {
  const { registry } = setup({ maxChannels: 2 });
  registry.connect(1001, req, new FakeRes());
  registry.connect(1002, req, new FakeRes());
  assert.equal(registry.connect(1003, req, new FakeRes()).status, 503);
  assert.equal(registry.connect(1002, req, new FakeRes()).status, 200);
  assert.equal(registry.size, 2);
});

test('pid не число, ноль или единица отклоняются до открытия потока', () => {
  const { registry } = setup();
  const res = new FakeRes();
  assert.equal(registry.connect(NaN, req, res).status, 400);
  assert.equal(registry.connect(1, req, res).status, 400);
  assert.equal(res.written.length, 0);
  assert.equal(registry.size, 0);
});

test('запрос разрешения без канала или с чужим request_id отклоняется с записью в лог', () => {
  const { registry, lines } = setup();
  assert.equal(registry.openPermission(4242, { request_id: 'abcde' }).status, 409);
  registry.connect(4242, req, new FakeRes());
  assert.equal(registry.openPermission(4242, { request_id: 'new-format-123' }).status, 409);
  assert.ok(lines.some((line) => /request_id/.test(line)));
  assert.equal(registry.openPermission(4242, { request_id: 'abcde', description: 'x'.repeat(1000) }).status, 204);
  assert.equal(registry.decorate({ processPid: 4242 }).permission.description.length, 400, 'поля режутся по потолку');
});

test('settle: запрос без ожидания разрешения на карточке снимается после паузы, не раньше', () => {
  const { registry } = setup({ clock: () => 1000, settleMs: 3000 });
  registry.connect(4242, req, new FakeRes());
  registry.openPermission(4242, { request_id: 'abcde' });
  const working = [{ processPid: 4242, status: STATUS.WORKING }];
  registry.dropSettled(2000, working);
  assert.equal(registry.pendingFor(4242)?.requestId, 'abcde', 'до паузы порядок прихода событий не гарантирован');
  registry.dropSettled(4001, [{ processPid: 4242, status: STATUS.WAITING, reason: WAIT_REASON.PERMISSION }]);
  assert.equal(registry.pendingFor(4242)?.requestId, 'abcde', 'карточка ждёт разрешения: запрос живой');
  registry.dropSettled(4001, working);
  assert.equal(registry.pendingFor(4242), undefined, 'ответили в терминале');
});

test('вердикт закрывает запрос и уходит командой в поток', () => {
  const { registry } = setup();
  const res = new FakeRes();
  registry.connect(4242, req, res);
  registry.openPermission(4242, { request_id: 'abcde' });
  assert.equal(registry.send(4242, { type: 'permission', request_id: 'abcde', behavior: 'allow' }), true);
  registry.closePermission(4242);
  assert.equal(registry.pendingFor(4242), undefined);
  assert.match(res.written.at(-1), /"behavior":"allow"/);
  assert.equal(registry.send(9999, { type: 'message', text: 'нет канала' }), false);
});
