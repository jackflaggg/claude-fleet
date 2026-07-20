#!/usr/bin/env bash
# Снимает claude-fleet: гасит launchd-агент, убирает свои хуки из ~/.claude/settings.json.
# Репозиторий, .env и fleet.log не трогает - удаляй руками, если нужно.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${FLEET_LABEL:-com.rasulkiller.claude-fleet}"
BOARD_LABEL="$LABEL-board"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BOARD_PLIST="$HOME/Library/LaunchAgents/$BOARD_LABEL.plist"
SETTINGS="$HOME/.claude/settings.json"
HOOK="$ROOT/hooks/report.sh"

# Оба агента: агент автозапуска борда ставится не всегда, но пережить снятие тулзы не должен
for label in "$LABEL" "$BOARD_LABEL"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
done
rm -f "$PLIST" "$BOARD_PLIST"
echo "агенты сняты"

if [ -f "$SETTINGS" ]; then
  node - "$SETTINGS" "$HOOK" <<'NODE'
const { readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const [settingsPath, hookPath] = process.argv.slice(2);

let settings;
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (error) {
  console.error(`settings.json не парсится (${error.message}) - хуки убери руками`);
  process.exit(1);
}
copyFileSync(settingsPath, `${settingsPath}.bak`);

let removed = 0;
for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
  // выкидываем только свои команды, чужие хуки в той же группе остаются жить
  const kept = groups
    .map((group) => {
      const hooks = (group?.hooks ?? []).filter((h) => {
        const mine = h?.command === hookPath;
        if (mine) removed += 1;
        return !mine;
      });
      return { ...group, hooks };
    })
    .filter((group) => group.hooks.length > 0);
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
}
if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`хуки: убрал ${removed} шт. (бэкап: settings.json.bak)`);
NODE
fi
