/**
 * Словарь домена: статусы, причины ожидания, агенты и раскладка по секциям борда.
 * Единственное место, где эти строки существуют как литералы: сервер (`state.js`,
 * `server.js`) и борд (`board-config.js`, `ui/*`) сравнивают только с этими константами.
 * Лежит в `public/js/lib`, потому что нужен обеим сторонам и не зависит ни от DOM, ни от IO.
 */

export const AGENT = {
  CLAUDE: 'claude',
  CODEX: 'codex',
};

export const STATUS = {
  READY: 'ready',
  THINKING: 'thinking',
  TOOL: 'tool',
  WORKING: 'working',
  ERROR: 'error',
  WAITING: 'waiting',
  COMPACTING: 'compacting',
};

/** Причина, по которой сессия стоит (только для STATUS.WAITING). */
export const WAIT_REASON = {
  FINISHED: 'finished', // закончил ход, нужен следующий промпт: не зовёт
  PERMISSION: 'permission', // просит разрешение на инструмент
  QUESTION: 'question', // ждёт ответ на вопрос (AskUserQuestion / план / простой)
  FAILED: 'failed', // ход оборвался ошибкой API (StopFailure), сессия встала сама
};

/** Секции борда: красные карточки, нейтральные карточки, строки. */
export const SECTION = {
  ATTN: 'attn',
  DONE: 'done',
  BUSY: 'busy',
};

/**
 * Статусы, при которых сессия что-то делает. Без событий дольше IDLE_MS борд подсвечивает
 * такую строку «нет активности»; готовность и ожидание законно стоят сколько угодно.
 */
export const ACTIVE_STATUSES = new Set([
  STATUS.THINKING,
  STATUS.TOOL,
  STATUS.WORKING,
  STATUS.ERROR,
  STATUS.COMPACTING,
]);

/** Агент карточки. Всё, что не помечено Codex явно, это Claude: так читается и старый персист. */
export function agentOf(card) {
  return card?.agent === AGENT.CODEX ? AGENT.CODEX : AGENT.CLAUDE;
}

/**
 * Секция борда для карточки. Красное значит «нужен ты», а закончить ход это не просьба
 * о помощи: сессия просто ждёт следующий промпт. Поэтому `finished` идёт в свою
 * нейтральную секцию, а в «ждут тебя», в счётчик favicon и в уведомления попадают только
 * разрешение, вопрос и сбой. Нераспознанная причина - красное: лучше позвать зря, чем спрятать.
 */
export function sectionOf(card) {
  if (card?.status !== STATUS.WAITING) return SECTION.BUSY;
  return card.reason === WAIT_REASON.FINISHED ? SECTION.DONE : SECTION.ATTN;
}

export function isAttention(card) {
  return sectionOf(card) === SECTION.ATTN;
}

/** Карточка стоит на открытом диалоге разрешения: по ней канал держит pending-запрос. */
export function isAskingPermission(card) {
  return card?.status === STATUS.WAITING && card.reason === WAIT_REASON.PERMISSION;
}
