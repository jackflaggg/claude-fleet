#!/usr/bin/env bash
# Пробрасывает JSON события хука Claude Code (stdin) в локальный процесс Fleet.
# Требование: никогда не блокировать и не ронять сессию.
# Поэтому короткие таймауты и безусловный exit 0 - если сервер не поднят,
# curl мгновенно упрётся в connection refused и мы просто выходим.
#
# Папку проекта вычисляем от расположения скрипта (не хардкодим путь).
# Порт берём из того же .env, что и сервер, чтобы хук и сервер всегда совпадали.
# Приоритет: переменная окружения FLEET_PORT -> значение из .env -> 4319.
# Всё до curl делаем средствами самого bash, без единого подпроцесса: скрипт висит на каждом
# вызове тула во всех сессиях, и прежние `$(cd .. && pwd)` + grep|tail|cut|tr стоили пяти
# лишних форков на ровном месте.
HOOK_DIR="${BASH_SOURCE[0]%/*}"
ENV_FILE="${HOOK_DIR%/*}/.env"
PORT="${FLEET_PORT:-}"
if [ -z "$PORT" ] && [ -r "$ENV_FILE" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    if [ "$key" = "FLEET_PORT" ]; then
      value="${value%%#*}"          # хвостовой комментарий
      value="${value//[[:space:]]/}"
      value="${value//\"/}"
      PORT="$value"
    fi
  done < "$ENV_FILE"
fi
PORT="${PORT:-4319}"

# bundle-id приложения-терминала, где живёт сессия (com.jetbrains.WebStorm / org.alacritty /
# com.googlecode.iterm2 / com.apple.Terminal). По нему борд решает куда возвращать по клику.
curl -s -o /dev/null \
  --connect-timeout 0.2 --max-time 0.5 \
  -X POST "http://localhost:${PORT}/event" \
  -H 'Content-Type: application/json' \
  -H "X-Fleet-App: ${__CFBundleIdentifier:-}" \
  --data-binary @- >/dev/null 2>&1 || true
exit 0
