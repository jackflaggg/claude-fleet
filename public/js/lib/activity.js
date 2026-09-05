/**
 * Искра активности: сколько событий пришло в каждую из последних минут. Ровно ACTIVITY_BARS
 * чисел на карточку, буфер кольцевой и ограничен по построению: память не растёт ни от
 * долгой сессии, ни от шторма событий. Сдвиг считается от номера минуты последнего события
 * (activityMinute), поэтому у молчащей сессии старые столбики уезжают влево сами, без
 * таймера в ядре: клиент досдвигает по текущему времени (sparkBars).
 *
 * Файл лежит в public/js/lib, потому что нужен обеим сторонам: state.js на сервере
 * накапливает, борд в браузере досдвигает. Один источник, без DOM и без IO.
 */
export const ACTIVITY_BARS = 10;
const MINUTE_MS = 60 * 1000;

export function bumpActivity(activity, activityMinute, now) {
  const minute = Math.floor(now / MINUTE_MS);
  const bars = shiftActivity(activity, activityMinute, minute);
  bars[ACTIVITY_BARS - 1] += 1;
  return { activity: bars, activityMinute: minute };
}

/** Сдвигает столбики к минуте `minute`; всегда возвращает новый массив длины ACTIVITY_BARS. */
export function shiftActivity(activity, activityMinute, minute) {
  const bars = new Array(ACTIVITY_BARS).fill(0);
  if (!Array.isArray(activity) || !Number.isFinite(activityMinute)) return bars;
  const delta = minute - activityMinute;
  if (delta < 0 || delta >= ACTIVITY_BARS) return bars;
  for (let i = 0; i < ACTIVITY_BARS - delta; i += 1) {
    const value = activity[i + delta];
    bars[i] = Number.isFinite(value) ? value : 0;
  }
  return bars;
}

/** Столбики на текущий момент времени (для отрисовки). */
export function sparkBars(activity, activityMinute, now) {
  return shiftActivity(activity, activityMinute, Math.floor(now / MINUTE_MS));
}
