export const STATUS_META = {
  ready:      { cls: 'ready', label: 'готов' },
  thinking:   { cls: 'busy',  label: 'думает' },
  tool:       { cls: 'busy',  label: 'работает' },
  working:    { cls: 'busy',  label: 'работает' },
  error:      { cls: 'error', label: 'ошибка' },
  compacting: { cls: 'busy',  label: 'сжимает контекст' },
};

export const WAIT_BADGE = {
  finished: 'закончил ход',
  permission: 'ждёт разрешения',
  question: 'нужен ответ',
  failed: 'сбой API',
};

const TERM_COLORS = {
  WebStorm: '#3fd0c9', IntelliJ: '#ff6f8e', PyCharm: '#f7d64c', PhpStorm: '#b06bff',
  GoLand: '#41d3e6', RubyMine: '#ff5d63', CLion: '#5be36f', DataGrip: '#8b7dff',
  Rider: '#ff54c8', Alacritty: '#a06cff', iTerm: '#48c96f', Terminal: '#9aa4b4',
  Warp: '#4d9dff', kitty: '#f7a94c', WezTerm: '#5be3a0', Ghostty: '#c299ff',
};

export const IDLE_MS = 4 * 60 * 1000;

export function termColor(terminal) {
  return TERM_COLORS[terminal] || 'var(--dim)';
}

/**
 * Секция борда для карточки. Красное значит «нужен ты», а закончить ход это не просьба
 * о помощи: сессия просто ждёт следующий промпт. Поэтому `finished` идёт в свою
 * нейтральную секцию, а в «ждут тебя», в счётчик favicon и в уведомления попадают только
 * разрешение, вопрос и сбой.
 */
export function sectionOf(card) {
  if (card?.status !== 'waiting') return 'busy';
  return card.reason === 'finished' ? 'done' : 'attn';
}
