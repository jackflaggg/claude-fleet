/**
 * Чистый парсер кадров SSE со стороны читателя: чанки TCP режут кадр где угодно, и один
 * кадр может приехать по частям, а несколько - одним куском. Один парсер на одно соединение.
 * Используется процессом канала (`channel/fleet-channel.js`), у которого нет EventSource.
 */

/** Кадр без разделителя длиннее этого считаем мусором: буфер сбрасывается, поток живёт дальше. */
const DEFAULT_MAX_BUFFER = 64 * 1024;

/** Payload кадра: строки `data:` через перевод строки; комментарии, `event:` и `id:` не нужны. */
function frameData(frame) {
  const lines = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    // По спецификации после двоеточия допустим ровно один пробел, он не часть данных.
    const value = line.slice(5);
    lines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return lines.join('\n');
}

export function createSseFrameParser({ maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  let buffer = '';
  return {
    /** Принимает очередной чанк, возвращает payload'ы всех кадров, которые им закрылись. */
    push(chunk) {
      buffer += chunk;
      const payloads = [];
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const data = frameData(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (data) payloads.push(data);
      }
      if (buffer.length > maxBuffer) buffer = '';
      return payloads;
    },
  };
}
