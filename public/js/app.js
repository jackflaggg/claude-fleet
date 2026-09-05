import {
  connectFleetStream,
  dropSession,
  focusSession,
  sendPermission,
  sendReply,
} from './data/fleet-api.js';
import { createBoardView } from './ui/board-view.js';
import { createNotifications } from './ui/notifications.js';
import { createRail } from './ui/rail.js';
import { createToast } from './ui/toast.js';

const toast = createToast();

async function focus(sessionId) {
  try {
    const response = await focusSession(sessionId);
    if (response.status === 204) {
      toast('Пока не знаю, где живёт эта сессия. Дай ей сделать любой шаг в терминале - и клик заработает');
    } else if (!response.ok) {
      toast('Не удалось перейти к сессии');
    }
  } catch {
    toast('Сервер борда не отвечает');
  }
}

async function drop(sessionId) {
  try {
    const response = await dropSession(sessionId);
    if (!response.ok && response.status !== 404) toast('Не удалось убрать карточку');
  } catch {
    toast('Сервер борда не отвечает');
  }
}

/* Кнопки «Разрешить»/«Отказать»: вердикт уходит в сессию по каналу. Терминальный диалог
   остаётся открытым параллельно, применяется первый ответ - поэтому 409 это не ошибка,
   а «уже ответили в терминале». */
async function permit(sessionId, behavior) {
  try {
    const response = await sendPermission(sessionId, behavior);
    if (response.status === 409) toast('Запрос разрешения уже закрыт в терминале');
    else if (!response.ok) toast('Не удалось передать решение');
  } catch {
    toast('Сервер борда не отвечает');
  }
}

async function reply(sessionId, text) {
  try {
    const response = await sendReply(sessionId, text);
    if (response.ok) {
      toast('Отправлено в сессию');
      return true;
    }
    toast(response.status === 409 ? 'У этой сессии нет канала' : 'Не удалось отправить');
  } catch {
    toast('Сервер борда не отвечает');
  }
  return false;
}

const notifications = createNotifications({ onFocus: focus, toast });
const rail = createRail();
const board = createBoardView({
  onDrop: drop,
  onFocus: focus,
  onPermission: permit,
  onReply: reply,
  onWaiting: notifications.notifyAboutWaiting,
});

connectFleetStream({
  onMessage: (snapshot) => {
    board.update(snapshot);
    rail.update(snapshot);
  },
  onConnectionChange: board.setLive,
});
setInterval(() => {
  board.tickTimes();
  rail.tick();
}, 1000);
