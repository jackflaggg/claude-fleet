/**
 * Хаб SSE-клиентов: заголовки, TCP keepalive, общий heartbeat, защита от нечитающего
 * клиента и коалесцируемая рассылка. Борды и процессы канала это два экземпляра одного хаба:
 * жизненный цикл у них один, различаются только адресаты записи.
 *
 * Клиент, который перестал читать (вкладка на уснувшем планшете, half-open TCP), не роняет
 * `res.write`, а копит данные в памяти процесса: замерено +203 МБ RSS за 6000 событий.
 * Буфер выше `maxBuffered` значит «клиент мёртв»: сокет рвём, EventSource переподключится сам.
 * Клиент снимается с учёта синхронно, в момент решения, а не по событию `close`: иначе
 * следующая же рассылка в том же тике снова писала бы в мёртвый сокет.
 */

const DEFAULTS = Object.freeze({
  maxBuffered: 1024 * 1024,
  keepAliveMs: 30_000,
  heartbeatMs: 25_000,
  debounceMs: 50,
});

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
});

export function createSseHub(options = {}) {
  const { log = () => {}, maxBuffered, keepAliveMs, heartbeatMs, debounceMs } = { ...DEFAULTS, ...options };
  const clients = new Set();
  let heartbeat = null;
  let debounceTimer = null;
  let pendingProduce = null;
  let closed = false;

  /** Снимает клиента с учёта ровно один раз; `onClose` при этом тоже зовётся один раз. */
  function drop(handle) {
    if (handle.dropped) return;
    handle.dropped = true;
    clients.delete(handle);
    if (!clients.size) stopHeartbeat();
    handle.onClose?.();
  }

  function write(handle, data) {
    if (handle.dropped) return false;
    const { res } = handle;
    if (res.writableLength > maxBuffered) {
      log(`SSE-клиент не читает (${res.writableLength} байт в буфере), отключаю`);
      drop(handle);
      res.destroy();
      return false;
    }
    try {
      res.write(data);
      return true;
    } catch {
      drop(handle);
      res.destroy();
      return false;
    }
  }

  /** Один таймер на хаб, а не на клиента; без клиентов не тикает вовсе. */
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => broadcastNow(': ping\n\n'), heartbeatMs);
    heartbeat.unref?.();
  }

  function stopHeartbeat() {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function open(req, res, comment, { onClose } = {}) {
    const handle = { res, onClose, dropped: false };
    res.writeHead(200, SSE_HEADERS);
    // Мёртвый пир закрывается сам, а не висит в реестре до следующей записи.
    req.socket.setKeepAlive(true, keepAliveMs);
    clients.add(handle);
    const cleanup = () => drop(handle);
    // Без обработчика 'error' сбой SSE-сокета всплыл бы необработанным исключением процесса.
    res.on('close', cleanup);
    res.on('error', cleanup);
    startHeartbeat();
    write(handle, `: ${comment}\n\n`);
    return handle;
  }

  /** Аккуратно закрывает одного клиента: прежний поток того же процесса канала. */
  function end(handle) {
    drop(handle);
    try {
      handle.res.end();
    } catch {
      // уже закрыт
    }
  }

  function broadcastNow(data) {
    for (const handle of [...clients]) write(handle, data);
  }

  /**
   * Снимок уходит не сразу, а пачкой за `debounceMs`: шторм событий хука иначе давал снимок
   * всего состояния на каждое событие (замерено 123 МБ на борд за 6000 событий). Payload
   * вычисляется один раз на пачку и только если есть кому его отдать.
   */
  function broadcast(produce) {
    if (closed) return;
    pendingProduce = produce;
    if (debounceTimer) return;
    debounceTimer = setTimeout(flush, debounceMs);
  }

  function flush() {
    debounceTimer = null;
    const produce = pendingProduce;
    pendingProduce = null;
    if (!clients.size || !produce) return;
    broadcastNow(produce());
  }

  function close() {
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingProduce = null;
    for (const handle of [...clients]) end(handle);
    stopHeartbeat();
  }

  return {
    open,
    write,
    end,
    broadcast,
    broadcastNow,
    close,
    get size() {
      return clients.size;
    },
  };
}
