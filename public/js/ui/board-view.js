import { IDLE_MS, STATUS_META, WAIT_BADGE, sectionOf, termColor } from '../board-config.js';
import { sparkBars } from '../lib/activity.js';
import {
  ageText,
  escapeHtml,
  plural,
  projectMark,
  timerText,
  waitingText,
} from '../lib/format.js';
import { updateFavicon } from './favicon.js';

const AGENTS = { claude: 'Claude', codex: 'Codex' };
const AGENT_ORDER = ['claude', 'codex'];
const SPARK_BARS = 10;
/* искра гаснет, когда последние две минуты пусты: так «затухание» видно раньше бейджа */
const QUIET_MINUTES = 2;

export function createBoardView({ onWaiting, onFocus, onDrop, onPermission, onReply }) {
  const board = document.getElementById('board');
  const empty = document.getElementById('empty');
  let data = { sessions: [] };
  let lastSig = null;
  let lastLayout = '';
  const slots = new Map();

  function agentOf(c) { return c.agent === 'codex' ? 'codex' : 'claude'; }

  function avatarHtml(name) {
    const mark = projectMark(name);
    const style = `--av-fg:hsl(${mark.hue} 62% 70%);--av-bg:hsl(${mark.hue} 55% 60% / .16);--av-br:hsl(${mark.hue} 55% 62% / .34)`;
    return `<span class="avatar" style="${style}" aria-hidden="true">${escapeHtml(mark.letters)}</span>`;
  }

  /* агент подписан монохромно рядом с терминалом: своего цвета у него нет, цвет на борде
     значит либо проект (монограмма), либо «нужен ты» (красный) */
  function originHtml(c, extraClass = '') {
    const terminal = c.terminal
      ? `<span class="term" style="--tc:${termColor(c.terminal)}">${escapeHtml(c.terminal)}</span>`
      : '';
    return `<span class="origin ${extraClass}"><span class="agent">${AGENTS[agentOf(c)]}</span>${terminal}</span>`;
  }

  /* worktree стоит в группе родительского проекта, поэтому имя копии надо назвать в самой
     карточке/строке - иначе две сессии одного проекта выглядят как правки одного и того же */
  function wtreeHtml(c) {
    return c.worktree ? `<span class="wtree" title="git worktree">${escapeHtml(c.worktree)}</span>` : '';
  }

  function toolHtml(c) {
    if (!c.tool) return '';
    const info = c.toolInfo ? ' · ' + escapeHtml(c.toolInfo) : '';
    return `<span class="tool"><span class="tt"><span class="tn">${escapeHtml(c.tool)}</span>${info}</span></span>`;
  }

  function sig(sessions) {
    return sessions.map((c) => [c.sessionId, cardSig(c)].join('')).join('');
  }

  function cardSig(c) {
    return [
      c.agent, c.status, c.reason, c.title, c.note, c.tool, c.toolInfo, c.terminal, c.project,
      c.worktree, c.createdAt, c.waitingSince, c.channel, c.permission?.requestId,
    ].join('');
  }

  function badgeFor(c) {
    if (c.status === 'waiting') {
      return { cls: sectionOf(c) === 'done' ? 'done' : 'waiting', label: WAIT_BADGE[c.reason] || 'ждёт тебя' };
    }
    return STATUS_META[c.status] || STATUS_META.ready;
  }

  /* Ответ прямо с борда: только когда к сессии подключён канал (FLEET_CHANNEL=1 и сессия
     запущена с каналом fleet). Без канала карточка остаётся как есть - кнопки-обманки
     хуже их отсутствия. */
  function actsHtml(c) {
    if (!c.channel) return '';
    if (c.permission) {
      return '<span class="acts"><button class="act ok" type="button" data-verdict="allow">Разрешить</button>'
        + '<button class="act no" type="button" data-verdict="deny">Отказать</button>'
        + '<span class="needs">через канал fleet</span></span>';
    }
    if (c.reason === 'permission') return '';
    return '<form class="reply"><input type="text" placeholder="Ответить сессии…" aria-label="ответ сессии" maxlength="4000">'
      + '<button class="act" type="submit">Отправить</button><span class="needs">через канал fleet</span></form>';
  }

  function killHtml(c) {
    return `<button class="kill" type="button" data-kill="${escapeHtml(c.sessionId)}" title="убрать карточку с борда" aria-label="убрать карточку">×</button>`;
  }

  /* Карточка ожидания. Главная цифра - сколько она уже ждёт, крупно справа как задержка
     на табло. Текст уведомления объясняет, ЧЕГО ждут; при разрешении рядом стоит тул,
     на который спрашивают, и решение принимается не вставая. У закончившей ход карточки
     та же форма, но без красного и без дыхания: она не зовёт, а просто стоит без промпта. */
  function cardHtml(c) {
    const b = badgeFor(c);
    const done = sectionOf(c) === 'done';
    const asking = c.reason === 'permission' || c.reason === 'question';
    const ask = c.note || c.permission?.description || '';
    const askHtml = ask ? `<div class="ask">${escapeHtml(ask)}</div>` : '';
    const taskHtml = c.title ? `<div class="task">${escapeHtml(c.title)}</div>` : '';
    // время ожидания берём из waitingSince, а не из updatedAt: updatedAt двигает любое
    // входящее событие, и счётчик обнулялся бы прямо во время ожидания
    const since = c.waitingSince || c.updatedAt || 0;
    return `${done ? '' : '<i class="glow"></i>'}${killHtml(c)}
      <div class="top"><span class="badge ${b.cls}">${b.label}</span>
        <span class="who">${avatarHtml(c.project)}<span class="proj">${escapeHtml(c.project)}</span>${wtreeHtml(c)}</span></div>
      <div class="timer"><b class="wt" data-ts="${since}">${timerText(since)}</b><span>${done ? 'простаивает' : 'ждёт'}</span></div>
      <div class="body">${askHtml}${asking ? toolHtml(c) : ''}${taskHtml}</div>
      <div class="foot">${actsHtml(c)}${originHtml(c)}</div>`;
  }

  /* Строка секции «в работе»: ячейки берут колонки общей таблицы через subgrid, поэтому
     статусы читаются столбцом. Пустые ячейки всё равно выводим - без них сетка съезжает. */
  function rowHtml(c) {
    const b = badgeFor(c);
    const task = c.title ? escapeHtml(c.title) : '<span class="none">новая сессия, промпта ещё нет</span>';
    const bars = '<i></i>'.repeat(SPARK_BARS);
    return `<div class="c-proj">${avatarHtml(c.project)}<span class="proj">${escapeHtml(c.project)}</span></div>
      <div class="c-task">${wtreeHtml(c)}${task}</div>
      <div class="c-act">${c.status !== 'ready' ? toolHtml(c) : ''}<span class="idle">нет активности <span class="idle-t"></span></span></div>
      <span class="spark">${bars}</span>
      <span class="badge ${b.cls}">${b.label}</span>
      <span class="age" data-created="${c.createdAt || 0}">${ageText(c.createdAt)}</span>
      ${originHtml(c, 'c-origin')}
      <div class="c-end">${killHtml(c)}</div>`;
  }

  /* Карточки живут между рендерами: элемент создаётся один раз на сессию и дальше только
     переставляется и обновляется внутри. Иначе пересоздание DOM под курсором гасит :hover
     (а кнопка удаления показывается именно по ховеру), сбрасывает фокус клавиатуры и
     способно увести клик мимо цели - при активной работе борд перерисовывается несколько
     раз в секунду. */
  const cardEls = new Map();

  /* shape - карточка (ждущие) или строка (в работе). Сессия переходит между секциями,
     и форма при этом меняется: тогда элемент пересоздаём, иначе внутри строки остался бы
     markup карточки. */
  function cardEl(c, shape) {
    let entry = cardEls.get(c.sessionId);
    if (!entry || entry.shape !== shape) {
      const el = document.createElement('div');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.dataset.id = c.sessionId;
      el.title = agentOf(c) === 'codex'
        ? 'открыть проект сессии Codex'
        : 'перейти к сессии Claude (WebStorm или её терминал)';
      entry = { el, sig: null, shape };
      cardEls.set(c.sessionId, entry);
    }
    const nextSig = cardSig(c);
    if (nextSig !== entry.sig) {
      entry.sig = nextSig;
      // классы протухания и продолжения группы ставятся снаружи, при смене статуса их сохраняем
      const keep = ['stale', 'cont'].filter((name) => entry.el.classList.contains(name)).join(' ');
      const done = shape === 'card' && sectionOf(c) === 'done' ? 'done' : '';
      entry.el.className = `unit ${shape} ${done} s-${c.status} a-${agentOf(c)} ${keep}`;
      entry.el.innerHTML = shape === 'row' ? rowHtml(c) : cardHtml(c);
    }
    syncLive(entry.el, c);
    return entry.el;
  }

  /* Всё, что тикает без ре-рендера, лежит на самом элементе: время последнего события
     (у строки нет подписи «N сек назад»), буфер активности для искры. */
  function syncLive(el, c) {
    el.dataset.ts = c.updatedAt || 0;
    el.dataset.act = Array.isArray(c.activity) ? c.activity.join(',') : '';
    el.dataset.actmin = c.activityMinute || 0;
  }

  /** Карточки исчезнувших сессий выкидываем, иначе Map растёт до перезагрузки страницы. */
  function forgetGoneCards(list) {
    const alive = new Set(list.map((c) => c.sessionId));
    for (const id of cardEls.keys()) {
      if (!alive.has(id)) cardEls.delete(id);
    }
  }

  /* строки: проект → агент → старшая сессия выше. Порядок по UUID был случайным и менялся
     с каждой новой сессией */
  function rowOrder(a, b) {
    return String(a.project || '').localeCompare(String(b.project || ''))
      || AGENT_ORDER.indexOf(agentOf(a)) - AGENT_ORDER.indexOf(agentOf(b))
      || (a.createdAt || 0) - (b.createdAt || 0)
      || String(a.sessionId).localeCompare(String(b.sessionId));
  }

  // кто дольше ждёт, тот выше: разбираешь самое залежавшееся, и появление новой карточки
  // не сдвигает те, что уже в списке
  function waitOrder(a, b) {
    return (a.waitingSince || a.updatedAt || 0) - (b.waitingSince || b.updatedAt || 0);
  }

  function render() {
    const list = data.sessions || [];
    // три секции: красное «ждут тебя» (разрешение, вопрос, сбой), нейтральное «закончили
    // ход» (Stop: сессия стоит без промпта, но помощи не просит) и строки «в работе»
    const waiting = list.filter((c) => sectionOf(c) === 'attn').sort(waitOrder);
    const done = list.filter((c) => sectionOf(c) === 'done').sort(waitOrder);
    const busy = list.filter((c) => sectionOf(c) === 'busy').sort(rowOrder);

    // скелет перестраиваем, только если изменился состав секций, а не при каждом событии:
    // порядок внутри секции задаёт сам append (существующий элемент переезжает, не создаётся)
    const layout = JSON.stringify([waiting.length > 0, done.length > 0, busy.length > 0, list.length > 0 && waiting.length === 0]);
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
      for (const el of board.querySelectorAll('[data-slot]')) slots.set(el.dataset.slot, el);
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

    const claudeCount = list.filter((c) => agentOf(c) === 'claude').length;
    const codexCount = list.length - claudeCount;
    const split = claudeCount && codexCount ? ` · Claude ${claudeCount} · Codex ${codexCount}` : '';
    setText(document.getElementById('subtitle'), list.length
      ? `${list.length} ${plural(list.length, 'сессия', 'сессии', 'сессий')} на связи${split}`
      : '');
    document.getElementById('counts').innerHTML = list.length
      ? `<span><b>${busy.length}</b>в работе</span>`
        + (done.length ? `<span><b>${done.length}</b>закончили ход</span>` : '')
        + (waiting.length ? `<span class="w"><b>${waiting.length}</b>ждут тебя</span>` : '')
      : '';
    document.title = (waiting.length ? `(${waiting.length}) ` : '') + 'Fleet';
    document.getElementById('mark').classList.toggle('alert', waiting.length > 0);
    updateFavicon(waiting.length);
    onWaiting(waiting);
  }

  // событий, которых борд не понимает, в норме нет: если появились - обновился агент
  // и часть статусов, скорее всего, перестала обновляться
  function renderUnknown() {
    const el = document.getElementById('unknown');
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
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function syncTimestamps() {
    const byId = Object.create(null);
    for (const c of data.sessions || []) byId[c.sessionId] = c;
    for (const el of board.querySelectorAll('.unit')) {
      const c = byId[el.dataset.id];
      if (c) syncLive(el, c);
    }
  }

  /* Искра: столбики досдвигаются по текущей минуте и перерисовываются только когда
     их набор изменился - тик идёт раз в секунду по всем строкам */
  function paintSpark(el, now) {
    const spark = el.querySelector('.spark');
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

  // раз в секунду двигаем время «на месте» (без ре-рендера) и подсвечиваем протухшие карточки
  function tickTimes() {
    const now = Date.now();
    for (const el of board.querySelectorAll('.unit')) {
      const wt = el.querySelector('.wt');
      if (wt) setText(wt, timerText(Number(wt.dataset.ts), now));
      const age = el.querySelector('.age');
      if (age) setText(age, ageText(Number(age.dataset.created), now));
      // «нет активности» только для активных статусов - waiting/ready законно ждут человека
      const busy = /\bs-(thinking|tool|working|error|compacting)\b/.test(el.className);
      const ts = Number(el.dataset.ts) || 0;
      const stale = busy && ts > 0 && now - ts > IDLE_MS;
      el.classList.toggle('stale', stale);
      if (stale) setText(el.querySelector('.idle-t'), waitingText(ts, now));
      paintSpark(el, now);
    }
  }

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

  function setLive(isLive) {
    const live = document.getElementById('live');
    live.classList.toggle('on', isLive);
    live.classList.toggle('off', !isLive);
    document.getElementById('liveText').textContent = isLive ? 'live' : 'нет связи';
  }

  board.addEventListener('click', (event) => {
    const removeButton = event.target.closest('.kill');
    if (removeButton) {
      onDrop(removeButton.dataset.kill);
      return;
    }
    const verdict = event.target.closest('[data-verdict]');
    if (verdict) {
      onPermission(verdict.closest('.unit').dataset.id, verdict.dataset.verdict);
      return;
    }
    // поле ввода и кнопка формы ответа: клик по ним не значит «перейти к сессии»
    if (event.target.closest('.reply')) return;
    const unit = event.target.closest('.unit');
    if (unit) onFocus(unit.dataset.id);
  });

  board.addEventListener('submit', async (event) => {
    const form = event.target.closest('.reply');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    const sent = await onReply(form.closest('.unit').dataset.id, text);
    if (sent) input.value = '';
  });

  // Карточка и строка содержат кнопки, поэтому сами остаются div с role="button".
  board.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const unit = event.target.closest('.unit');
    if (!unit || event.target.closest('.kill, .acts, .reply')) return;
    event.preventDefault();
    onFocus(unit.dataset.id);
  });

  return { setLive, tickTimes, update };
}
