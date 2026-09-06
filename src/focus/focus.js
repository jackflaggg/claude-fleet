/**
 * Чистое решение "куда вернуть по клику на карточку". Вынесено из server.js отдельно,
 * потому что это нетривиальная матрица случаев, и ломается она именно при переезде на
 * другую машину (нет лаунчера, другой терминал, сессия не в проекте).
 *
 * Побочных эффектов нет: проверка "это папка проекта" приходит параметром, как now в state.js.
 */

/** Сессия живёт в IDE JetBrains (WebStorm и родня) - у них общий префикс bundle-id. */
function isJetBrainsApp(appId) {
  return appId.startsWith('com.jetbrains.');
}

/**
 * @param {object} card карточка сессии (нужны appId и cwd)
 * @param {object} deps
 * @param {string|null} deps.launcher путь к CLI-лаунчеру WebStorm или null, если не найден
 * @param {string} deps.app имя приложения IDE для фолбэка `open -a`
 * @param {(cwd: string) => boolean} deps.isProjectDir открыт ли путь как проект IDE (есть .idea)
 * @returns {{cmd: string, args: string[]} | null} что запустить, либо null если непонятно
 */
export function resolveFocus(card, { launcher, app, isProjectDir }) {
  const appId = typeof card?.appId === 'string' ? card.appId : '';
  const cwd = typeof card?.cwd === 'string' ? card.cwd : '';
  const jetBrains = isJetBrainsApp(appId);
  const project = Boolean(cwd) && isProjectDir(cwd);

  // Терминал внутри IDE и это настоящий проект: лаунчер умеет переключиться на нужное окно,
  // `open -a` так не может (поднимает последнее активное).
  if (jetBrains && project) return openProject(cwd, launcher, app);

  // Сессия в обычном терминале (Alacritty/iTerm/Terminal) - выводим вперёд именно его.
  // Открывать при этом папку как проект нельзя: для home IDE покажет диалог доверия.
  if (appId && !jetBrains) return { cmd: 'open', args: ['-b', appId] };

  // IDE, но папка не проект (например `claude` из home внутри терминала IDE).
  if (jetBrains) return { cmd: 'open', args: ['-b', appId] };

  // Терминал неизвестен (карточка появилась до первого события с bundle-id), но папка
  // похожа на проект - открываем хотя бы проект.
  if (project) return openProject(cwd, launcher, app);

  return null;
}

/** Лаунчер точнее, но он есть не на каждой машине - тогда обходимся `open -a <app> <путь>`. */
function openProject(cwd, launcher, app) {
  if (launcher) return { cmd: launcher, args: [cwd] };
  if (app) return { cmd: 'open', args: ['-a', app, cwd] };
  return null;
}
