import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFocus } from '../focus.js';

const LAUNCHER = '/usr/local/bin/webstorm';
const APP = 'WebStorm';

/** Всё, кроме перечисленных путей, считаем не-проектом. */
function deps(projects = [], { launcher = LAUNCHER, app = APP } = {}) {
  return { launcher, app, isProjectDir: (cwd) => projects.includes(cwd) };
}

test('сессия в терминале IDE и папка - проект: лаунчер переключает на нужное окно', () => {
  const card = { appId: 'com.jetbrains.WebStorm', cwd: '/p/school-back' };
  assert.deepEqual(resolveFocus(card, deps(['/p/school-back'])), {
    cmd: LAUNCHER,
    args: ['/p/school-back'],
  });
});

test('сессия в обычном терминале: выводим вперёд именно его, папку проектом не открываем', () => {
  const card = { appId: 'org.alacritty', cwd: '/Users/x' };
  assert.deepEqual(resolveFocus(card, deps(['/Users/x'])), {
    cmd: 'open',
    args: ['-b', 'org.alacritty'],
  });
});

test('терминал IDE, но папка не проект (claude из home): поднимаем само приложение', () => {
  const card = { appId: 'com.jetbrains.WebStorm', cwd: '/Users/x' };
  assert.deepEqual(resolveFocus(card, deps([])), {
    cmd: 'open',
    args: ['-b', 'com.jetbrains.WebStorm'],
  });
});

test('терминал ещё неизвестен, но папка - проект: открываем хотя бы проект', () => {
  const card = { cwd: '/p/demo' };
  assert.deepEqual(resolveFocus(card, deps(['/p/demo'])), { cmd: LAUNCHER, args: ['/p/demo'] });
});

test('лаунчера на машине нет - фолбэк на open -a с именем приложения', () => {
  const card = { appId: 'com.jetbrains.WebStorm', cwd: '/p/demo' };
  assert.deepEqual(resolveFocus(card, deps(['/p/demo'], { launcher: null })), {
    cmd: 'open',
    args: ['-a', APP, '/p/demo'],
  });
});

test('нет ни лаунчера, ни имени приложения - честный null, борд покажет подсказку', () => {
  const card = { cwd: '/p/demo' };
  assert.equal(resolveFocus(card, deps(['/p/demo'], { launcher: null, app: '' })), null);
});

test('ни терминала, ни проекта - идти некуда', () => {
  assert.equal(resolveFocus({ cwd: '/Users/x' }, deps([])), null);
  assert.equal(resolveFocus({}, deps([])), null);
});

test('любая другая IDE JetBrains работает так же, как WebStorm', () => {
  const card = { appId: 'com.jetbrains.pycharm', cwd: '/p/ml' };
  assert.deepEqual(resolveFocus(card, deps(['/p/ml'])), { cmd: LAUNCHER, args: ['/p/ml'] });
});

test('битая карточка (нестроковые поля) не роняет решение', () => {
  assert.equal(resolveFocus({ appId: 42, cwd: null }, deps([])), null);
  assert.equal(resolveFocus(null, deps([])), null);
});
