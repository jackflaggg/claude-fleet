#!/usr/bin/env node
/**
 * Слияние и снятие хуков Fleet в файле настроек агента: одна программа вместо четырёх
 * inline-скриптов в install.sh и uninstall.sh.
 *
 *   node hooks-merge.mjs <settings.json> <hook-path> --agent claude|codex [--remove]
 *
 * Чужие хуки в том же файле остаются жить: добавляются и убираются только наши команды.
 * Чистые функции addHooks/removeHooks не трогают диск и покрыты test/hooks-merge.test.js;
 * main читает, бэкапит и пишет.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// PreToolUse/PostToolUse с matcher "*" ловят каждый вызов инструмента - это и даёт
// строку "над чем сейчас работает". SubagentStop намеренно не подключаем: борд его
// игнорирует, а лишний хук стоит времени на каждом субагенте.
//
// StopFailure/PreCompact/PostCompact закрывают слепые зоны, где сессия занята или уже
// мертва, но событий не шлёт, и карточка врёт: оборвавшийся на ошибке API ход выглядел
// как "думает", а компакция контекста - как зависшая сессия. События редкие, цена нулевая.
export const CLAUDE_EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', '*'],
  ['PostToolUse', '*'],
  ['PostToolUseFailure', '*'],
  ['Notification', null],
  ['Stop', null],
  ['StopFailure', null],
  ['PreCompact', null],
  ['PostCompact', null],
  ['SessionEnd', null],
];

// Codex официально поддерживает ту же lifecycle-модель, поэтому используем push-события,
// а не поллинг ~/.codex/sessions. В простое это ровно ноль CPU/IO/RAM.
export const CODEX_EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', '*'],
  ['PermissionRequest', '*'],
  ['PostToolUse', '*'],
  ['Stop', null],
  ['PreCompact', '*'],
  ['PostCompact', '*'],
  ['SessionEnd', null],
];

const CODEX_DESCRIPTION = 'Lifecycle hooks, including local Fleet dashboard reporting.';

const AGENTS = {
  claude: {
    events: CLAUDE_EVENTS,
    label: 'хуки',
    fileName: 'settings.json',
    entry: (command) => ({ type: 'command', command }),
    // прежние установки писали путь голым: такие записи наши, их переписываем на месте
    legacyForms: (hookPath) => [hookPath],
    prepare: () => {},
  },
  codex: {
    events: CODEX_EVENTS,
    label: 'хуки Codex',
    fileName: 'hooks.json',
    entry: (command) => ({ type: 'command', command, timeout: 1 }),
    legacyForms: () => [],
    prepare: (settings) => { settings.description ??= CODEX_DESCRIPTION; },
  },
};

/**
 * Команду хука агент запускает через shell, поэтому путь в кавычках: пробел в пути
 * репозитория иначе ломает каждый вызов инструмента во всех сессиях.
 */
export function hookCommand(hookPath, agent) {
  const quoted = `"${hookPath.replaceAll('"', '\\"')}"`;
  return agent === 'codex' ? `FLEET_AGENT=codex ${quoted}` : quoted;
}

function spec(agent) {
  const found = AGENTS[agent];
  if (!found) throw new Error(`--agent принимает claude|codex, получил ${agent}`);
  return found;
}

function clone(value) {
  return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

/** Добавляет наши хуки на каждое событие агента. Возвращает копию настроек и счётчики. */
export function addHooks(source, hookPath, agent) {
  const { events, entry, legacyForms, prepare } = spec(agent);
  const settings = clone(source);
  const command = hookCommand(hookPath, agent);
  const mine = new Set([command, ...legacyForms(hookPath)]);

  prepare(settings);
  settings.hooks ??= {};
  let added = 0;
  let migrated = 0;
  for (const [event, matcher] of events) {
    settings.hooks[event] ??= [];
    let already = false;
    for (const group of settings.hooks[event]) {
      for (const hook of group?.hooks ?? []) {
        if (!mine.has(hook?.command)) continue;
        already = true;
        if (hook.command !== command) {
          hook.command = command;
          migrated += 1;
        }
      }
    }
    if (already) continue;
    const group = { hooks: [entry(command)] };
    if (matcher) group.matcher = matcher;
    settings.hooks[event].push(group);
    added += 1;
  }
  return { settings, added, migrated };
}

/** Убирает только наши команды; чужие хуки в той же группе остаются, пустые группы и события уходят. */
export function removeHooks(source, hookPath, agent) {
  const { legacyForms } = spec(agent);
  const settings = clone(source);
  const mine = new Set([hookCommand(hookPath, agent), ...legacyForms(hookPath)]);

  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((group) => {
        const hooks = (group?.hooks ?? []).filter((hook) => {
          const ours = mine.has(hook?.command);
          if (ours) removed += 1;
          return !ours;
        });
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { settings, removed };
}

export function parseArgs(argv) {
  const positional = [];
  let agent = null;
  let remove = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') agent = argv[++i];
    else if (arg === '--remove') remove = true;
    else if (arg.startsWith('--')) throw new Error(`неизвестный флаг ${arg}`);
    else positional.push(arg);
  }
  const [settingsPath, hookPath] = positional;
  if (!settingsPath || !hookPath || positional.length > 2) {
    throw new Error('нужно: <settings.json> <hook-path> --agent claude|codex [--remove]');
  }
  if (!agent) throw new Error('нужен --agent claude|codex');
  spec(agent);
  return { settingsPath, hookPath, agent, remove };
}

/** Читает файл, применяет операцию, бэкапит и пишет. Битый JSON: exit 1, файл не тронут. */
export function main(argv, io = { stdout: console.log, stderr: console.error }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(error.message);
    return 2;
  }
  const { settingsPath, hookPath, agent, remove } = args;
  const { label, fileName } = spec(agent);

  const existed = existsSync(settingsPath);
  if (remove && !existed) return 0;

  let settings = {};
  if (existed) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      io.stderr(`${fileName} не парсится (${error.message}) - ${remove ? 'хуки убери руками' : 'чинить руками, ничего не меняю'}`);
      return 1;
    }
  }
  const backup = existed ? ` (бэкап: ${fileName}.bak)` : '';

  if (remove) {
    const result = removeHooks(settings, hookPath, agent);
    copyFileSync(settingsPath, `${settingsPath}.bak`);
    writeFileSync(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`);
    io.stdout(`${label}: убрал ${result.removed} шт.${backup}`);
    return 0;
  }

  const result = addHooks(settings, hookPath, agent);
  if (existed) copyFileSync(settingsPath, `${settingsPath}.bak`);
  writeFileSync(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`);
  const report = [];
  if (result.added) report.push(`добавил ${result.added} шт.`);
  if (result.migrated) report.push(`взял в кавычки путь у ${result.migrated} шт.`);
  const codexNote = agent === 'codex' && result.added ? ' (подтверди один раз через /hooks)' : '';
  io.stdout(report.length ? `${label}: ${report.join(', ')}${codexNote}${backup}` : `${label}: уже на месте`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
