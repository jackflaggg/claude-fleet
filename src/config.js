import os from 'node:os';
import { join } from 'node:path';

/**
 * Конфиг процесса из окружения. Машинно-зависимые пути и настройки живут в .env, не в коде;
 * здесь единственное место, где имена переменных FLEET_* превращаются в значения. Тот же
 * loadConfig берёт канал ответа: пока порт читался в двух местах двумя способами, канал
 * повторял ошибку `Number(x) || 4319`, которую сервер уже вылечил.
 *
 * Чистая функция: окружение, лог и проверка существования файла приходят параметрами.
 */

/** Строка в переменной не задана или пуста: считаем «не задано», дефолт молча. */
function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

function text(env, name, fallback) {
  return isBlank(env[name]) ? fallback : String(env[name]);
}

/**
 * Число из окружения. Не задано - дефолт молча; задано, но не число или меньше min - дефолт
 * со строкой в лог. Прежний `Number(x) || 6` превращал FLEET_STALE_HOURS=0 в шесть часов,
 * и опечатка в конфиге не проявлялась ничем.
 */
function envNumber(env, log, name, fallback, min = Number.MIN_VALUE) {
  const raw = env[name];
  if (isBlank(raw)) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min) return value;
  log(`${name}=${raw}: ожидалось число не меньше ${min}, беру ${fallback}`);
  return fallback;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * @param {Record<string, string | undefined>} env обычно process.env
 * @param {object} deps
 * @param {(line: string) => void} deps.log куда писать про мусор в конфиге
 * @param {(path: string) => boolean} deps.exists проверка файла (лаунчер WebStorm)
 * @param {string} deps.root корень репозитория: дефолт персиста лежит рядом с server.js
 * @param {string} [deps.home] домашний каталог: дефолт папки транскриптов
 */
export function loadConfig(env, { log, exists, root, home = os.homedir() }) {
  const number = (name, fallback, min) => envNumber(env, log, name, fallback, min);

  // Лаунчер WebStorm фокусит окно нужного проекта, если он открыт; путь установки отличается
  // между машинами (/usr/local vs homebrew), поэтому проверяем существование на старте.
  const launcher = text(env, 'FLEET_WEBSTORM', '');

  return Object.freeze({
    port: number('FLEET_PORT', 4319, 1),
    host: text(env, 'FLEET_HOST', '127.0.0.1'),
    /** Доп. значения заголовка Host через запятую (борд с планшета); списки строит guards.js. */
    extraHosts: text(env, 'FLEET_ALLOWED_HOSTS', ''),
    /** Персист настраиваемый ради тестов: они поднимают настоящий server.js и не должны затирать живой. */
    stateFile: text(env, 'FLEET_STATE_FILE', join(root, '.fleet-state.json')),
    staleMs: number('FLEET_STALE_HOURS', 6) * HOUR,
    /** Куда более короткий порог для карточек без задачи и без инструмента (isBlank в state.js). */
    blankMs: number('FLEET_BLANK_MINUTES', 15) * MINUTE,
    transcriptsDir: text(env, 'FLEET_TRANSCRIPTS', join(home, '.claude', 'projects')),
    /** Пять часов это свойство тарифа, а не наше решение. */
    usageWindowMs: number('FLEET_USAGE_HOURS', 5) * HOUR,
    /** Старт окна выравнивается вниз до получаса (сверено с /usage); 0 выключает. */
    usageAlignMs: number('FLEET_USAGE_ALIGN_MIN', 30, 0) * MINUTE,
    webstormLauncher: launcher && exists(launcher) ? launcher : null,
    webstormApp: text(env, 'FLEET_WEBSTORM_APP', 'WebStorm'),
    /** Прототип ответа с борда: без флага ни маршрутов /channel/*, ни полей в снимке. */
    channelEnabled: env.FLEET_CHANNEL === '1',
  });
}

/**
 * Подгружает .env в process.env: Node 22 читает файл без зависимостей, уже заданные
 * переменные не перебивает. Файла нет - дефолты; битый - дефолты и строка в лог.
 */
export function applyEnvFile(file, { log, exists, load = (path) => process.loadEnvFile(path) }) {
  if (!exists(file)) return false;
  try {
    load(file);
    return true;
  } catch (error) {
    log(`${file} не прочитался (${error.message}), работаю на дефолтах`);
    return false;
  }
}
