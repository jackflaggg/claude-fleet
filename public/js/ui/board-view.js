import { IDLE_MS } from '../board-config.js';
import { sparkBars } from '../lib/activity.js';
import { ACTIVE_STATUSES, AGENT, SECTION, agentOf, sectionOf } from '../lib/domain.js';
import { ageText, plural, timerText, waitingText } from '../lib/format.js';
import { updateFavicon } from './favicon.js';
import { cardHtml, cardSig, rowHtml } from './markup.js';
import { layoutKey, splitSections } from './order.js';

/** @import { Card, Snapshot } from '../../../types.js' */

/* искра гаснет, когда последние две минуты пусты: так «затухание» видно раньше бейджа */
const QUIET_MINUTES = 2;

/** Элемент каркаса из index.html; его отсутствие это сломанная страница, а не рабочий случай. */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`на странице нет #${id}`);
  return el;
}

/**
 * Ближайший предок цели события по селектору. Цель клика может быть текстовым узлом,
 * у которого нет `closest`.
 * @param {Event} event
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
function closestFrom(event, selector) {
  const target = event.target instanceof Element ? event.target : null;
  return /** @type {HTMLElement | null} */ (target?.closest(selector) ?? null);
}

/** @param {Element} el @returns {string} id сессии у карточки или строки, в которой лежит el */
function unitIdOf(el) {
  const unit = /** @type {HTMLElement | null} */ (el.closest('.unit'));
  return unit?.dataset.id ?? '';
}

/* Здесь только склейка с документом: разметку строят чистые функции `markup.js`, порядок
   и раскладку решает `order.js`, и то и другое покрыто тестами без DOM. */
export function createBoardView({ onWaiting, onFocus, onDrop, onPermission, onReply }) {
  const board = byId('board');
  const empty = byId('empty');
  /** @type {Snapshot} */
  let data = { sessions: [] };
  /** @type {string | null} */
  let lastSig = null;
  let lastLayout = '';
  /** @type {Map<string, HTMLElement>} */
  const slots = new Map();

  /** Все карточки и строки борда. */
  function units() {
    return /** @type {NodeListOf<HTMLElement>} */ (board.querySelectorAll('.unit'));
  }

  /** @param {Element} el @param {string} selector @returns {HTMLElement | null} */
  function part(el, selector) {
    return /** @type {HTMLElement | null} */ (el.querySelector(selector));
  }

  // разделители не встречаются в полях карточки, поэтому склейка соседних сессий однозначна
  function sig(sessions) {
    return sessions.map((c) => [c.sessionId, cardSig(c)].join('\x01')).join('\x02');
  }

  /* Карточки живут между рендерами: элемент создаётся один раз на сессию и дальше только
     переставляется и обновляется внутри. Иначе пересоздание DOM под курсором гасит :hover
     (а кнопка удаления показывается именно по ховеру), сбрасывает фокус клавиатуры и
     способно увести клик мимо цели - при активной работе борд перерисовывается несколько
     раз в секунду. */
  /** @type {Map<string, { el: HTMLElement, sig: string | null, shape: string }>} */
  const cardEls = new Map();

  /* shape - карточка (ждущие) или строка (в работе). Сессия переходит между секциями,
     и форма при этом меняется: тогда элемент пересоздаём, иначе внутри строки остался бы
     markup карточки. */
  /** @param {Card} c @param {'card' | 'row'} shape */
  function cardEl(c, shape) {
    let entry = cardEls.get(c.sessionId);
    if (!entry || entry.shape !== shape) {
      const el = document.createElement('div');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.dataset.id = c.sessionId;
      el.title = agentOf(c) === AGENT.CODEX
        ? 'открыть проект сессии Codex'
        : 'перейти к сессии Claude (WebStorm или её терминал)';
      entry = { el, sig: null, shape };
      cardEls.set(c.sessionId, entry);
    }
    const nextSig = cardSig(c);
    if (nextSig !== entry.sig) {
      entry.sig = nextSig;
      // классы простоя (idle) и продолжения группы ставятся снаружи, при смене статуса их сохраняем
      const keep = ['idle', 'cont'].filter((name) => entry.el.classList.contains(name)).join(' ');
      const done = shape === 'card' && sectionOf(c) === SECTION.DONE ? 'done' : '';
      entry.el.className = `unit ${shape} ${done} s-${c.status} a-${agentOf(c)} ${keep}`;
      entry.el.dataset.status = c.status;
      entry.el.innerHTML = shape === 'row' ? rowHtml(c) : cardHtml(c);
    }
    syncLive(entry.el, c);
    return entry.el;
  }

  /* Всё, что тикает без ре-рендера, лежит на самом элементе: время последнего события
     (у строки нет подписи «N сек назад»), буфер активности для искры. */
  /** @param {HTMLElement} el @param {Card} c */
  function syncLive(el, c) {
    el.dataset.ts = String(c.updatedAt || 0);
    el.dataset.act = Array.isArray(c.activity) ? c.activity.join(',') : '';
    el.dataset.actmin = String(c.activityMinute || 0);
  }

  /** Карточки исчезнувших сессий выкидываем, иначе Map растёт до перезагрузки страницы. */
  /** @param {Card[]} list */
  function forgetGoneCards(list) {
    const alive = new Set(list.map((c) => c.sessionId));
    for (const id of cardEls.keys()) {
      if (!alive.has(id)) cardEls.delete(id);
    }
  }

  function render() {
    const list = data.sessions || [];
    const { waiting, done, busy } = splitSections(list);

    // скелет перестраиваем, только если изменился состав секций, а не при каждом событии:
    // порядок внутри секции задаёт сам append (существующий элемент переезжает, не создаётся)
    const layout = layoutKey({ waiting: waiting.length, done: done.length, busy: busy.length, total: list.length });
    if (layout !== lastLayout) {
      lastLayout = layout;
      let html = '';
      if (waiting.length) {
        html += '<section class="sec"><div class="sec-head attn"><span class="ping"></span>Ждут тебя <span class="n" id="nWaiting"></span></div>'
          + '<div class="cards" data-slot="w"></div></section>';
      } else if (list.length) {
        // спокойное состояние показываем явно: исчезающая секция неотличима от
        // "я просто смотрю не туда", а борд должен читаться одним взглядом издалека
        html += '<section class="sec"><div class="calm"><i></i><b>Никто не ждёт</b><span>все сессии работают или готовы к промпту</span></div></section>';
      }
      if (done.length) {
        html += '<section class="sec"><div class="sec-head">Закончили ход <span class="n" id="nDone"></span></div>'
          + '<div class="cards" data-slot="d"></div></section>';
      }
      if (busy.length) {
        html += '<section class="sec"><div class="sec-head">В работе <span class="n" id="nBusy"></span></div>'
          + '<div class="tbl" data-slot="p"></div></section>';
      }
      board.innerHTML = html;
      slots.clear();
      for (const el of /** @type {NodeListOf<HTMLElement>} */ (board.querySelectorAll('[data-slot]'))) {
        slots.set(el.dataset.slot ?? '', el);
      }
    }
    setText(document.getElementById('nWaiting'), String(waiting.length));
    setText(document.getElementById('nDone'), String(done.length));
    setText(document.getElementById('nBusy'), String(busy.length));

    const waitingSlot = slots.get('w');
    if (waitingSlot) for (const c of waiting) waitingSlot.append(cardEl(c, 'card'));
    const doneSlot = slots.get('d');
    if (doneSlot) for (const c of done) doneSlot.append(cardEl(c, 'card'));
    const busySlot = slots.get('p');
    if (busySlot) {
      let previousProject = null;
      for (const c of busy) {
        const el = cardEl(c, 'row');
        // первая строка проекта несёт монограмму и имя, следующие - уголок продолжения
        el.classList.toggle('cont', previousProject === c.project);
        busySlot.append(el);
        previousProject = c.project;
      }
    }
    forgetGoneCards(list);
    empty.hidden = list.length > 0;

    const claudeCount = list.filter((c) => agentOf(c) === AGENT.CLAUDE).length;
    const codexCount = list.length - claudeCount;
    const split = claudeCount && codexCount ? ` · Claude ${claudeCount} · Codex ${codexCount}` : '';
    setText(document.getElementById('subtitle'), list.length
      ? `${list.length} ${plural(list.length, 'сессия', 'сессии', 'сессий')} на связи${split}`
      : '');
    byId('counts').innerHTML = list.length
      ? `<span><b>${busy.length}</b>в работе</span>`
        + (done.length ? `<span><b>${done.length}</b>закончили ход</span>` : '')
        + (waiting.length ? `<span class="w"><b>${waiting.length}</b>ждут тебя</span>` : '')
      : '';
    document.title = (waiting.length ? `(${waiting.length}) ` : '') + 'Fleet';
    byId('mark').classList.toggle('alert', waiting.length > 0);
    updateFavicon(waiting.length);
    onWaiting(waiting);
  }

  // событий, которых борд не понимает, в норме нет: если появились - обновился агент
  // и часть статусов, скорее всего, перестала обновляться
  function renderUnknown() {
    const el = byId('unknown');
    const list = data.unknown || [];
    el.hidden = list.length === 0;
    if (!list.length) return;
    const total = list.reduce((sum, u) => sum + u.count, 0);
    el.textContent = `${list.length} ${plural(list.length, 'незнакомое событие', 'незнакомых события', 'незнакомых событий')}`;
    el.title = 'Борд не понимает эти события хука (всего ' + total + '): '
      + list.map((u) => `${u.name} ×${u.count}`).join(', ')
      + '. Похоже, обновился Claude Code или Codex - часть статусов может не обновляться';
  }

  // присваивание textContent дёргает перерисовку узла даже тем же значением, а тик идёт
  // раз в секунду круглосуточно - сверяем перед записью
  /** @param {Element | null} node @param {string} value */
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function syncTimestamps() {
    /** @type {Record<string, Card>} */
    const cardsById = Object.create(null);
    for (const c of data.sessions || []) cardsById[c.sessionId] = c;
    for (const el of units()) {
      const c = cardsById[el.dataset.id ?? ''];
      if (c) syncLive(el, c);
    }
  }

  /* Искра: столбики досдвигаются по текущей минуте и перерисовываются только когда
     их набор изменился - тик идёт раз в секунду по всем строкам */
  /** @param {HTMLElement} el @param {number} now */
  function paintSpark(el, now) {
    const spark = part(el, '.spark');
    if (!spark) return;
    const activity = el.dataset.act ? el.dataset.act.split(',').map(Number) : [];
    const bars = sparkBars(activity, Number(el.dataset.actmin), now);
    const key = bars.join(',');
    if (spark.dataset.bars === key) return;
    spark.dataset.bars = key;
    const peak = Math.max(1, ...bars);
    const total = bars.reduce((sum, v) => sum + v, 0);
    spark.querySelectorAll('i').forEach((bar, i) => {
      bar.style.setProperty('--v', String(Math.round((bars[i] / peak) * 100)));
    });
    const recent = bars.slice(-QUIET_MINUTES).reduce((sum, v) => sum + v, 0);
    spark.classList.toggle('quiet', recent === 0);
    spark.title = `событий за 10 минут: ${total}`;
  }

  // раз в секунду двигаем время «на месте» (без ре-рендера) и подсвечиваем простаивающие строки
  function tickTimes() {
    const now = Date.now();
    for (const el of units()) {
      const wt = part(el, '.wt');
      if (wt) setText(wt, timerText(Number(wt.dataset.ts), now));
      const age = part(el, '.age');
      if (age) setText(age, ageText(Number(age.dataset.created), now));
      // «нет активности» только для активных статусов - waiting/ready законно ждут человека
      const busy = ACTIVE_STATUSES.has(el.dataset.status ?? '');
      const ts = Number(el.dataset.ts) || 0;
      const idle = busy && ts > 0 && now - ts > IDLE_MS;
      el.classList.toggle('idle', idle);
      if (idle) setText(el.querySelector('.idle-t'), waitingText(ts, now));
      paintSpark(el, now);
    }
  }

  /** @param {Snapshot} nextData */
  function update(nextData) {
    data = nextData;
    const nextSignature = sig(data.sessions || []);
    if (nextSignature !== lastSig) {
      lastSig = nextSignature;
      render();
    } else {
      syncTimestamps();
    }
    renderUnknown();
  }

  /** @param {boolean} isLive */
  function setLive(isLive) {
    const live = byId('live');
    live.classList.toggle('on', isLive);
    live.classList.toggle('off', !isLive);
    byId('liveText').textContent = isLive ? 'live' : 'нет связи';
  }

  board.addEventListener('click', (event) => {
    const removeButton = closestFrom(event, '.kill');
    if (removeButton) {
      onDrop(removeButton.dataset.kill);
      return;
    }
    const verdict = closestFrom(event, '[data-verdict]');
    if (verdict) {
      onPermission(unitIdOf(verdict), verdict.dataset.verdict);
      return;
    }
    // поле ввода и кнопка формы ответа: клик по ним не значит «перейти к сессии»
    if (closestFrom(event, '.reply')) return;
    const unit = closestFrom(event, '.unit');
    if (unit) onFocus(unit.dataset.id);
  });

  board.addEventListener('submit', async (event) => {
    const form = closestFrom(event, '.reply');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input');
    const text = input?.value.trim();
    if (!input || !text) return;
    const sent = await onReply(unitIdOf(form), text);
    if (sent) input.value = '';
  });

  // Карточка и строка содержат кнопки, поэтому сами остаются div с role="button".
  board.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const unit = closestFrom(event, '.unit');
    if (!unit || closestFrom(event, '.kill, .acts, .reply')) return;
    event.preventDefault();
    onFocus(unit.dataset.id);
  });

  return { setLive, tickTimes, update };
}
