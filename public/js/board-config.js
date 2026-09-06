import { AGENT, STATUS, WAIT_REASON } from './lib/domain.js';

/* Подписи и классы бейджа для строк «в работе»; ждущие карточки берут подпись из WAIT_BADGE. */
export const STATUS_META = {
  [STATUS.READY]:      { cls: 'ready', label: 'готов' },
  [STATUS.THINKING]:   { cls: 'busy',  label: 'думает' },
  [STATUS.TOOL]:       { cls: 'busy',  label: 'работает' },
  [STATUS.WORKING]:    { cls: 'busy',  label: 'работает' },
  [STATUS.ERROR]:      { cls: 'error', label: 'ошибка' },
  [STATUS.COMPACTING]: { cls: 'busy',  label: 'сжимает контекст' },
};

export const WAIT_BADGE = {
  [WAIT_REASON.FINISHED]: 'закончил ход',
  [WAIT_REASON.PERMISSION]: 'ждёт разрешения',
  [WAIT_REASON.QUESTION]: 'нужен ответ',
  [WAIT_REASON.FAILED]: 'сбой API',
};

/* Агент подписан монохромно: своего цвета у него нет, цвет значит либо проект, либо «нужен ты». */
export const AGENT_LABEL = {
  [AGENT.CLAUDE]: 'Claude',
  [AGENT.CODEX]: 'Codex',
};

/* Порядок строк внутри проекта. */
export const AGENT_ORDER = [AGENT.CLAUDE, AGENT.CODEX];

const TERM_COLORS = {
  WebStorm: '#3fd0c9', IntelliJ: '#ff6f8e', PyCharm: '#f7d64c', PhpStorm: '#b06bff',
  GoLand: '#41d3e6', RubyMine: '#ff5d63', CLion: '#5be36f', DataGrip: '#8b7dff',
  Rider: '#ff54c8', Alacritty: '#a06cff', iTerm: '#48c96f', Terminal: '#9aa4b4',
  Warp: '#4d9dff', kitty: '#f7a94c', WezTerm: '#5be3a0', Ghostty: '#c299ff',
};

/* Через сколько активная строка без событий тускнеет в «нет активности» (idle). Это подсказка
   на фронте; удаление протухших (stale) через часы делает сервер, pruneStale в state.js. */
export const IDLE_MS = 4 * 60 * 1000;

export function termColor(terminal) {
  return TERM_COLORS[terminal] || 'var(--dim)';
}
