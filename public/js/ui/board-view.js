import { IDLE_MS, STATUS_META, WAIT_BADGE, termColor } from '../board-config.js';
import {
  clock,
  durationText,
  escapeHtml,
  plural,
  projectMark,
  relativeTime,
  timeLeftText,
  waitingText,
} from '../lib/format.js';
import { updateFavicon } from './favicon.js';

export function createBoardView({ onWaiting, onFocus, onDrop }) {
  const board = document.getElementById('board');
  const empty = document.getElementById('empty');
  let data = { sessions: [] };
  let lastSig = null;
  let lastLayout = '';
  const slots = new Map();

    function sig(sessions) {
      return sessions.map((c) => [c.sessionId, c.project, c.worktree, c.status, c.reason, c.title, c.note, c.tool, c.toolInfo, c.terminal, c.waitingSince].join('\u0001')).join('\u0002');
    }
    function badgeFor(c) {
      if (c.status === 'waiting') return { cls: 'waiting', label: WAIT_BADGE[c.reason] || 'ждёт тебя' };
      return STATUS_META[c.status] || STATUS_META.ready;
    }
    /* worktree стоит в группе родительского проекта, поэтому имя копии надо назвать в самой
       карточке/строке - иначе две сессии одного проекта выглядят как правки одного и того же */
    function wtreeHtml(c) {
      return c.worktree ? `<span class="wtree" title="git worktree">${escapeHtml(c.worktree)}</span>` : '';
    }
    function cardHtml(c) {
      const b = badgeFor(c);
      const sid = '#' + String(c.sessionId || '').slice(0, 8);
      // при ожидании разрешения/ответа тул показываем тоже: именно он объясняет, на что
      // именно спрашивают («ждёт разрешения · Bash · git push --force»)
      const asking = c.status === 'waiting' && (c.reason === 'permission' || c.reason === 'question');
      const showTool = Boolean(c.tool) && (c.status === 'tool' || c.status === 'working' || c.status === 'error' || asking);
      const toolTxt = showTool ? escapeHtml(c.tool) + (c.toolInfo ? ' · ' + escapeHtml(c.toolInfo) : '') : '';
      const toolHtml = showTool ? `<div class="tool"><span class="d"></span><span class="tt">${toolTxt}</span></div>` : '';
      const noteHtml = c.note ? `<div class="note">${escapeHtml(c.note)}</div>` : '';
      // у красной карточки возраст не показываем: время ожидания уже стоит в бейдже,
      // а два времени рядом в узкой карточке съедают имя проекта
      const durHtml = c.createdAt && c.status !== 'waiting'
        ? `<span class="dur" data-created="${c.createdAt}">${durationText(c.createdAt)}</span>`
        : '';
      // без задачи карточка остаётся пустой намеренно: подпись вроде «готов к работе»
      // повторяла бейдж слово в слово и делала карточку выше без единого нового факта
      const titleHtml = c.title ? `<div class="title">${escapeHtml(c.title)}</div>` : '';
      const foot = c.terminal ? `<span class="term" style="--tc:${termColor(c.terminal)}">${escapeHtml(c.terminal)}</span>` : '<span class="src">claude-code</span>';
      // для красной карточки главная цифра - сколько она уже ждёт, поэтому она в бейдже
      // время ожидания берём из waitingSince, а не из updatedAt: updatedAt двигает любое
      // входящее событие, и счётчик обнулялся бы прямо во время ожидания
      const since = c.waitingSince || c.updatedAt || 0;
      const badgeHtml = c.status === 'waiting'
        ? `<span class="badge ${b.cls}">${b.label} · <span class="wt" data-ts="${since}">${waitingText(since)}</span></span>`
        : `<span class="badge ${b.cls}">${b.label}</span>`;
      return `<i class="glow"></i><button class="kill" data-kill="${escapeHtml(c.sessionId)}" title="убрать карточку с борда" aria-label="убрать карточку">×</button>
        <div class="chead">
          <span class="pname"><span class="proj">${escapeHtml(c.project)}</span>${wtreeHtml(c)}<span class="sid">${sid}</span>${durHtml}</span>
          ${badgeHtml}
        </div>
        ${titleHtml}
        ${noteHtml}
        ${toolHtml}
        <div class="foot"><span class="rel" data-ts="${c.updatedAt || 0}">${relativeTime(c.updatedAt)}</span><span class="idle">нет активности</span>${foot}</div>`;
    }

    /* Строка секции «в работе». Те же данные, что и в карточке, но в одну строку и общими
       колонками со всеми остальными строками: сессия в работе ничего от тебя не хочет,
       ей не нужна площадь карточки. Пустые ячейки всё равно выводим - без них grid
       съезжает и колонки перестают выстраиваться столбцом. */
    function rowHtml(c) {
      const b = badgeFor(c);
      const sid = '#' + String(c.sessionId || '').slice(0, 8);
      const showTool = Boolean(c.tool) && c.status !== 'ready';
      const toolTxt = showTool ? escapeHtml(c.tool) + (c.toolInfo ? ' · ' + escapeHtml(c.toolInfo) : '') : '';
      const toolCell = showTool ? `<span class="tool"><span class="d"></span><span class="tt">${toolTxt}</span></span>` : '<span></span>';
      const durCell = c.createdAt ? `<span class="dur" data-created="${c.createdAt}">${durationText(c.createdAt)}</span>` : '<span></span>';
      const term = c.terminal ? `<span class="term" style="--tc:${termColor(c.terminal)}">${escapeHtml(c.terminal)}</span>` : '<span class="src">claude-code</span>';
      return `<button class="kill" data-kill="${escapeHtml(c.sessionId)}" title="убрать карточку с борда" aria-label="убрать карточку">×</button>
        <span class="sid">${sid}</span>
        <span class="rtask">${wtreeHtml(c)}${escapeHtml(c.title || '')}</span>
        ${toolCell}
        <span class="badge ${b.cls}">${b.label}</span>
        ${durCell}
        <span class="rend"><span class="idle">нет активности</span>${term}</span>`;
    }

    /* Карточки живут между рендерами: элемент .card создаётся один раз на сессию и дальше
       только переставляется и обновляется внутри. Иначе пересоздание DOM под курсором гасит
       :hover (а кнопка удаления показывается именно по ховеру), сбрасывает фокус клавиатуры
       и способно увести клик мимо цели - при активной работе борд перерисовывается несколько
       раз в секунду. */
    const cardEls = new Map();

    function cardSig(c) {
      return [c.status, c.reason, c.title, c.note, c.tool, c.toolInfo, c.terminal, c.project, c.worktree, c.createdAt].join('\u0001');
    }

    /* shape - карточка (ждущие) или строка (в работе). Сессия переходит между секциями,
       и форма при этом меняется: тогда элемент пересоздаём, иначе внутри строки остался бы
       markup карточки. В остальных случаях элемент живёт и переиспользуется как раньше. */
    function cardEl(c, shape) {
      let entry = cardEls.get(c.sessionId);
      if (!entry || entry.shape !== shape) {
        const el = document.createElement('div');
        el.className = `unit ${shape} s-${c.status}`;
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
        el.dataset.id = c.sessionId;
        el.title = 'перейти к сессии (WebStorm или её терминал)';
        entry = { el, sig: null, shape };
        cardEls.set(c.sessionId, entry);
      }
      const sig = cardSig(c);
      if (sig !== entry.sig) {
        entry.sig = sig;
        // класс протухания ставит tickTimes, при смене статуса его нужно сохранить
        const stale = entry.el.classList.contains('stale') ? ' stale' : '';
        entry.el.className = `unit ${shape} s-${c.status}${stale}`;
        entry.el.innerHTML = shape === 'row' ? rowHtml(c) : cardHtml(c);
      }
      // протухание считаем от него же: у строки нет подписи «N сек назад», а знать
      // время последнего события всё равно надо
      entry.el.dataset.ts = c.updatedAt || 0;
      return entry.el;
    }

    /** Карточки исчезнувших сессий выкидываем, иначе Map растёт до перезагрузки страницы. */
    function forgetGoneCards(list) {
      const alive = new Set(list.map((c) => c.sessionId));
      for (const id of cardEls.keys()) {
        if (!alive.has(id)) cardEls.delete(id);
      }
    }

    function render() {
      const list = data.sessions || [];
      // кто дольше ждёт, тот выше: разбираешь самое залежавшееся, и появление новой красной
      // карточки не сдвигает те, что уже в списке
      const waiting = list.filter((c) => c.status === 'waiting')
        .sort((a, b) => (a.waitingSince || a.updatedAt || 0) - (b.waitingSince || b.updatedAt || 0));
      const busy = list.filter((c) => c.status !== 'waiting');

      // Object.create(null): имя проекта - это имя папки, оно может совпасть с полем прототипа
      // (constructor, toString, hasOwnProperty). На обычном {} это уронило бы рендер.
      const groups = Object.create(null);
      for (const c of busy) (groups[c.project] ||= []).push(c);
      const groupNames = Object.keys(groups).sort();
      for (const name of groupNames) {
        groups[name].sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
      }

      // скелет перестраиваем, только если изменилась сама раскладка (состав секций, групп
      // и порядок в них), а не при каждом обновлении статуса
      const layout = JSON.stringify([
        waiting.map((c) => c.sessionId),
        groupNames.map((name) => [name, groups[name].map((c) => c.sessionId)]),
        list.length > 0 && waiting.length === 0,
      ]);
      if (layout !== lastLayout) {
        lastLayout = layout;
        let html = '';
        if (waiting.length) {
          html += `<div class="sec"><div class="sec-head attn"><span class="ping"></span>Ждут тебя<span class="cnt">${waiting.length}</span></div>`;
          html += '<div class="grid" data-slot="waiting"></div></div>';
        } else if (list.length) {
          // спокойное состояние показываем явно: исчезающая секция неотличима от
          // "я просто смотрю не туда", а борд должен читаться одним взглядом издалека
          html += '<div class="sec"><div class="calm"><span class="dot"></span>'
            + '<b>Никто не ждёт</b><span>все сессии заняты делом</span></div></div>';
        }
        if (busy.length) {
          html += `<div class="sec"><div class="sec-head">В работе<span class="cnt">${busy.length}</span></div>`;
          for (const name of groupNames) {
            const mark = projectMark(name);
            const av = `--av-fg:hsl(${mark.hue} 62% 70%);--av-bg:hsl(${mark.hue} 55% 60% / .16);`
              + `--av-br:hsl(${mark.hue} 55% 62% / .34)`;
            html += `<div class="ghead"><span class="avatar" style="${av}" aria-hidden="true">${escapeHtml(mark.letters)}</span>`
              + `${escapeHtml(name)}<span class="cnt">${groups[name].length}</span></div>`;
            html += `<div class="rows" data-slot="g:${escapeHtml(name)}"></div>`;
          }
          html += '</div>';
        }
        board.innerHTML = html;
        slots.clear();
        for (const el of board.querySelectorAll('[data-slot]')) slots.set(el.dataset.slot, el);
      }

      // элементы раскладываем по слотам: существующие переезжают, а не пересоздаются
      if (waiting.length) {
        const slot = slots.get('waiting');
        if (slot) for (const c of waiting) slot.append(cardEl(c, 'card'));
      }
      for (const name of groupNames) {
        const slot = slots.get(`g:${name}`);
        if (slot) for (const c of groups[name]) slot.append(cardEl(c, 'row'));
      }
      forgetGoneCards(list);
      empty.hidden = list.length > 0;

      document.getElementById('counts').innerHTML =
        `<b>${list.length}</b> ${plural(list.length, 'сессия', 'сессии', 'сессий')}` +
        (waiting.length ? ` · <span class="w">${waiting.length} ждут тебя</span>` : '');
      document.title = (waiting.length ? `(${waiting.length}) ` : '') + 'Fleet';
      document.getElementById('mark').classList.toggle('alert', waiting.length > 0);
      updateFavicon(waiting.length);
      onWaiting(waiting);
    }

    // событий, которых борд не понимает, в норме нет: если появились - обновился Claude Code
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
        + '. Похоже, обновился Claude Code - часть статусов может не обновляться';
    }

    /* Окно лимита. Сервер шлёт только границы, обратный отсчёт двигаем сами в tickTimes:
       иначе значение висело бы неизменным между событиями хука. Часы конца окна считаем
       один раз здесь и держим в dataset - toLocaleTimeString в посекундном тике не нужен. */
    function renderUsage() {
      const el = document.getElementById('win');
      const u = data.usage;
      el.hidden = !u;
      if (!u) return;
      el.dataset.ends = u.endsAt;
      el.dataset.until = clock(u.endsAt);
      el.title = 'Окно лимита Claude, одно на весь аккаунт: все сессии во всех проектах'
        + ' и claude.ai жгут общую квоту. Стартовало в ' + clock(u.startedAt)
        + ', запросов внутри: ' + u.requests
        + '. Считается по локальным транскриптам, сессии из браузера сюда не попадают';
      paintUsage();
    }

    /* Формулировка прямая: «окно до 19:34» не объясняло, чьё это окно и что случится в 19:34.
       Плашка должна читаться с одного взгляда и без знания внутренностей борда. */
    function paintUsage() {
      const el = document.getElementById('win');
      if (el.hidden) return;
      const left = Number(el.dataset.ends) - Date.now();
      const open = left > 0;
      setText(document.getElementById('winLabel'), open ? 'до сброса лимита Claude' : 'лимит Claude свежий');
      setText(document.getElementById('winLeft'), open ? timeLeftText(left) : '');
      setText(document.getElementById('winAt'), open ? 'в ' + el.dataset.until : 'счётчик пойдёт со следующего запроса');
      el.classList.toggle('done', !open);
    }

    // присваивание textContent дёргает перерисовку узла даже тем же значением, а тик идёт
    // раз в секунду круглосуточно - сверяем перед записью
    function setText(node, value) {
      if (node.textContent !== value) node.textContent = value;
    }

    function syncTimestamps() {
      const byId = Object.create(null);
      for (const c of data.sessions || []) byId[c.sessionId] = c;
      for (const el of board.querySelectorAll('.unit')) {
        const c = byId[el.dataset.id];
        if (!c) continue;
        el.dataset.ts = c.updatedAt || 0;
        const rel = el.querySelector('.rel');
        if (rel && c.updatedAt != null) { rel.dataset.ts = c.updatedAt; rel.textContent = relativeTime(c.updatedAt); }
        // ожидание считаем от waitingSince: входящие события двигают updatedAt, но не его
        const wt = el.querySelector('.wt');
        const since = c.waitingSince || c.updatedAt;
        if (wt && since != null) { wt.dataset.ts = since; wt.textContent = waitingText(since); }
      }
    }
    // раз в секунду двигаем время «на месте» (без ре-рендера) и подсвечиваем протухшие карточки
    function tickTimes() {
      const now = Date.now();
      for (const el of board.querySelectorAll('.unit')) {
        const rel = el.querySelector('.rel');
        if (rel) rel.textContent = relativeTime(Number(rel.dataset.ts));
        const dur = el.querySelector('.dur');
        if (dur) dur.textContent = durationText(Number(dur.dataset.created));
        const wt = el.querySelector('.wt');
        if (wt) wt.textContent = waitingText(Number(wt.dataset.ts));
        // «нет активности» только для активных статусов - waiting/ready законно ждут человека.
        // Время берём с самого элемента: у строки нет подписи «N сек назад», а знать
        // момент последнего события всё равно нужно
        const busy = /\bs-(thinking|tool|working|error|compacting)\b/.test(el.className);
        const ts = Number(el.dataset.ts) || 0;
        el.classList.toggle('stale', busy && ts > 0 && now - ts > IDLE_MS);
      }
      paintUsage();
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
    renderUsage();
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
    const unit = event.target.closest('.unit');
    if (unit) onFocus(unit.dataset.id);
  });

  // Карточка и строка содержат кнопку удаления, поэтому сами остаются div с role="button".
  board.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const unit = event.target.closest('.unit');
    if (!unit || event.target.closest('.kill')) return;
    event.preventDefault();
    onFocus(unit.dataset.id);
  });

  return { setLive, tickTimes, update };
}
