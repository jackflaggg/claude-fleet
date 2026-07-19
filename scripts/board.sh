#!/usr/bin/env bash
# Открывает борд отдельным окном-приложением Яндекс Браузера (без вкладок и адресной строки),
# чтобы он жил на втором мониторе как самостоятельное окно, а не терялся среди вкладок.
#
# Бинарь дёргаем напрямую, а не через `open -na`: `open -n` поднимает ВТОРОЙ экземпляр
# браузера со своим профилем, а прямой вызов Chromium-бинаря передаёт --app уже
# запущенному процессу и просто открывает в нём новое окно.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

PORT="${FLEET_PORT:-}"
if [ -z "$PORT" ] && [ -f "$ENV_FILE" ]; then
  PORT="$(grep -E '^FLEET_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d '=' -f2 | tr -d '[:space:]"')"
fi
PORT="${PORT:-4319}"
URL="http://localhost:${PORT}"

YANDEX="/Applications/Yandex.app/Contents/MacOS/Yandex"

if [ -x "$YANDEX" ]; then
  nohup "$YANDEX" --app="$URL" >/dev/null 2>&1 &
else
  # Яндекса нет (другая машина) - открываем в браузере по умолчанию, обычной вкладкой
  echo "Яндекс Браузер не найден, открываю в браузере по умолчанию" >&2
  open "$URL"
fi
