import { sectionOf } from '../board-config.js';
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

export function createRail() {
  const rail = document.getElementById('rail');
  const axis = document.getElementById('axis');
  let model = { sessions: [], usage: null };
  let paintedLeft = null;
  let nowEl = null;
  let winEl = null;

  function bounds(now) {
    const usage = model.usage;
    const roundedUp = Math.ceil((now + EDGE_MS) / HALF_HOUR_MS) * HALF_HOUR_MS;
    const right = usage && usage.endsAt > now ? Math.max(usage.endsAt, roundedUp) : roundedUp;
    return { left: right - SPAN_MS, right };
  }

  function pct(timestamp, b) {
    return ((timestamp - b.left) / SPAN_MS * 100).toFixed(2) + '%';
  }

  function update(snapshot) {
    model = { sessions: snapshot.sessions || [], usage: snapshot.usage || null };
    paint(Date.now(), true);
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
      if (c.createdAt >= b.left && c.createdAt <= b.right) {
        const hue = projectMark(c.project).hue;
        html += `<i class="tick" style="left:${pct(c.createdAt, b)};--tk:hsl(${hue} 55% 62%)" title="${name} · ${clock(c.createdAt)}"></i>`;
      }
      // красная засечка только у тех, кому нужен ты; закончивший ход просто стоит
      if (sectionOf(c) === 'attn' && c.waitingSince >= b.left && c.waitingSince <= b.right) {
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
    const left = pct(now, b);
    if (nowEl.style.left !== left) nowEl.style.left = left;
    const nowLabel = 'сейчас ' + clock(now);
    if (nowEl.dataset.label !== nowLabel) nowEl.dataset.label = nowLabel;
    if (winEl) {
      const label = `сброс в ${clock(model.usage.endsAt)} · через ${timeLeftText(model.usage.endsAt - now)}`;
      if (winEl.dataset.label !== label) winEl.dataset.label = label;
    }
  }

  return { update, tick };
}
