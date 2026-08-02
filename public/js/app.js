import { connectFleetStream, dropSession, focusSession } from './data/fleet-api.js';
import { createBoardView } from './ui/board-view.js';
import { createNotifications } from './ui/notifications.js';
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

const notifications = createNotifications({ onFocus: focus, toast });
const board = createBoardView({
  onDrop: drop,
  onFocus: focus,
  onWaiting: notifications.notifyAboutWaiting,
});

connectFleetStream({
  onMessage: board.update,
  onConnectionChange: board.setLive,
});
setInterval(board.tickTimes, 1000);
