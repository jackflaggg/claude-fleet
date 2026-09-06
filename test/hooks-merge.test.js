import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  addHooks,
  hookCommand,
  parseArgs,
  removeHooks,
} from '../scripts/hooks-merge.mjs';

const SCRIPT = new URL('../scripts/hooks-merge.mjs', import.meta.url).pathname;
const HOOK = '/Users/me/My Projects/claude-fleet/hooks/report.sh';
const FOREIGN = { type: 'command', command: '/opt/other-tool/hook.sh' };

function foreignSettings() {
  return {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ ...FOREIGN }] }],
      Stop: [{ hooks: [{ ...FOREIGN }] }],
    },
  };
}

function commandsOf(settings, event) {
  return (settings.hooks?.[event] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
}

test('команда хука: путь в кавычках, у Codex с префиксом агента', () => {
  assert.equal(hookCommand(HOOK, 'claude'), `"${HOOK}"`);
  assert.equal(hookCommand(HOOK, 'codex'), `FLEET_AGENT=codex "${HOOK}"`);
  assert.equal(hookCommand('/a/"b"/report.sh', 'claude'), '"/a/\\"b\\"/report.sh"', 'кавычка в пути экранируется');
});

test('чужой хук переживает установку и снятие, наши события исчезают целиком', () => {
  const installed = addHooks(foreignSettings(), HOOK, 'claude');
  assert.equal(installed.added, CLAUDE_EVENTS.length);
  assert.equal(installed.migrated, 0);
  for (const [event] of CLAUDE_EVENTS) {
    assert.ok(commandsOf(installed.settings, event).includes(`"${HOOK}"`), `нет нашего хука на ${event}`);
  }
  assert.deepEqual(installed.settings.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [FOREIGN] }, 'чужая группа не тронута');
  assert.equal(installed.settings.hooks.PreToolUse[1].matcher, '*');
  assert.equal(installed.settings.permissions.allow[0], 'Bash(ls:*)', 'остальные настройки не тронуты');

  const again = addHooks(installed.settings, HOOK, 'claude');
  assert.equal(again.added, 0, 'повторная установка ничего не добавляет');

  const removed = removeHooks(again.settings, HOOK, 'claude');
  assert.equal(removed.removed, CLAUDE_EVENTS.length);
  assert.deepEqual(removed.settings.hooks, foreignSettings().hooks, 'после снятия остались только чужие хуки');
  assert.deepEqual(Object.keys(removed.settings.hooks).sort(), ['PreToolUse', 'Stop']);
});

test('голый путь прежних установок берётся в кавычки на месте, без дубля', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] } };
  const { settings: next, added, migrated } = addHooks(settings, HOOK, 'claude');
  assert.equal(migrated, 1);
  assert.equal(added, CLAUDE_EVENTS.length - 1);
  assert.deepEqual(commandsOf(next, 'Stop'), [`"${HOOK}"`]);

  const { settings: cleaned, removed } = removeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] } }, HOOK, 'claude');
  assert.equal(removed, 1, 'снятие узнаёт и голую форму');
  assert.equal(cleaned.hooks, undefined, 'пустой hooks удаляется целиком');
});

test('хуки Codex: свой префикс, таймаут и описание файла', () => {
  const { settings, added } = addHooks({}, HOOK, 'codex');
  assert.equal(added, CODEX_EVENTS.length);
  assert.equal(settings.description, 'Lifecycle hooks, including local Fleet dashboard reporting.');
  const first = settings.hooks.PreToolUse[0];
  assert.deepEqual(first, { matcher: '*', hooks: [{ type: 'command', command: `FLEET_AGENT=codex "${HOOK}"`, timeout: 1 }] });

  const { settings: kept, removed } = removeHooks({ ...settings, description: 'mine' }, HOOK, 'codex');
  assert.equal(removed, CODEX_EVENTS.length);
  assert.equal(kept.description, 'mine', 'описание при снятии не трогаем');
  assert.equal(kept.hooks, undefined);
});

test('разбор аргументов: агент обязателен, лишнее это ошибка', () => {
  assert.deepEqual(parseArgs(['/s.json', HOOK, '--agent', 'codex', '--remove']), {
    settingsPath: '/s.json', hookPath: HOOK, agent: 'codex', remove: true,
  });
  assert.throws(() => parseArgs(['/s.json', HOOK]), /--agent/);
  assert.throws(() => parseArgs(['/s.json', HOOK, '--agent', 'gemini']), /claude\|codex/);
  assert.throws(() => parseArgs(['/s.json', HOOK, '--agent', 'claude', '--bogus']), /--bogus/);
});

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI: битый JSON даёт exit 1 без записи и без бэкапа', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-hooks-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, '{ "hooks": ');
  const result = runCli([file, HOOK, '--agent', 'claude']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /не парсится/);
  assert.equal(readFileSync(file, 'utf8'), '{ "hooks": ', 'файл не тронут');
  assert.equal(existsSync(`${file}.bak`), false);
});

test('CLI: установка и снятие возвращают файл к чужим хукам, бэкап пишется', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-hooks-'));
  const file = join(dir, 'settings.json');
  const original = `${JSON.stringify(foreignSettings(), null, 2)}\n`;
  writeFileSync(file, original);

  const add = runCli([file, HOOK, '--agent', 'claude']);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /добавил 11 шт\./);
  assert.ok(existsSync(`${file}.bak`));
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), original, 'бэкап это состояние до записи');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionEnd[0].hooks[0].command, `"${HOOK}"`);

  const same = runCli([file, HOOK, '--agent', 'claude']);
  assert.match(same.stdout, /уже на месте/);

  const remove = runCli([file, HOOK, '--agent', 'claude', '--remove']);
  assert.equal(remove.status, 0, remove.stderr);
  assert.match(remove.stdout, /убрал 11 шт\./);
  assert.equal(readFileSync(file, 'utf8'), original, 'после снятия файл байт в байт как до установки');
});

test('CLI: файла настроек нет - установка создаёт его, снятие ничего не делает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-hooks-'));
  const file = join(dir, 'hooks.json');
  const remove = runCli([file, HOOK, '--agent', 'codex', '--remove']);
  assert.equal(remove.status, 0);
  assert.equal(existsSync(file), false);

  const add = runCli([file, HOOK, '--agent', 'codex']);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(existsSync(`${file}.bak`), false, 'бэкапить было нечего');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.PermissionRequest[0].hooks[0].timeout, 1);
});
