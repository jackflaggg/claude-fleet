#!/usr/bin/env bash
# Установка claude-fleet: конфиг, хуки в ~/.claude/settings.json, launchd-агент.
# Идемпотентно: можно гонять повторно после переезда папки или обновления node.
#
# Все пути вычисляются от расположения репозитория, ничего не зашито - поэтому скрипт
# переживает переезд на другую машину, где другой домашний каталог и другой node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${FLEET_LABEL:-com.rasulkiller.claude-fleet}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SETTINGS="$HOME/.claude/settings.json"
HOOK="$ROOT/hooks/report.sh"

say() { printf '%s\n' "$*"; }

# 1. Конфиг ------------------------------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  say "создал .env из шаблона"
else
  say ".env уже есть, не трогаю"
fi

# 2. Node для launchd --------------------------------------------------------
# launchd стартует без твоего профиля, поэтому нужен абсолютный путь. Алиас fnm
# предпочтительнее того, что сейчас в PATH: путь конкретной версии (multishell)
# протухнет при следующем обновлении node, а алиас default переживёт его.
FNM_DEFAULT="$HOME/.local/share/fnm/aliases/default/bin/node"
if [ -x "$FNM_DEFAULT" ]; then
  NODE_BIN="$FNM_DEFAULT"
else
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  say "не нашёл node - поставь его и запусти скрипт снова" >&2
  exit 1
fi
say "node для агента: $NODE_BIN"
# Путь вида .../fnm_multishells/<pid>_<timestamp>/bin/node принадлежит текущей сессии
# терминала и исчезнет вместе с ней: агент потом молча уйдёт в петлю перезапусков.
case "$NODE_BIN" in
  *fnm_multishells*)
    say "  внимание: это временный путь fnm текущей сессии, он протухнет."
    say "  зафиксируй дефолт (fnm default <версия>) и перезапусти установку"
    ;;
esac

# 3. Хуки в ~/.claude/settings.json ------------------------------------------
# Мержим через node: settings.json может содержать хуки других тулов и правки руками,
# затирать его целиком нельзя. Перед записью делаем бэкап.
mkdir -p "$(dirname "$SETTINGS")"
"$NODE_BIN" - "$SETTINGS" "$HOOK" <<'NODE'
const { readFileSync, writeFileSync, existsSync, copyFileSync } = require('node:fs');
const [settingsPath, hookPath] = process.argv.slice(2);

// PreToolUse/PostToolUse с matcher "*" ловят каждый вызов инструмента - это и даёт
// строку "над чем сейчас работает". SubagentStop намеренно не подключаем: борд его
// игнорирует, а лишний хук стоит времени на каждом субагенте.
//
// StopFailure/PreCompact/PostCompact закрывают слепые зоны, где сессия занята или уже
// мертва, но событий не шлёт, и карточка врёт: оборвавшийся на ошибке API ход выглядел
// как "думает", а компакция контекста - как зависшая сессия. События редкие, цена нулевая.
const EVENTS = [
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

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    console.error(`settings.json не парсится (${error.message}) - чинить руками, ничего не меняю`);
    process.exit(1);
  }
  copyFileSync(settingsPath, `${settingsPath}.bak`);
}

settings.hooks ??= {};
let added = 0;
for (const [event, matcher] of EVENTS) {
  settings.hooks[event] ??= [];
  const already = settings.hooks[event].some((group) =>
    (group?.hooks ?? []).some((h) => h?.command === hookPath),
  );
  if (already) continue;
  const group = { hooks: [{ type: 'command', command: hookPath }] };
  if (matcher) group.matcher = matcher;
  settings.hooks[event].push(group);
  added += 1;
}

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(added ? `хуки: добавил ${added} шт. (бэкап: settings.json.bak)` : 'хуки: уже на месте');
NODE

# 4. launchd-агент -----------------------------------------------------------
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <!-- перезапуск только после падения: остановленный вручную агент остаётся остановленным -->
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- пауза между перезапусками: если порт занят, лог не заливается петлёй -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <!-- процесс почти всё время спит, системе можно не тратить на него батарею -->
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$ROOT/fleet.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/fleet.error.log</string>
</dict>
</plist>
PLIST_EOF
say "plist записан: $PLIST"

# bootout может честно вернуть ошибку "агент не загружен" - это не повод падать
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
say "агент перезагружен"

# 5. Проверка ----------------------------------------------------------------
PORT="${FLEET_PORT:-}"
if [ -z "$PORT" ] && [ -r "$ROOT/.env" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    if [ "$key" = "FLEET_PORT" ]; then
      value="${value%%#*}"; value="${value//[[:space:]]/}"; value="${value//\"/}"
      PORT="$value"
    fi
  done < "$ROOT/.env"
fi
PORT="${PORT:-4319}"

sleep 1
if curl -sf -o /dev/null "http://localhost:$PORT/"; then
  say ""
  say "готово: борд на http://localhost:$PORT"
  say "открыть окном-приложением: $ROOT/scripts/board.sh"
else
  say ""
  say "борд не ответил на порту $PORT - смотри $ROOT/fleet.log и $ROOT/fleet.error.log" >&2
  exit 1
fi
