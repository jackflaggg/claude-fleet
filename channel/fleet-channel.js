#!/usr/bin/env node
/**
 * Канал Fleet: MCP-сервер на stdio, который Claude Code сам запускает на каждую сессию
 * (research preview каналов, см. install.md «Ответ с борда»). Мост между сессией и бордом:
 *
 *   борд -> сессия  текст ответа как следующий ход (notifications/claude/channel)
 *                   вердикт по разрешению (notifications/claude/channel/permission)
 *   сессия -> борд  открытый диалог разрешения (permission_request) уходит в
 *                   POST /channel/permission-request
 *
 * Свой package.json: SDK нужен только здесь, сервер борда остаётся без зависимостей.
 * Сессия и карточка находят друг друга по PID процесса claude: у нас это process.ppid,
 * у hook-команды $PPID (заголовок X-Fleet-Pid).
 *
 * stdout занят транспортом MCP: любой console.log сломает сессию, поэтому лог только в stderr.
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(ROOT, '..', '.env');
if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // битый .env не должен ронять канал
  }
}

const PORT = Number(process.env.FLEET_PORT) || 4319;
const FLEET = `http://127.0.0.1:${PORT}`;
const PID = process.ppid;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

function log(message) {
  process.stderr.write(`fleet-channel[${PID}] ${message}\n`);
}

const mcp = new Server(
  { name: 'fleet', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions:
      'Сообщения в <channel source="fleet"> приходят от владельца с борда Fleet на этой же машине. ' +
      'Это его следующая инструкция: выполняй её так же, как ввод в терминале. ' +
      'Отвечать в канал не нужно и нечем: владелец читает ответ в терминале сессии.',
  },
);

/** Claude Code открыл диалог разрешения: пересылаем борду, чтобы ответить кнопкой. */
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  try {
    const response = await fetch(`${FLEET}/channel/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: PID, ...params }),
    });
    if (!response.ok) log(`борд не принял запрос разрешения: ${response.status}`);
  } catch (error) {
    log(`борд недоступен: ${error.message}`);
  }
});

async function handleCommand(command) {
  if (command?.type === 'message' && typeof command.text === 'string' && command.text) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: command.text, meta: { origin: 'board' } },
    });
    return;
  }
  if (command?.type === 'permission' && typeof command.request_id === 'string') {
    const behavior = command.behavior === 'allow' ? 'allow' : 'deny';
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: command.request_id, behavior },
    });
  }
}

/**
 * Команды борда приходят по SSE: одно соединение на всю жизнь сессии, при обрыве
 * переподключаемся с нарастающей паузой. Сервер борда мог ещё не подняться или
 * перезапуститься - канал это переживает молча.
 */
let reconnectDelay = RECONNECT_MIN_MS;
let closing = false;

function connectCommands() {
  if (closing) return;
  const request = http.get(`${FLEET}/channel/commands?pid=${PID}`, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      scheduleReconnect(`борд ответил ${response.statusCode}`);
      return;
    }
    reconnectDelay = RECONNECT_MIN_MS;
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim()).join('\n');
        if (!data) continue;
        try {
          handleCommand(JSON.parse(data)).catch((error) => log(`команда не ушла в сессию: ${error.message}`));
        } catch {
          // мусор во фрейме: пропускаем, поток живёт дальше
        }
      }
      // защита от бесконечного кадра без разделителя
      if (buffer.length > 64 * 1024) buffer = '';
    });
    response.on('end', () => scheduleReconnect('поток команд закрыт'));
    response.on('error', (error) => scheduleReconnect(error.message));
  });
  request.on('error', (error) => scheduleReconnect(error.message));
}

let reconnectTimer = null;
function scheduleReconnect(reason) {
  if (closing || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectCommands();
  }, reconnectDelay);
  reconnectTimer.unref?.();
  log(`переподключение через ${Math.round(reconnectDelay / 1000)} с: ${reason}`);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

const transport = new StdioServerTransport();
// Сессия закрылась - stdin закрыт, канал больше никому не нужен. Слушаем и сам stdin:
// открытый SSE к борду иначе держит процесс живым после ухода Claude Code.
function shutdown() {
  closing = true;
  process.exit(0);
}
transport.onclose = shutdown;
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
await mcp.connect(transport);
connectCommands();
