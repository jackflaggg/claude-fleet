# Установка claude-fleet

```bash
./scripts/install.sh
```

Скрипт делает всё: создаёт `.env` из шаблона, дописывает хуки в `~/.claude/settings.json`
и `~/.codex/hooks.json`,
генерирует launchd-агент и перезагружает его. Идемпотентный - гоняй повторно после переезда
папки или обновления node, дубликатов не будет.

Что важно знать про него:

- **чужие хуки не трогает.** Настройки мержатся через node, перед записью кладутся бэкапы
  `~/.claude/settings.json.bak` и `~/.codex/hooks.json.bak`. Хуки других тулов остаются на месте.
- **пути не зашиты.** Путь к репозиторию берётся от расположения самого скрипта, node ищется
  по алиасу fnm `default` (он переживает обновления версий), и только если его нет - по `PATH`.
  Если в итоге выбран временный путь `fnm_multishells`, скрипт предупредит: такой путь
  протухнет вместе с сессией терминала, и агент уйдёт в петлю перезапусков.
- **снять всё:** `./scripts/uninstall.sh` - гасит агент и убирает только свои хуки.

Ниже - то же самое руками, если хочется контролировать каждый шаг.

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

## 3. Хуки в `~/.codex/hooks.json`

Установщик добавляет официальный набор lifecycle hooks Codex: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
`PostCompact`, `Stop` и `SessionEnd`. Команда та же, но с маркером источника:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "FLEET_AGENT=codex \"/absolute/path/hooks/report.sh\"",
        "timeout": 1
      }]
    }]
  }
}
```

После установки открой `/hooks` в Codex и один раз доверь новые команды Fleet. Codex
проверяет hash пользовательских command hooks и до подтверждения намеренно их пропускает.
Внутренние rollout JSONL не читаются: официальный hook-интерфейс стабильнее и не создаёт
фоновой нагрузки. Схема и правила доверия: [Codex Hooks](https://learn.chatgpt.com/docs/hooks).

## 4. Автозапуск через launchd

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
  <string>/Users/rasulkiller/Projects/claude-fleet/fleet.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/rasulkiller/Projects/claude-fleet/fleet.error.log</string>
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

## 5. Открыть борд

```bash
./scripts/board.sh          # не поднимает второе окно, если борд уже открыт
./scripts/board.sh --force  # окно нужно именно новое
```

Открывает `http://localhost:4319` отдельным окном-приложением Яндекс Браузера (без вкладок
и адресной строки) - удобно держать на втором мониторе. Под рукой полезен алиас:

```bash
echo "alias fleet='/Users/rasulkiller/Projects/claude-fleet/scripts/board.sh'" >> ~/.zshrc
```

## 6. Автооткрытие борда при логине

`install.sh` ставит второй агент, `com.rasulkiller.claude-fleet-board`: при входе в систему
он поднимает окно борда. Выключается через `.env`:

```bash
FLEET_AUTOOPEN=0   # и заново ./scripts/install.sh - агент снимется
```

Агент разовый (`RunAtLoad` без `KeepAlive`): закрыл окно - оно остаётся закрытым до
следующего входа. Скрипт сам ждёт сервер до 20 секунд (оба агента стартуют одновременно,
и браузер успевает раньше) и сам проверяет через `/stats`, не открыт ли борд уже.

Нулю в `boards` он при этом не верит сразу, а перепроверяет 6 секунд: `install.sh`
перезапускает сервер прямо перед стартом агента, все SSE рвутся, и уже открытое окно
возвращается в счётчик лишь через пару секунд - без этой паузы установка дублировала окно.

Холодный старт браузера идёт через `open -b ru.yandex.desktop.yandex-browser`, а не прямым
вызовом бинаря. Это не косметика: запущенный напрямую браузер стал бы главным процессом
job'а, launchd считал бы агент работающим всё время жизни браузера, а любой `bootout` -
в том числе повторный прогон `install.sh` - закрывал бы Яндекс со всеми вкладками. Прямой
вызов остался для случая, когда браузер уже работает: там процесс лишь передаёт `--app`
живому браузеру и сразу выходит.

Лог - `fleet.board.log`. Снять руками:

```bash
launchctl bootout gui/$(id -u)/com.rasulkiller.claude-fleet-board
```

Скрипт зовёт бинарь браузера напрямую, а не через `open -na`: `open -n` поднял бы второй
экземпляр Яндекса со своим профилем, а прямой вызов передаёт `--app` уже запущенному.

## 7. Ответ с борда (прототип, только Claude Code)

Кнопки «Разрешить»/«Отказать» и строка ответа на карточке работают через каналы Claude Code
(research preview): отдельный MCP-процесс `channel/fleet-channel.js` на каждую сессию, который
Claude Code запускает сам и через который борд отдаёт сессии текст или вердикт. Без настройки
ниже борд выглядит и работает как раньше.

1. Включи маршруты канала на сервере и перезапусти его:

   ```bash
   # в .env
   FLEET_CHANNEL=1
   launchctl kickstart -k gui/$(id -u)/com.rasulkiller.claude-fleet
   ```

2. Поставь зависимости канала (единственное место с npm-пакетами, сервер борда без них):

   ```bash
   cd channel && npm install
   ```

3. Зарегистрируй канал как MCP-сервер пользователя. Путь абсолютный, из своего репозитория:

   ```bash
   claude mcp add --scope user fleet -- node /Users/rasulkiller/Projects/claude-fleet/channel/fleet-channel.js
   ```

   Это правит `~/.claude.json`, поэтому установщик такого не делает - только руками.

4. Запускай сессии с каналом:

   ```bash
   claude --dangerously-load-development-channels server:fleet
   ```

   Claude Code спросит согласие на MCP-сервер один раз. На карточке сессии с подключённым
   каналом появятся кнопки и строка «Ответить сессии…» с подписью «через канал fleet».

Текст с борда приходит сессии как следующий ход. Диалог разрешения в терминале остаётся
открытым параллельно с кнопками: применяется первый ответ, второй борд покажет как «уже закрыт
в терминале». Снять: `claude mcp remove --scope user fleet` и `FLEET_CHANNEL=0`.

Проверено сквозным прогоном с имитацией клиента; с настоящим Claude Code флаг и диалог
согласия ещё не прогонялись - если что-то не сходится, смотри `fleet.log` (строка «канал
подключён: pid …») и stderr канала в логах Claude Code.

## Проверка, что хуки живые

Открой сессию Claude Code и сессию Codex, отправь в каждой любой промпт - в течение секунды на борде
появится карточка проекта. Если нет - глянь `fleet.log` и что сервер слушает 4319.

## Звук и уведомления

Звука нет намеренно. Системные уведомления по умолчанию выключены - включаются
колокольчиком в шапке борда и остаются беззвучными.
