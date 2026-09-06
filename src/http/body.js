/**
 * Чтение тела запроса с потолком. Общее для событий хука и команд канала.
 */

/**
 * Событие крупнее этого отбрасываем целиком: JSON нельзя распарсить по кусочку. Четыре
 * мегабайта, а не один: в fleet.log 03.09 два PostToolUse по 1.0 и 1.3 МБ (tool_response
 * с большим файлом) были отброшены, и карточка залипла на прошлом статусе до следующего тула.
 */
export const MAX_BODY = 4 * 1024 * 1024;
/** А это уже не наш хук, а чей-то поток без конца - рвём соединение, не дочитывая. */
export const HARD_BODY_LIMIT = 32 * 1024 * 1024;

export async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    // Событие с содержимым большого файла в tool_response может весить сотни КБ.
    // Сверх лимита в память не копим, но поток дочитываем: оборвать его - значит
    // разрушить сокет, и отправитель не получит внятный ответ, а просто увидит обрыв.
    if (size > limit) {
      overflow = true;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) throw new Error(`тело события ${size} байт при лимите ${limit}`);
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON из тела с потолком; мусор или переполнение дают null, а не исключение. */
export async function readJson(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit));
  } catch {
    return null;
  }
}
