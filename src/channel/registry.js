/**
 * Реестр каналов ответа: pid процесса агента -> открытый SSE-поток к процессу канала (handle
 * хаба) плюс открытый запрос разрешения по тому же pid. Ключ тот же, что у карточки
 * (`processPid`), так карточка и канал находят друг друга без общего id: процесс канала знает
 * только своего родителя (`process.ppid`), а hook-команда - своего. В состоянии карточек этого
 * нет намеренно: канал живёт ровно столько, сколько соединение.
 *
 * Без IO: поток даёт хаб, время приходит из `clock`, карточки для settle передаются параметром.
 */

import { isAskingPermission } from '../../public/js/lib/domain.js';

/** Каналов не больше, чем живых сессий; потолок страхует Map от роста при бесконечных реконнектах. */
export const MAX_CHANNELS = 64;
/**
 * Запрос разрешения, на который карточка так и не встала в ожидание, считаем закрытым
 * в терминале. Пауза нужна из-за порядка событий: уведомление канала и hook-событие
 * идут разными путями, и любое из них может прийти первым.
 */
export const PERMISSION_SETTLE_MS = 3000;
/**
 * Форма request_id, которую Claude Code отдавал каналу на момент прототипа: пять строчных
 * букв. Это наблюдение, а не контракт, поэтому отказ по нему обязан попадать в лог: иначе
 * смена формата в новой версии выглядит как «кнопки разрешения просто не появляются».
 */
export const REQUEST_ID_RE = /^[a-km-z]{5}$/;

export function createChannelRegistry({
  hub,
  clock = Date.now,
  log = () => {},
  onChange = () => {},
  maxChannels = MAX_CHANNELS,
  settleMs = PERMISSION_SETTLE_MS,
}) {
  const channels = new Map();
  /** pid -> открытый запрос разрешения из Claude Code, пока борд или терминал не ответили. */
  const pending = new Map();

  /** Единственное место, где канал уходит из реестра: вместе со своим запросом разрешения. */
  function forget(pid) {
    channels.delete(pid);
    pending.delete(pid);
  }

  /** Процесс канала держит этот поток открытым всю жизнь сессии; команды борда идут по нему. */
  function connect(pid, req, res) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return { status: 400, message: 'нужен pid' };
    if (!channels.has(pid) && channels.size >= maxChannels) return { status: 503, message: 'слишком много каналов' };
    const previous = channels.get(pid);
    const handle = hub.open(req, res, 'fleet channel', {
      onClose: () => {
        // Прежний поток того же pid уже вытеснен: его закрытие реестр не трогает.
        if (channels.get(pid)?.handle !== handle) return;
        forget(pid);
        onChange();
      },
    });
    channels.set(pid, { handle, since: clock() });
    // Переподключение того же процесса: прежний поток закрываем, иначе команды уйдут в пустоту.
    // Новый handle уже в реестре, поэтому onClose прежнего его не снимет.
    if (previous) hub.end(previous.handle);
    log(`канал подключён: pid ${pid}`);
    onChange();
    return { status: 200 };
  }

  function send(pid, command) {
    const channel = channels.get(pid);
    if (!channel) return false;
    return hub.write(channel.handle, `data: ${JSON.stringify(command)}\n\n`);
  }

  /** Claude Code открыл диалог разрешения и отдал его каналу; тот пересылает сюда. */
  function openPermission(pid, body) {
    const requestId = String(body?.request_id ?? '');
    if (!channels.has(pid)) return { status: 409, message: 'канал не подключён' };
    if (!REQUEST_ID_RE.test(requestId)) {
      log(`запрос разрешения отклонён: request_id «${requestId.slice(0, 40)}» не похож на формат Claude Code, обновился формат?`);
      return { status: 409, message: 'плохой request_id' };
    }
    pending.set(pid, {
      requestId,
      toolName: String(body.tool_name ?? '').slice(0, 80),
      description: String(body.description ?? '').slice(0, 400),
      inputPreview: String(body.input_preview ?? '').slice(0, 1200),
      at: clock(),
    });
    onChange();
    return { status: 204 };
  }

  function pendingFor(pid) {
    return pending.get(pid);
  }

  function closePermission(pid) {
    pending.delete(pid);
  }

  /**
   * Запрос разрешения, который закрыли в терминале, нам никто не сообщит: Claude Code шлёт
   * каналу только открытие. Признак - карточка не стоит (или уже не стоит) в ожидании
   * разрешения, с паузой на разный порядок прихода уведомления и hook-события.
   */
  function dropSettled(now, cards) {
    if (!pending.size) return;
    const byPid = new Map();
    for (const card of cards) {
      if (Number.isSafeInteger(card?.processPid)) byPid.set(card.processPid, card);
    }
    for (const [pid, request] of pending) {
      if (now - request.at < settleMs) continue;
      if (!isAskingPermission(byPid.get(pid))) pending.delete(pid);
    }
  }

  /** Карточка для снимка борда: есть ли канал и что за разрешение открыто. */
  function decorate(card) {
    const pid = card.processPid;
    const request = pending.get(pid);
    return {
      ...card,
      channel: channels.has(pid),
      permission: request
        ? { requestId: request.requestId, toolName: request.toolName, description: request.description, inputPreview: request.inputPreview }
        : null,
    };
  }

  return {
    connect,
    send,
    has: (pid) => channels.has(pid),
    get size() {
      return channels.size;
    },
    openPermission,
    pendingFor,
    closePermission,
    dropSettled,
    decorate,
    forget,
  };
}
