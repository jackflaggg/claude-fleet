#!/usr/bin/env bash
# Пробрасывает JSON события хука Claude Code (stdin) в локальный процесс Fleet.
# Требование: никогда не блокировать и не ронять сессию.
# Поэтому короткие таймауты и безусловный exit 0 - если сервер не поднят,
# curl мгновенно упрётся в connection refused и мы просто выходим.
#
# Папку проекта вычисляем от расположения скрипта (не хардкодим путь).
# Порт берём из того же .env, что и сервер, чтобы хук и сервер всегда совпадали.
# Приоритет: переменная окружения FLEET_PORT -> значение из .env -> 4319.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
PORT="${FLEET_PORT:-}"
if [ -z "$PORT" ] && [ -f "$ENV_FILE" ]; then
  PORT="$(grep -E '^FLEET_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d '=' -f2 | tr -d '[:space:]"')"
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
