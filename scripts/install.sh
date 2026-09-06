#!/usr/bin/env bash
# Установка claude-fleet: конфиг, хуки в ~/.claude/settings.json, launchd-агент.
# Идемпотентно: можно гонять повторно после переезда папки или обновления node.
#
# Все пути вычисляются от расположения репозитория, ничего не зашито - поэтому скрипт
# переживает переезд на другую машину, где другой домашний каталог и другой node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${FLEET_LABEL:-com.rasulkiller.claude-fleet}"
BOARD_LABEL="$LABEL-board"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BOARD_PLIST="$HOME/Library/LaunchAgents/$BOARD_LABEL.plist"
SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"
HOOK="$ROOT/hooks/report.sh"

say() { printf '%s\n' "$*"; }

# Значение переменной из .env: окружение важнее файла, комментарии и кавычки отбрасываем
env_value() {
  local key="$1" fallback="$2" found="" line_key line_value
  eval "found=\${$key:-}"
  if [ -z "$found" ] && [ -r "$ROOT/.env" ]; then
    while IFS='=' read -r line_key line_value || [ -n "$line_key" ]; do
      [ "$line_key" = "$key" ] || continue
      line_value="${line_value%%#*}"
      line_value="${line_value//[[:space:]]/}"
      found="${line_value//\"/}"
    done < "$ROOT/.env"
  fi
  printf '%s\n' "${found:-$fallback}"
}

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

# 3. Хуки в ~/.claude/settings.json и ~/.codex/hooks.json ---------------------
# Слияние делает scripts/hooks-merge.mjs (список событий и форма команды живут там,
# покрыто test/hooks-merge.test.js): settings.json может содержать хуки других тулов и
# правки руками, затирать его целиком нельзя. Перед записью скрипт делает бэкап.
mkdir -p "$(dirname "$SETTINGS")" "$(dirname "$CODEX_HOOKS")"
"$NODE_BIN" "$ROOT/scripts/hooks-merge.mjs" "$SETTINGS" "$HOOK" --agent claude
"$NODE_BIN" "$ROOT/scripts/hooks-merge.mjs" "$CODEX_HOOKS" "$HOOK" --agent codex

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
# macOS иногда отвечает EIO, если bootstrap попал в короткое окно, пока bootout ещё
# освобождает job. Один повтор через секунду закрывает гонку; бесконечной петли здесь нет.
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  say "launchd ещё освобождает агент, повторяю запуск через секунду"
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi
say "агент перезагружен"

# 5. Автозапуск окна борда ---------------------------------------------------
# Отдельным агентом, а не строкой в основном: борд можно закрыть и открыть заново,
# не трогая сервер, а сервер пережить перезагрузку без окна.
if [ "$(env_value FLEET_AUTOOPEN 1)" = "1" ]; then
  cat > "$BOARD_PLIST" <<BOARD_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$BOARD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/board.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <!-- окно открывается один раз при логине, поэтому KeepAlive тут не нужен:
       закрыл борд руками - он и остаётся закрытым до следующего входа -->
  <key>RunAtLoad</key>
  <true/>
  <!-- скрипт сам ждёт сервер и сам проверяет, не открыт ли борд уже, но если браузер
       всё же окажется в группе процессов агента, launchd не должен гасить его вместе с job -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$ROOT/fleet.board.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/fleet.board.log</string>
</dict>
</plist>
BOARD_EOF
  launchctl bootout "gui/$(id -u)/$BOARD_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$BOARD_PLIST"
  say "автозапуск борда включён: $BOARD_PLIST"
else
  # FLEET_AUTOOPEN=0 должен и снимать ранее поставленный агент, иначе выключение не работает
  launchctl bootout "gui/$(id -u)/$BOARD_LABEL" 2>/dev/null || true
  rm -f "$BOARD_PLIST"
  say "автозапуск борда выключен (FLEET_AUTOOPEN=0)"
fi

# 6. Проверка ----------------------------------------------------------------
PORT="$(env_value FLEET_PORT 4319)"

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
