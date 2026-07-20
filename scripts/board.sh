#!/usr/bin/env bash
# Открывает борд отдельным окном-приложением Яндекс Браузера (без вкладок и адресной строки),
# чтобы он жил на втором мониторе как самостоятельное окно, а не терялся среди вкладок.
#
# Скрипт годится и для рук, и для автозапуска при логине (агент com...claude-fleet-board),
# поэтому умеет ждать сервер и не открывать второе окно поверх уже открытого.
#   --force  открыть окно, даже если борд где-то уже открыт
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

PORT="${FLEET_PORT:-}"
if [ -z "$PORT" ] && [ -f "$ENV_FILE" ]; then
  PORT="$(grep -E '^FLEET_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d '=' -f2 | tr -d '[:space:]"')"
fi
PORT="${PORT:-4319}"
URL="http://localhost:${PORT}"

YANDEX_BIN="/Applications/Yandex.app/Contents/MacOS/Yandex"
YANDEX_ID="ru.yandex.desktop.yandex-browser"

# При автозапуске оба агента стартуют одновременно, и браузер легко успевает раньше сервера.
# Промахнуться тут дороже, чем подождать: Chromium на ERR_CONNECTION_REFUSED показывает свою
# страницу ошибки и сам её не перезагружает - EventSource в борде до этого просто не доживает.
WAIT_SECONDS="${FLEET_BOARD_WAIT:-20}"

wait_for_server() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  until curl -sf -m 2 -o /dev/null "$URL/"; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.5
  done
}

# Рестарт сервера (его делает install.sh прямо перед запуском агента) рвёт все SSE, и уже
# открытые борды возвращаются в счётчик лишь через несколько секунд - пока они молчат, ноль
# врёт и окно дублируется. Поэтому нулю сразу не верим, а ждём; непустой ответ принимаем сразу.
SETTLE_SECONDS="${FLEET_BOARD_SETTLE:-6}"

# `boards` в /stats - число живых SSE-клиентов, то есть реально открытых бордов
board_already_open() {
  local deadline=$((SECONDS + SETTLE_SECONDS))
  while :; do
    curl -sf -m 2 "$URL/stats" 2>/dev/null | grep -qE '"boards": *[1-9]' && return 0
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 1
  done
}

if ! wait_for_server; then
  echo "борд не ответил на $URL за ${WAIT_SECONDS}с, окно не открываю" >&2
  exit 1
fi

if [ "$FORCE" -eq 0 ] && board_already_open; then
  echo "борд уже открыт, второе окно не поднимаю (--force, если нужно)"
  exit 0
fi

if [ ! -x "$YANDEX_BIN" ]; then
  # Яндекса нет (другая машина) - открываем в браузере по умолчанию, обычной вкладкой
  echo "Яндекс Браузер не найден, открываю в браузере по умолчанию" >&2
  open "$URL"
elif pgrep -x Yandex >/dev/null 2>&1; then
  # Браузер уже работает: прямой вызов бинаря передаёт --app живому процессу и сразу выходит.
  # Через `open -na` тут нельзя - `-n` поднял бы второй экземпляр со своим профилем.
  nohup "$YANDEX_BIN" --app="$URL" >/dev/null 2>&1 &
else
  # Холодный старт - только через LaunchServices. Прямой вызов бинаря стал бы главным
  # процессом браузера и унаследовал бы того, кто нас запустил: у launchd-агента это значит,
  # что job висит живым, пока жив браузер, а любой `launchctl bootout` (в том числе повторный
  # прогон install.sh) закрыл бы Яндекс со всеми вкладками.
  open -b "$YANDEX_ID" --args --app="$URL"
fi
