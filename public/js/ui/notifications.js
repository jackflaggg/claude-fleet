import { WAIT_BADGE } from '../board-config.js';

const NOTIFY_KEY = 'fleet-notify';

export function createNotifications({ onFocus, toast }) {
  const bell = document.getElementById('bell');
  let notifyOn = localStorage.getItem(NOTIFY_KEY) === '1';
  let knownWaiting = new Set();
  let firstSnapshot = true;

  function syncBell() {
    bell.classList.toggle('on', notifyOn);
    bell.classList.toggle('off', !notifyOn);
    bell.setAttribute('aria-pressed', String(notifyOn));
    bell.title = notifyOn
      ? 'Уведомления включены (без звука, только о новых ожидающих)'
      : 'Уведомления выключены';
  }

  function postNotification(title, body, onClick) {
    try {
      const notification = new Notification(title, { body, tag: 'fleet-waiting', silent: true });
      notification.onclick = () => {
        window.focus();
        if (onClick) onClick();
        notification.close();
      };
      return true;
    } catch {
      return false;
    }
  }

  async function toggle() {
    if (notifyOn) {
      notifyOn = false;
    } else {
      if (!('Notification' in window)) {
        toast('Браузер не умеет системные уведомления');
        return;
      }
      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Уведомления запрещены в настройках браузера');
        return;
      }
      notifyOn = true;
      postNotification('Уведомления включены', 'Позову, когда сессия будет ждать тебя');
      toast('Отправил пробное уведомление. Не видно - разреши браузеру уведомления в Системных настройках');
    }
    localStorage.setItem(NOTIFY_KEY, notifyOn ? '1' : '0');
    syncBell();
  }

  function notifyAboutWaiting(waiting) {
    const fresh = waiting.filter((card) => !knownWaiting.has(card.sessionId));
    knownWaiting = new Set(waiting.map((card) => card.sessionId));
    if (firstSnapshot) {
      firstSnapshot = false;
      return;
    }
    if (!notifyOn || !fresh.length || !('Notification' in window) || Notification.permission !== 'granted') return;

    const one = fresh.length === 1 ? fresh[0] : null;
    const title = one
      ? `${one.project} ${WAIT_BADGE[one.reason] || 'ждёт тебя'}`
      : `${fresh.length} сессии ждут тебя`;
    const body = one
      ? (one.note || (one.tool ? `${one.tool}${one.toolInfo ? ' · ' + one.toolInfo : ''}` : one.title || ''))
      : fresh.map((card) => card.project).join(', ');
    postNotification(title, body, one ? () => onFocus(one.sessionId) : null);
  }

  bell.addEventListener('click', toggle);
  syncBell();

  return { notifyAboutWaiting };
}
