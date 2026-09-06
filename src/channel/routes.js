/**
 * Четыре обработчика `/channel/*`: поток команд к процессу канала, запрос разрешения от
 * него, вердикт и текст с борда. Состояние в реестре, карточки приходят через `findCard`.
 */

import { readJson } from '../http/body.js';

/** Тело команды с борда: текст ответа, а не результат инструмента. */
const MAX_CHANNEL_BODY = 16 * 1024;
const MAX_CHANNEL_TEXT = 4000;

export function createChannelRoutes({ registry, findCard, broadcast }) {
  function commands(req, res, url) {
    const pid = Number(url.searchParams.get('pid'));
    const result = registry.connect(pid, req, res);
    if (result.status !== 200) res.writeHead(result.status).end(result.message);
  }

  async function permissionRequest(req, res) {
    const body = await readJson(req, MAX_CHANNEL_BODY);
    if (!body) {
      res.writeHead(400).end('плохое тело');
      return;
    }
    const result = registry.openPermission(Number(body.pid), body);
    res.writeHead(result.status).end(result.message);
  }

  /** Кнопка «Разрешить»/«Отказать» на карточке. */
  async function permissionVerdict(req, res, id) {
    const card = findCard(id);
    const pending = card && registry.pendingFor(card.processPid);
    if (!pending) {
      res.writeHead(409).end('запрос разрешения уже закрыт');
      return;
    }
    const body = await readJson(req, MAX_CHANNEL_BODY);
    if (!body) {
      res.writeHead(400).end('плохое тело');
      return;
    }
    const behavior = body.behavior === 'allow' ? 'allow' : body.behavior === 'deny' ? 'deny' : null;
    if (!behavior) {
      res.writeHead(400).end('behavior: allow | deny');
      return;
    }
    const sent = registry.send(card.processPid, { type: 'permission', request_id: pending.requestId, behavior });
    registry.closePermission(card.processPid);
    res.writeHead(sent ? 204 : 409).end();
    broadcast();
  }

  /** Строка ответа на карточке: текст уходит в сессию как следующий ход. */
  async function message(req, res, id) {
    const card = findCard(id);
    if (!card || !registry.has(card.processPid)) {
      res.writeHead(409).end('у сессии нет канала');
      return;
    }
    const body = await readJson(req, MAX_CHANNEL_BODY);
    if (!body) {
      res.writeHead(400).end('плохое тело');
      return;
    }
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_CHANNEL_TEXT) : '';
    if (!text) {
      res.writeHead(400).end('пустой текст');
      return;
    }
    const sent = registry.send(card.processPid, { type: 'message', text });
    res.writeHead(sent ? 204 : 409).end();
  }

  return { commands, permissionRequest, permissionVerdict, message };
}
