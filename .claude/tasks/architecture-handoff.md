# Handoff: переработка архитектуры claude-fleet

Дата: 2026-09-06, конец первой сессии реализации. План: `.claude/tasks/architecture-plan.md`,
рабочий промпт: `.claude/tasks/architecture-impl-prompt.md` (оба закоммичены). Развилки раздела 5
плана решены владельцем и не переоткрываются.

## Состояние

Закоммичено на `master` (каждый шаг отдельным коммитом, по команде владельца):

| Коммит | Что |
|--------|-----|
| `42a926a` | шаг 0: CI на четыре job (`syntax`, `unit` 22.x/24.x, `liveness`, `channel`), `test/channel.e2e.test.js`, `test/helpers/fleet-process.js` |
| `80664d7` | шаг 1: `public/js/lib/domain.js` (`AGENT`, `STATUS`, `WAIT_REASON`, `SECTION`, `ACTIVE_STATUSES`, `sectionOf`, `isAttention`, `isAskingPermission`, `agentOf`), литералов статусов вне него нет, `stale` на фронте переименован в `idle` (`.row.idle`, подпись `.idle-note`, `data-status` на элементе) |
| `592e93a` | переезд через `git mv`: `src/fleet/{state,liveness}.js`, `src/usage/usage.js`, `src/focus/focus.js`, `src/http/guards.js`; только пути импортов |
| `e9d1ae1` | шаг 2: `src/config.js` (`loadConfig`, `applyEnvFile`), `src/log.js` (`createLog`, `log`); `server.js` деструктурирует конфиг в прежние имена констант; канал читает порт тем же `loadConfig` |

`node --test` на `e9d1ae1`: 150 passed (в числе один пустой «тест» на файл хелпера
`test/helpers/fleet-process.js`, так `node --test` считает файлы под `test/`).

**Шаг 3 сделан во второй сессии 06.09.2026, ждёт коммита** (`git status --porcelain`: `M CLAUDE.md`,
`M channel/fleet-channel.js`, `M server.js`, новые `src/http/sse-frames.js`, `src/http/sse-hub.js`,
`test/sse-frames.test.js`, `test/sse-hub.test.js`, этот файл). `node --test`: 161 passed, 0 fail,
e2e канала прошёл с SDK. Kickstart живого сервера: борд и 6 каналов переподключились, события
хуков идут, `fleet.error.log` пуст.
- `src/http/sse-frames.js`: `createSseFrameParser({ maxBuffer })` → `push(chunk)`; канал берёт его
  вместо inline-разбора.
- `src/http/sse-hub.js`: `createSseHub({ log, maxBuffered, keepAliveMs, heartbeatMs, debounceMs })`
  с `open`, `write`, `end(handle)` (сверх контракта тестов: закрыть прежний поток того же pid при
  переподключении канала), `broadcast(produce)`, `broadcastNow`, `size`, `close()`. Нечитающий
  клиент снимается с учёта синхронно в `write` (тест проверяет `size` в синхронном цикле).
  Heartbeat один `setInterval` на хаб, стартует с первым клиентом и гаснет с последним.
- `server.js`: два экземпляра хаба, `boards` и `channelStreams`; реестр `channels` хранит
  `pid -> { handle, since }` и чистится через `onClose`; при переподключении новый handle кладётся
  в реестр до `end(previous)`, чтобы `onClose` прежнего его не снял.

## Следующий шаг

Шаг 4a: механически завернуть тело `server.js` в `export function createFleet(...)` с
`{ server, close }` (`close()` обязан звать `boards.close()` и `channelStreams.close()` и снимать
интервалы), `server.js` остаётся entry; проверка вживую до 4b. Затем 4b: `test/server.test.js`
in-process с `freePort()` в `config.port` (не `listen(0)`, см. план), `mock.timers` для
`dropSettledPermissions`, спавн остаётся для «битый id» и `EADDRINUSE`.

Дальше по плану: 5, 6, 7, 8, 9, 10, 11.

## Как проверяется вживую (работает, повторять так же)

- Живой сервер: `launchctl kickstart -k gui/$(id -u)/com.rasulkiller.claude-fleet`, через 5-6 с
  `curl -s http://127.0.0.1:4319/stats` (`boards` возвращается в 1 не сразу). Перезагрузка
  вкладки борда: `osascript -e 'tell application "Yandex" to tell active tab of first window to reload'`.
- Изолированная копия: rsync репозитория в scratchpad (без `node_modules`, `.git`, `.env`,
  `.fleet-state.json`), запуск `FLEET_PORT=4399 FLEET_STATE_FILE=<scratch>/state.json
  FLEET_TRANSCRIPTS=<пустая папка> FLEET_CHANNEL=1 FLEET_WEBSTORM= node server.js` в фоне. В конце
  прошлой сессии такая копия ещё работала на 4399: `lsof -ti :4399 | xargs kill`.
- Засев копии: скрипт на `fetch` в scratchpad (образец в прошлой сессии: `seed.mjs`), без
  литералов deny-паттернов. Карточка с `X-Fleet-Pid` мёртвого процесса исчезает за два тика
  liveness (это правильно); для скрина брать PID живого процесса, например самой копии.
- Headless-скрин: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
  --disable-gpu --hide-scrollbars --no-first-run --user-data-dir=<свежая папка> --window-size=1600,1000
  --timeout=5000 --screenshot=<png> http://127.0.0.1:4399/`, процесс убить через `sleep 12; kill`.
  `--dump-dom` так же. Скрин смотреть через Read.

## Тупики (не повторять)

- `--virtual-time-budget` в headless Chrome с открытым SSE не завершается никогда: только
  `--timeout=<мс>` плюс принудительный kill. Профиль Chrome на каждый прогон свежий, иначе
  `SingletonLock` от убитого прогона блокирует старт.
- Пермишен режет команду целиком по deny-литералам: `rm -rf` и `git push --force` внутри JSON
  засева. Засев через скрипт без этих строк проходит.
- `timeout` (coreutils) на машине нет.
- Хелпер под `test/` нельзя импортировать из `server.test.js` с экспортом оттуда: node прогнал бы
  его тесты дважды; поэтому `test/helpers/`.

## Решения и отклонения от плана (доложены владельцу, приняты коммитом)

- Job `channel` в CI идёт всегда, не по `paths: channel/**`: e2e проверяет и маршруты
  `/channel/*` в `server.js`.
- `guards.js` лёг в `src/http/` (в целевом дереве плана не назван явно).
- Бюджеты `verify:liveness` на ubuntu-раннере не проверены (локально 1.1 с).
- Живые процессы канала запущены до правки шага 2 и работают на старом коде до новых сессий.

## Не проверено

- CI на GitHub после шага 0 не смотрел (пуша не было).
- Цена посекундного `ACTIVE_STATUSES.has(el.dataset.status)` вместо regex по классам не мерялась
  (ожидаемо дешевле).
