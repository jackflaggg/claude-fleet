/**
 * Ограничители сервера: кто имеет право обращаться к борду и сколько он может накопить
 * в памяти. Вынесено отдельным чистым модулем, потому что оба ограничения коварны
 * одинаково - если их снять, ничего не сломается на вид: борд продолжит работать,
 * просто наружу утечёт содержимое сессий или процесс начнёт пухнуть.
 *
 * Побочных эффектов нет, всё нужное приходит параметрами - как now в state.js.
 */

/**
 * Списки разрешённых Host и Origin. Origin выводится из тех же хостов, а НЕ из
 * захардкоженного localhost: иначе борд, открытый с планшета через FLEET_ALLOWED_HOSTS,
 * показывался бы (Host проходит), но любой клик по карточке и удаление получали 403 -
 * isCrossSite не узнавал собственную же страницу и считал её чужой.
 *
 * @param {object} config
 * @param {string} config.host хост привязки (FLEET_HOST)
 * @param {number|string} config.port порт сервера
 * @param {string} [config.extraHosts] значения FLEET_ALLOWED_HOSTS через запятую
 */
export function buildAllowLists({ host, port, extraHosts = '' }) {
  const extra = String(extraHosts || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  const hosts = new Set([
    `${host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    ...extra,
  ]);

  // Схему допускаем и http, и https: борд отдаётся по http, но за реверс-прокси страница
  // может приехать по https, и тогда её собственный Origin тоже должен считаться своим.
  // Защита тут держится на списке хостов, а не на схеме.
  const origins = new Set();
  for (const h of hosts) {
    origins.add(`http://${h}`);
    origins.add(`https://${h}`);
  }

  return { hosts, origins };
}

/**
 * Защита от DNS rebinding. Браузер обязан слать Host, и при ребайнде там будет чужой домен
 * (evil.com), а не localhost - хотя пакет придёт на 127.0.0.1. Без этой проверки любая
 * открытая вкладка может прочитать /stream, а там все промпты, пути проектов и команды Bash.
 */
export function isAllowedHost(headers, hosts) {
  const host = headers?.host;
  return typeof host === 'string' && hosts.has(host);
}

/**
 * Отсекает запросы, инициированные чужой страницей. Host-проверка ловит rebinding, но не
 * обычный CSRF: сайт может честно постить на http://127.0.0.1:4319 и Host будет верным.
 * report.sh ходит через curl - у него нет ни Sec-Fetch-Site, ни Origin, поэтому он проходит.
 */
export function isCrossSite(headers, origins) {
  const site = headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = headers?.origin;
  return typeof origin === 'string' && origin !== '' && !origins.has(origin);
}

/** Имя cookie с токеном доверия; её ставит вход по ссылке `/?token=<FLEET_TOKEN>`. */
export const TOKEN_COOKIE = 'fleet_token';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Разбор заголовка Cookie в плоский объект: пары через `;`, значение после первого `=`
 * (в нём самом `=` допустим), percent-encoding снимается, битое оставляется сырым.
 * Пары без имени или без `=` пропускаются. Без побочных эффектов.
 *
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const cookies = {};
  if (typeof header !== 'string' || header === '') return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // оставляем как есть: мусор в cookie не должен ронять запрос
    }
    cookies[name] = value;
  }
  return cookies;
}

/** Сравнение без ранней остановки: время ответа не выдаёт, сколько символов совпало. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Кому верим сверх проверок Host и Origin. Loopback всегда свой: борд на этой же машине,
 * report.sh и процесс канала ходят оттуда и токена не знают. Токен не задан - поведение
 * прежнее, доступ из сети решает FLEET_ALLOWED_HOSTS. Токен задан - запрос не с loopback
 * доверен только с cookie `fleet_token=<token>`: иначе любой в LAN, узнавший адрес,
 * читал бы /stream со всеми промптами. Адрес сокета неизвестен - считаем чужим.
 *
 * @param {string | undefined} remoteAddress адрес сокета (`req.socket.remoteAddress`)
 * @param {Record<string, string>} cookies результат parseCookies
 * @param {string} token FLEET_TOKEN, пустая строка = выключено
 */
export function isTrustedPeer(remoteAddress, cookies, token) {
  if (!token) return true;
  if (typeof remoteAddress === 'string' && LOOPBACK.has(remoteAddress)) return true;
  return sameSecret(cookies?.[TOKEN_COOKIE], token);
}

/** Куда сваливаем всё, что не влезло в лимит числа ключей. */
export const OTHER_KIND = 'прочие';
/** Длиннее имя в ключ не пишем: строку-счётчик всё равно никто не прочитает целиком. */
const MAX_KEY_LENGTH = 40;

/**
 * Ключ для счётчика с ограниченным числом строк. Возвращает само имя, пока ключей меньше
 * лимита, иначе OTHER_KIND. Нужно, потому что поток событий с уникальными именами (кривой
 * хук, чужой софт на том же порту) иначе раздувает Map без предела: замерено, 3000 разных
 * имён стоили ~12 МБ RSS. Больше десятка типов в диагностике всё равно не читаемо.
 */
export function boundedKey(map, rawName, limit) {
  const name = String(rawName).slice(0, MAX_KEY_LENGTH);
  if (map.has(name) || map.size < limit) return name;
  return OTHER_KIND;
}
