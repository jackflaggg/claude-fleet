import { isAttention } from '../lib/domain.js';
import { clock, escapeHtml, projectMark, timeLeftText } from '../lib/format.js';

/* Рейл гавани под шапкой: одна ось времени на последние шесть часов. Три факта, которые
   раньше жили в разных местах, на одной линии: засечки стартов сессий в цвете проекта,
   красные засечки входа в ожидание, латунная полоса окна лимита с меткой сброса и маркер
   «сейчас». Правый край оси это конец окна лимита (или ближайшие полчаса, если окна нет),
   поэтому «сколько до сброса» читается и как расстояние, и как подпись. */
const SPAN_MS = 6 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/* маркер «сейчас» не прижимается к правому краю: под подпись нужен зазор */
const EDGE_MS = 20 * 60 * 1000;

/** @import { Card, Snapshot, UsageWindow } from '../../../types.js' */

export function createRail() {
  const rail = /** @type {HTMLElement} */ (document.getElementById('rail'));
  const axis = /** @type {HTMLElement} */ (document.getElementById('axis'));
  /** @type {{ sessions: Card[], usage: UsageWindow | null }} */
  let model = { sessions: [], usage: null };
  /** @type {number | null} */
  let paintedLeft = null;
  /** @type {string | null} */
  let paintedSig = null;
  /** @type {HTMLElement | null} */
  let nowEl = null;
  /** @type {HTMLElement | null} */
  let winEl = null;

  /* Из снимка рейлу нужны только моменты стартов и ожиданий да границы окна: остальные поля
     карточки меняются на каждом событии хука, и перестраивать по ним ось незачем */
  function railSig(m) {
    const marks = m.sessions.map((c) => [c.project, c.createdAt, isAttention(c) ? c.waitingSince : ''].join(''));
    return [m.usage?.startedAt, m.usage?.endsAt, ...marks].join('');
  }

  function bounds(now) {
    const usage = model.usage;
    const roundedUp = Math.ceil((now + EDGE_MS) / HALF_HOUR_MS) * HALF_HOUR_MS;
    const right = usage && usage.endsAt > now ? Math.max(usage.endsAt, roundedUp) : roundedUp;
    return { left: right - SPAN_MS, right };
  }

  function pct(timestamp, b) {
    return ((timestamp - b.left) / SPAN_MS * 100).toFixed(2) + '%';
  }

  /* Снимок приходит на каждое событие хука, а ось перестраивается только когда сдвинулись
     засечки или границы окна: иначе рейл делал полный innerHTML несколько раз в секунду
     при активной работе, тогда как борд рядом рисуется точечно */
  /** @param {Snapshot} snapshot */
  function update(snapshot) {
    model = { sessions: snapshot.sessions || [], usage: snapshot.usage || null };
    paint(Date.now(), railSig(model) !== paintedSig);
  }

  function tick() {
    paint(Date.now(), false);
  }

  function paint(now, force) {
    const visible = model.sessions.length > 0 || Boolean(model.usage);
    rail.hidden = !visible;
    if (!visible) return;
    const b = bounds(now);
    if (force || b.left !== paintedLeft) rebuild(now, b);
    else move(now, b);
  }

  function rebuild(now, b) {
    paintedLeft = b.left;
    paintedSig = railSig(model);
    const usage = model.usage;
    let html = '<div class="base"></div>';
    if (usage && usage.endsAt > now) {
      const from = Math.max(usage.startedAt, b.left);
      const rightGap = (100 - parseFloat(pct(usage.endsAt, b))).toFixed(2) + '%';
      html += `<div class="win" id="railWin" style="left:${pct(from, b)};right:${rightGap}"`
        + ` data-start="окно лимита с ${clock(usage.startedAt)}" data-label=""></div>`;
    } else if (usage) {
      html += '<span class="fresh">лимит Claude свежий · счётчик пойдёт со следующего запроса</span>';
    }
    for (let t = Math.ceil(b.left / HOUR_MS) * HOUR_MS; t <= b.right; t += HOUR_MS) {
      html += `<span class="hour" style="left:${pct(t, b)}">${clock(t)}</span>`;
    }
    for (const c of model.sessions) {
      const name = escapeHtml(c.project || '');
      if (c.createdAt && c.createdAt >= b.left && c.createdAt <= b.right) {
        const hue = projectMark(c.project).hue;
        html += `<i class="tick" style="left:${pct(c.createdAt, b)};--tk:hsl(${hue} 55% 62%)" title="${name} · ${clock(c.createdAt)}"></i>`;
      }
      // красная засечка только у тех, кому нужен ты; закончивший ход просто стоит
      if (isAttention(c) && c.waitingSince && c.waitingSince >= b.left && c.waitingSince <= b.right) {
        html += `<i class="tick wait" style="left:${pct(c.waitingSince, b)}" title="${name} · ждёт с ${clock(c.waitingSince)}"></i>`;
      }
    }
    html += '<div class="now" id="railNow" data-label=""></div>';
    axis.innerHTML = html;
    nowEl = document.getElementById('railNow');
    winEl = document.getElementById('railWin');
    move(now, b);
  }

  /* посекундный тик двигает только маркер и подписи, и только когда текст реально изменился */
  function move(now, b) {
    if (!nowEl) return;
    const left = pct(now, b);
    if (nowEl.style.left !== left) nowEl.style.left = left;
    const nowLabel = 'сейчас ' + clock(now);
    if (nowEl.dataset.label !== nowLabel) nowEl.dataset.label = nowLabel;
    if (winEl && model.usage) {
      const label = `сброс в ${clock(model.usage.endsAt)} · через ${timeLeftText(model.usage.endsAt - now)}`;
      if (winEl.dataset.label !== label) winEl.dataset.label = label;
    }
  }

  return { update, tick };
}
