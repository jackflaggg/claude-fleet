import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, startServer } from './helpers/fleet-process.js';

/*
 * Сквозной прогон канала ответа с борда: настоящий server.js плюс настоящий процесс
 * channel/fleet-channel.js, с которым мы играем Claude Code по stdio (MCP, JSON-RPC построчно).
 * Повторяет ручной прогон из CLAUDE.md: initialize с capability → канал в /stats →
 * permission_request доходит до карточки → вердикт и текст уходят в stdout уведомлениями →
 * закрытие stdin завершает процесс.
 *
 * Канал привязывается к карточке по process.ppid, а его родитель здесь - процесс этого
 * теста, поэтому карточка получает X-Fleet-Pid равный process.pid.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL = join(ROOT, 'channel', 'fleet-channel.js');
const SDK_INSTALLED = existsSync(join(ROOT, 'channel', 'node_modules', '@modelcontextprotocol', 'sdk'));
const SESSION = 'e2e-channel';

function startChannel(port) {
  const child = spawn(process.execPath, [CHANNEL], {
    env: { ...process.env, FLEET_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = [];
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  /** Ждёт сообщение из stdout канала, подходящее под предикат. */
  const next = (predicate, what, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`канал не прислал ${what}; stderr: ${stderr}`)), timeoutMs);
    const check = () => {
      const found = messages.find(predicate);
      if (!found) {
        waiters.push(check);
        return;
      }
      clearTimeout(deadline);
      resolve(found);
    };
    check();
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, send, next, exited, stderr: () => stderr };
}

async function until(probe, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`не дождались: ${what}`);
}

test(
  'канал: initialize, карточка, запрос разрешения, вердикт, текст, выход по stdin',
  { skip: !SDK_INSTALLED && 'в channel/ не установлен SDK (npm ci --prefix channel)' },
  async () => {
    const fleet = await startServer();
    const channel = startChannel(fleet.port);
    try {
      channel.send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      });
      const init = await channel.next((m) => m.id === 1, 'ответ на initialize');
      assert.ok(init.result?.capabilities?.experimental?.['claude/channel'], 'capability claude/channel');
      assert.ok(init.result?.capabilities?.experimental?.['claude/channel/permission'], 'capability claude/channel/permission');
      channel.send({ method: 'notifications/initialized' });

      await until(async () => (await fleet.stats()).channels === 1, 'канал в /stats');

      // карточка сессии, к которой канал привязан по PID
      const pid = { 'X-Fleet-Pid': String(process.pid) };
      await fleet.event({ session_id: SESSION, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/e2e', prompt: 'задача' }, pid);
      await fleet.event({
        session_id: SESSION, hook_event_name: 'Notification', cwd: '/tmp/e2e',
        notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash',
      }, pid);
      let card = await until(async () => (await fleet.snapshot()).sessions.find((c) => c.sessionId === SESSION && c.channel), 'карточка с каналом');
      assert.equal(card.permission, null);

      // Claude Code открыл диалог разрешения и отдал его каналу
      channel.send({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: 'abcde', tool_name: 'Bash', description: 'выполнить ls', input_preview: 'ls -la' },
      });
      card = await until(async () => (await fleet.snapshot()).sessions.find((c) => c.sessionId === SESSION && c.permission), 'запрос разрешения на карточке');
      assert.deepEqual(card.permission, { requestId: 'abcde', toolName: 'Bash', description: 'выполнить ls', inputPreview: 'ls -la' });

      // кнопка «Разрешить» на карточке
      const verdict = await fetch(`${fleet.base}/channel/permission/${SESSION}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ behavior: 'allow' }),
      });
      assert.equal(verdict.status, 204);
      const permission = await channel.next((m) => m.method === 'notifications/claude/channel/permission', 'вердикт');
      assert.deepEqual(permission.params, { request_id: 'abcde', behavior: 'allow' });
      const again = await fetch(`${fleet.base}/channel/permission/${SESSION}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ behavior: 'deny' }),
      });
      assert.equal(again.status, 409, 'повторный вердикт: запрос уже закрыт');

      // строка ответа на карточке
      const reply = await fetch(`${fleet.base}/channel/message/${SESSION}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'продолжай' }),
      });
      assert.equal(reply.status, 204);
      const message = await channel.next((m) => m.method === 'notifications/claude/channel', 'текст с борда');
      assert.deepEqual(message.params, { content: 'продолжай', meta: { origin: 'board' } });

      // сессия закрылась: stdin закрыт, канал уходит сам, открытый SSE его не держит
      channel.child.stdin.end();
      const code = await Promise.race([channel.exited, sleep(2000).then(() => 'timeout')]);
      assert.equal(code, 0, `канал должен выйти по закрытию stdin, а он: ${code}; stderr: ${channel.stderr()}`);
      await until(async () => (await fleet.stats()).channels === 0, 'канал снят с учёта после выхода');
    } finally {
      if (channel.child.exitCode === null) channel.child.kill();
      await fleet.stop();
    }
  },
);
