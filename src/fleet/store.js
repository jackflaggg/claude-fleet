/**
 * Персист карточек: страховка на рестарт сервера, не история. Файл живёт ровно до ребута:
 * записанный до загрузки системы файл значит, что все прежние сессии мертвы.
 *
 * Формат `{ schema: 2, sessions }`. Первый формат был голой картой карточек без версии, и
 * миграции (агент по умолчанию, возраст) жили в `applyEvent`; теперь старый файл мигрирует
 * здесь один раз при загрузке, а ядро состояния о старом формате не знает.
 *
 * fs, время и момент загрузки приходят параметрами: тесты гоняют store на fake fs.
 */

import * as nodeFs from 'node:fs';
import { pruneStale } from './state.js';
import { AGENT } from '../../public/js/lib/domain.js';

export const SCHEMA = 2;

/** Персист откладывается: шторм событий иначе писал бы файл на каждое. */
const DEFAULT_DEBOUNCE_MS = 500;

/** Голая карта карточек (schema 1): агент по умолчанию Claude, возраст от последнего события. */
function migrateLegacy(cards) {
  const sessions = {};
  for (const [id, card] of Object.entries(cards)) {
    if (!card || typeof card !== 'object') continue;
    sessions[id] = {
      ...card,
      agent: card.agent ?? AGENT.CLAUDE,
      createdAt: card.createdAt ?? card.updatedAt ?? null,
    };
  }
  return sessions;
}

function unpack(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  if (parsed.schema === SCHEMA) return parsed.sessions ?? {};
  return migrateLegacy(parsed);
}

export function createSessionStore({
  file,
  log,
  clock = Date.now,
  fs = nodeFs,
  bootMs,
  staleMs,
  blankMs,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  let timer = null;
  let pending = null;

  /**
   * Восстанавливает состояние с диска, но только если файл записан ПОСЛЕ последней загрузки
   * системы. Дополнительно отсекает карточки старше staleMs (пустые - старше blankMs), теми
   * же порогами, что и рантайм-уборка зомби.
   */
  function load() {
    let raw;
    try {
      if (fs.statSync(file).mtimeMs < bootMs) return {};
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return {}; // файла нет: первый запуск или чистый старт после ребута
    }
    try {
      return pruneStale(unpack(JSON.parse(raw)), clock(), staleMs, blankMs);
    } catch (error) {
      // Обрезанный или чужой файл: карточки пропали не молча, причина в логе.
      log(`состояние с диска не прочитано (${error.message}), начинаю с пустого`);
      return {};
    }
  }

  /** Пишет немедленно: временный файл плюс rename, права 0600 (в файле промпты и команды). */
  function flush(sessions = pending) {
    pending = null;
    if (!sessions) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, sessions }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      // персист не критичен, борд работает и без него, но причина должна быть видна
      log(`состояние не записано: ${error.message}`);
    }
  }

  /** Откладывает запись; пишется последнее переданное состояние. */
  function schedule(sessions) {
    pending = sessions;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
  }

  function close() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  }

  return { load, schedule, flush, close };
}
