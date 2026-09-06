/**
 * Строители разметки борда: чистые функции «карточка → строка HTML», без DOM и без часов
 * внутри (время приходит параметром). Склейка с документом живёт в `board-view.js`,
 * поэтому всё, что здесь, гоняется `node --test` без эмулятора браузера.
 */
import { AGENT_LABEL, STATUS_META, WAIT_BADGE, termColor } from '../board-config.js';
import { ACTIVITY_BARS } from '../lib/activity.js';
import { SECTION, STATUS, WAIT_REASON, agentOf, sectionOf } from '../lib/domain.js';
import { ageText, escapeHtml, projectMark, timerText } from '../lib/format.js';

/** @import { Card } from '../../../types.js' */

/** @param {string} name имя проекта */
export function avatarHtml(name) {
  const mark = projectMark(name);
  const style = `--av-fg:hsl(${mark.hue} 62% 70%);--av-bg:hsl(${mark.hue} 55% 60% / .16);--av-br:hsl(${mark.hue} 55% 62% / .34)`;
  return `<span class="avatar" style="${style}" aria-hidden="true">${escapeHtml(mark.letters)}</span>`;
}

/* агент подписан монохромно рядом с терминалом: своего цвета у него нет, цвет на борде
   значит либо проект (монограмма), либо «нужен ты» (красный) */
export function originHtml(c, extraClass = '') {
  const terminal = c.terminal
    ? `<span class="term" style="--tc:${termColor(c.terminal)}">${escapeHtml(c.terminal)}</span>`
    : '';
  return `<span class="origin ${extraClass}"><span class="agent">${AGENT_LABEL[agentOf(c)]}</span>${terminal}</span>`;
}

/* worktree стоит в группе родительского проекта, поэтому имя копии надо назвать в самой
   карточке/строке - иначе две сессии одного проекта выглядят как правки одного и того же */
export function wtreeHtml(c) {
  return c.worktree ? `<span class="wtree" title="git worktree">${escapeHtml(c.worktree)}</span>` : '';
}

export function toolHtml(c) {
  if (!c.tool) return '';
  const info = c.toolInfo ? ' · ' + escapeHtml(c.toolInfo) : '';
  return `<span class="tool"><span class="tt"><span class="tn">${escapeHtml(c.tool)}</span>${info}</span></span>`;
}

/** Поля, от которых зависит разметка: совпала сигнатура - innerHTML не трогаем.
    Разделитель нужен, иначе «ab»+«c» и «a»+«bc» в соседних полях дали бы одну сигнатуру.
    @param {Card} c */
export function cardSig(c) {
  return [
    c.agent, c.status, c.reason, c.title, c.note, c.tool, c.toolInfo, c.terminal, c.project,
    c.worktree, c.createdAt, c.waitingSince, c.channel, c.permission?.requestId,
  ].join('\x01');
}

export function badgeFor(c) {
  if (c.status === STATUS.WAITING) {
    return { cls: sectionOf(c) === SECTION.DONE ? 'done' : 'waiting', label: WAIT_BADGE[c.reason] || 'ждёт тебя' };
  }
  return STATUS_META[c.status] || STATUS_META[STATUS.READY];
}

/* Ответ прямо с борда: только когда к сессии подключён канал (FLEET_CHANNEL=1 и сессия
   запущена с каналом fleet). Без канала карточка остаётся как есть - кнопки-обманки
   хуже их отсутствия. */
export function actsHtml(c) {
  if (!c.channel) return '';
  if (c.permission) {
    return '<span class="acts"><button class="act ok" type="button" data-verdict="allow">Разрешить</button>'
      + '<button class="act no" type="button" data-verdict="deny">Отказать</button>'
      + '<span class="needs">через канал fleet</span></span>';
  }
  if (c.reason === WAIT_REASON.PERMISSION) return '';
  return '<form class="reply"><input type="text" placeholder="Ответить сессии…" aria-label="ответ сессии" maxlength="4000">'
    + '<button class="act" type="submit">Отправить</button><span class="needs">через канал fleet</span></form>';
}

export function killHtml(c) {
  return `<button class="kill" type="button" data-kill="${escapeHtml(c.sessionId)}" title="убрать карточку с борда" aria-label="убрать карточку">×</button>`;
}

/* Карточка ожидания. Главная цифра - сколько она уже ждёт, крупно справа как задержка
   на табло. Текст уведомления объясняет, ЧЕГО ждут; при разрешении рядом стоит тул,
   на который спрашивают, и решение принимается не вставая. У закончившей ход карточки
   та же форма, но без красного и без дыхания: она не зовёт, а просто стоит без промпта.
   @param {Card} c @param {number} [now] */
export function cardHtml(c, now = Date.now()) {
  const b = badgeFor(c);
  const done = sectionOf(c) === SECTION.DONE;
  const asking = c.reason === WAIT_REASON.PERMISSION || c.reason === WAIT_REASON.QUESTION;
  const ask = c.note || c.permission?.description || '';
  const askHtml = ask ? `<div class="ask">${escapeHtml(ask)}</div>` : '';
  const taskHtml = c.title ? `<div class="task">${escapeHtml(c.title)}</div>` : '';
  // время ожидания берём из waitingSince, а не из updatedAt: updatedAt двигает любое
  // входящее событие, и счётчик обнулялся бы прямо во время ожидания
  const since = c.waitingSince || c.updatedAt || 0;
  return `${done ? '' : '<i class="glow"></i>'}${killHtml(c)}
      <div class="top"><span class="badge ${b.cls}">${b.label}</span>
        <span class="who">${avatarHtml(c.project)}<span class="proj">${escapeHtml(c.project)}</span>${wtreeHtml(c)}</span></div>
      <div class="timer"><b class="wt" data-ts="${since}">${timerText(since, now)}</b><span>${done ? 'простаивает' : 'ждёт'}</span></div>
      <div class="body">${askHtml}${asking ? toolHtml(c) : ''}${taskHtml}</div>
      <div class="foot">${actsHtml(c)}${originHtml(c)}</div>`;
}

/* Строка секции «в работе»: ячейки берут колонки общей таблицы через subgrid, поэтому
   статусы читаются столбцом. Пустые ячейки всё равно выводим - без них сетка съезжает.
   @param {Card} c @param {number} [now] */
export function rowHtml(c, now = Date.now()) {
  const b = badgeFor(c);
  const task = c.title ? escapeHtml(c.title) : '<span class="none">новая сессия, промпта ещё нет</span>';
  const bars = '<i></i>'.repeat(ACTIVITY_BARS);
  return `<div class="c-proj">${avatarHtml(c.project)}<span class="proj">${escapeHtml(c.project)}</span></div>
      <div class="c-task">${wtreeHtml(c)}${task}</div>
      <div class="c-act">${c.status !== STATUS.READY ? toolHtml(c) : ''}<span class="idle-note">нет активности <span class="idle-t"></span></span></div>
      <span class="spark">${bars}</span>
      <span class="badge ${b.cls}">${b.label}</span>
      <span class="age" data-created="${c.createdAt || 0}">${ageText(c.createdAt, now)}</span>
      ${originHtml(c, 'c-origin')}
      <div class="c-end">${killHtml(c)}</div>`;
}
