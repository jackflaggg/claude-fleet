/**
 * Сканер транскриптов для окна лимита. Окно одно на весь аккаунт, поэтому и состояние одно,
 * а не по сессии. Смещения по файлам нужны, чтобы после первого разбора дочитывать только
 * хвосты: на живых данных свежие транскрипты весят 44 МБ и разбираются 110 мс, а прирост
 * за минуту это десятки килобайт. Чистый разбор в `usage.js`, здесь только файлы.
 */

import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { collectStamps, foldStamps, isFreshTranscript } from './usage.js';

/**
 * Потолок на первое чтение незнакомого файла. Транскрипт долгой сессии доходит до 16 МБ,
 * такой читается целиком; лимит нужен, чтобы файл-патология не втянул в память сотни МБ.
 */
const DEFAULT_MAX_TAIL = 24 * 1024 * 1024;

/**
 * Единственный буфер чтения на весь процесс, аллоцируется один раз.
 *
 * Так и задумано: чтение потоком аллоцировало новый буфер на каждый кусок, и на 48 МБ свежих
 * транскриптов это давало 48 МБ мусора быстрее, чем GC успевал прибирать - RSS подскакивал
 * с 60 до 120 МБ. Сканы идут строго последовательно (флаг scanning), поэтому общий буфер
 * безопасен. Мегабайта хватает: в него должна помещаться одна запись транскрипта.
 * Буфер один на процесс, а не на экземпляр: два экземпляра в одном процессе бывают только
 * в тестах, и там скан ждут через await, то есть тоже последовательно.
 */
const READ_BUFFER = Buffer.allocUnsafe(1024 * 1024);

export function createUsageScanner({
  dir,
  windowMs,
  alignMs,
  log,
  clock = Date.now,
  onChange = () => {},
  maxTail = DEFAULT_MAX_TAIL,
}) {
  let window = null;
  let scanning = false;
  const offsets = new Map();

  /** Файлы, которые ещё могут содержать записи текущего окна (обход дерева стоит ~2 мс). */
  async function listFresh(now) {
    const fresh = [];
    let dirs;
    try {
      dirs = await readdir(dir, { withFileTypes: true });
    } catch {
      return fresh; // папки нет - Claude Code сюда не пишет, окно просто не показываем
    }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(dir, entry.name);
      let files;
      try {
        files = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const path = join(projectDir, file.name);
        try {
          const info = await stat(path);
          if (isFreshTranscript(info.mtimeMs, now, windowMs)) fresh.push({ path, size: info.size });
        } catch {
          // файл исчез между readdir и stat - обычное дело, сессия могла закончиться
        }
      }
    }
    return fresh;
  }

  /**
   * Дочитывает хвост одного транскрипта и складывает найденные метки в stamps.
   *
   * Читаем по кускам в общий буфер и разбираем его (см. collectStamps): в памяти живёт один
   * кусок плюс одна незавершённая строка, независимо от того, 16 МБ в файле или 200.
   * Ранняя остановка «дочитали до старых записей - хватит» тут не нужна: замерено, что почти
   * весь объём свежих транскриптов и так относится к последним десяти часам (48 МБ из 65).
   */
  async function readNewStamps(file, stamps) {
    const seen = offsets.get(file.path);
    // Файл короче запомненного смещения - его усекли или подменили: знакомимся заново.
    // Метки при этом посчитаются повторно и счётчик запросов в подсказке завысится; граница
    // окна (единственное, что стоит в шапке) не съедет - её задаёт самая ранняя метка.
    // Транскрипты только дописываются, так что случай редкий и цена ошибки копеечная.
    const stale = seen == null || seen > file.size;
    const from = stale ? Math.max(0, file.size - maxTail) : seen;
    if (from >= file.size) return;

    // Транскрипт дописывают прямо сейчас, поэтому хвост почти всегда обрывается на середине
    // строки. Незавершённый остаток переносим в следующий кусок и не учитываем в смещении -
    // дочитаем его следующим проходом, когда строка станет целой.
    let handle;
    let tail = 0; // байт незавершённой строки, перенесённых в начало буфера
    try {
      handle = await open(file.path, 'r');
      let position = from;
      while (position < file.size) {
        const { bytesRead } = await handle.read(READ_BUFFER, tail, READ_BUFFER.length - tail, position);
        if (!bytesRead) break;
        position += bytesRead;
        const view = READ_BUFFER.subarray(0, tail + bytesRead);
        const consumed = collectStamps(view, stamps);
        tail = view.length - consumed;
        // Незавершённую строку переносим в начало буфера и дочитываем следующим куском.
        if (tail > 0 && consumed > 0) READ_BUFFER.copy(READ_BUFFER, 0, consumed, view.length);
        // Одна запись длиннее всего буфера (в tool_response попадают большие файлы): дальше
        // копить некуда, роняем её и читаем дальше. Потеря одной метки границу окна не двигает -
        // её задаёт самая ранняя метка, а рядом всегда есть соседние записи.
        if (tail === READ_BUFFER.length) tail = 0;
      }
      offsets.set(file.path, file.size - tail);
    } catch {
      // нет доступа или файл пропал - окно переживёт пропуск одного транскрипта
    } finally {
      await handle?.close();
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const fresh = await listFresh(clock());
      // Реестр смещений не должен расти вечно: выпавшие из окна свежести файлы забываем,
      // иначе за месяцы работы в Map осядут тысячи путей давно закрытых сессий.
      const alive = new Set(fresh.map((file) => file.path));
      for (const path of offsets.keys()) {
        if (!alive.has(path)) offsets.delete(path);
      }

      const stamps = [];
      for (const file of fresh) await readNewStamps(file, stamps);

      const next = foldStamps(window, stamps, windowMs, alignMs);
      const changed = next?.start !== window?.start || next?.requests !== window?.requests;
      window = next;
      if (changed) onChange();
    } catch (error) {
      log(`окно лимита не пересчиталось: ${error.message}`);
    } finally {
      scanning = false;
    }
  }

  return {
    scan,
    get window() {
      return window;
    },
    /** Сколько транскриптов сейчас под наблюдением (для /stats). */
    get files() {
      return offsets.size;
    },
  };
}
