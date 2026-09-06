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
CODEX_HOOKS="$HOME/.codex/hooks.json"
HOOK="$ROOT/hooks/report.sh"

# Оба агента: агент автозапуска борда ставится не всегда, но пережить снятие тулзы не должен
for label in "$LABEL" "$BOARD_LABEL"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
done
rm -f "$PLIST" "$BOARD_PLIST"
echo "агенты сняты"

# Убираем только свои команды (в кавычках и голой формой прежних установок), чужие хуки
# остаются; файла нет - скрипт молча выходит. Логика в scripts/hooks-merge.mjs с тестами.
node "$ROOT/scripts/hooks-merge.mjs" "$SETTINGS" "$HOOK" --agent claude --remove
node "$ROOT/scripts/hooks-merge.mjs" "$CODEX_HOOKS" "$HOOK" --agent codex --remove
