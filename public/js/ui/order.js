/**
 * Порядок и раскладка борда: чистые сравнения и разбиение снимка по секциям.
 * Сервер сортировкой не занимается, снимок приходит целиком; всё, что решает, где и в каком
 * порядке стоит карточка, живёт здесь и гоняется `node --test` без DOM.
 */
import { AGENT_ORDER } from '../board-config.js';
import { SECTION, agentOf, sectionOf } from '../lib/domain.js';

/* строки: проект → агент → старшая сессия выше. Порядок по UUID был случайным и менялся
   с каждой новой сессией */
export function rowOrder(a, b) {
  return String(a.project || '').localeCompare(String(b.project || ''))
    || AGENT_ORDER.indexOf(agentOf(a)) - AGENT_ORDER.indexOf(agentOf(b))
    || (a.createdAt || 0) - (b.createdAt || 0)
    || String(a.sessionId).localeCompare(String(b.sessionId));
}

// кто дольше ждёт, тот выше: разбираешь самое залежавшееся, и появление новой карточки
// не сдвигает те, что уже в списке
export function waitOrder(a, b) {
  return (a.waitingSince || a.updatedAt || 0) - (b.waitingSince || b.updatedAt || 0);
}

/**
 * Ключ скелета секций: меняется только вместе с их составом, а не с каждым событием.
 * Четвёртый флаг это плашка «никто не ждёт»: она стоит, когда сессии есть, а красных нет.
 */
export function layoutKey({ waiting, done, busy, total }) {
  return JSON.stringify([waiting > 0, done > 0, busy > 0, total > 0 && waiting === 0]);
}

/**
 * Три секции из снимка, уже отсортированные: красное «ждут тебя» (разрешение, вопрос,
 * сбой), нейтральное «закончили ход» (Stop: сессия стоит без промпта, но помощи не просит)
 * и строки «в работе».
 */
export function splitSections(list) {
  const cards = Array.isArray(list) ? list : [];
  return {
    waiting: cards.filter((c) => sectionOf(c) === SECTION.ATTN).sort(waitOrder),
    done: cards.filter((c) => sectionOf(c) === SECTION.DONE).sort(waitOrder),
    busy: cards.filter((c) => sectionOf(c) === SECTION.BUSY).sort(rowOrder),
  };
}
