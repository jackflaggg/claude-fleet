# Установка claude-fleet

Шаги: (1) скопировать конфиг, (2) подключить хуки в глобальный конфиг Claude Code,
(3) поднять сервер на автозапуск при логине.

## 1. Конфиг

```bash
cp .env.example .env   # при желании поправь порт/пути под себя
```

`.env` в `.gitignore`, наружу не уходит. Порт из него читают и сервер, и `hooks/report.sh`,
поэтому они всегда на одном порту.

## 2. Хуки в `~/.claude/settings.json`

Добавить объект `hooks` в корень `~/.claude/settings.json`. Хуки глобальные -
ловят все сессии Claude Code по всем проектам. `report.sh` неблокирующий: если
сервер не поднят, он мгновенно выходит и сессию не тормозит.

```json
"hooks": {
  "SessionStart":     [ { "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ],
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ],
  "PreToolUse":       [ { "matcher": "*", "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ],
  "PostToolUse":      [ { "matcher": "*", "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ],
  "Notification":     [ { "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ],
  "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "/Users/rasulkiller/Projects/claude-fleet/hooks/report.sh" } ] } ]
}
```

Хуки из разных источников (глобальные + проектные `.claude/settings.json`) складываются,
а не заменяют друг друга - существующие проектные хуки продолжат работать.

## 3. Автозапуск через launchd

Node ставится через fnm, поэтому используем стабильный путь дефолт-алиаса, а не
сессионный multishell-путь.

Файл `~/Library/LaunchAgents/com.rasulkiller.claude-fleet.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rasulkiller.claude-fleet</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/rasulkiller/.local/share/fnm/aliases/default/bin/node</string>
    <string>/Users/rasulkiller/Projects/claude-fleet/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/rasulkiller/Projects/claude-fleet</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/rasulkiller/Projects/claude-fleet/fleet.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/rasulkiller/Projects/claude-fleet/fleet.log</string>
</dict>
</plist>
```

Загрузить (переживёт перезагрузку, сам поднимется при логине):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rasulkiller.claude-fleet.plist
# статус:
launchctl print gui/$(id -u)/com.rasulkiller.claude-fleet | head -20
```

Снять:

```bash
launchctl bootout gui/$(id -u)/com.rasulkiller.claude-fleet
```

Если обновишь версию node через fnm и путь дефолт-алиаса переедет - поправить
`ProgramArguments` в plist и перезагрузить агент (`bootout` + `bootstrap`).

## 4. Открыть борд

`http://localhost:4319` - удобно отдельным окном браузера на втором мониторе.

## Проверка, что хуки живые

Открой любую сессию Claude Code, отправь любой промпт - в течение секунды на борде
появится карточка проекта. Если нет - глянь `fleet.log` и что сервер слушает 4319.

## Звук и уведомления

Их нет намеренно - единственный сигнал это сам борд.
