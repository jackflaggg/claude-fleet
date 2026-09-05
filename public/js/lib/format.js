export function relativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return seconds + ' сек назад';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' мин назад';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' ч назад';
  return Math.floor(hours / 24) + ' дн назад';
}

export function durationText(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'идёт ' + seconds + ' с';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return 'идёт ' + minutes + ' мин';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'идёт ' + hours + ' ч';
  return 'идёт ' + Math.floor(hours / 24) + ' дн';
}

export function waitingText(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return seconds + ' с';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' мин';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' ч';
  return Math.floor(hours / 24) + ' дн';
}

/** Возраст сессии в строке: без слова «идёт», колонка и так называется возрастом. */
export function ageText(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return seconds + ' с';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' мин';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' ч ' + String(minutes % 60).padStart(2, '0') + ' мин';
  return Math.floor(hours / 24) + ' дн';
}

/** Крупный таймер ожидания на красной карточке: м:сс, после часа ч:мм:сс. */
export function timerText(since, now = Date.now()) {
  if (!since) return '';
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function clock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function timeLeftText(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 60) return minutes + ' мин';
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? hours + ' ч ' + (minutes % 60) + ' мин' : hours + ' ч';
}

export function projectMark(name) {
  const value = String(name || '?');
  let hue = 0;
  for (let i = 0; i < value.length; i++) hue = (hue * 31 + value.charCodeAt(i)) % 360;
  const parts = value.split(/[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const letters = (parts.length > 1 ? parts[0][0] + parts[1][0] : value.slice(0, 2)).toUpperCase();
  return { letters, hue };
}
