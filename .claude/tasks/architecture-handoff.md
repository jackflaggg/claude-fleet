# Handoff: переработка архитектуры claude-fleet

Дата: 2026-09-06, конец второй сессии реализации. План: `.claude/tasks/architecture-plan.md`,
рабочий промпт: `.claude/tasks/architecture-impl-prompt.md`. Развилки раздела 5 плана решены
владельцем и не переоткрываются. Владелец разрешил идти по всем шагам до конца с коммитом и пушем
на каждый шаг без отдельной команды (сообщение на русском, без подписей и следов AI-авторства).

## Состояние

Закоммичено и запушено на `master` (`origin/master` синхронен):

| Коммит | Что |
|--------|-----|
| `42a926a` | шаг 0: CI на четыре job, `test/channel.e2e.test.js`, `test/helpers/fleet-process.js` |
| `80664d7` | шаг 1: `public/js/lib/domain.js`, литералов статусов вне него нет, `idle` вместо `stale` на фронте |
| `592e93a` | переезд в `src/<контекст>/` через `git mv` |
| `e9d1ae1` | шаг 2: `src/config.js` (`loadConfig`, `applyEnvFile`), `src/log.js` |
| `ad7924f` | шаг 3: `src/http/sse-hub.js` (два экземпляра: `boards`, `channelStreams`), `src/http/sse-frames.js` (канал берёт парсер) |
| `d59667b` | шаг 4a: `src/fleet.js` с `createFleet({ config, root, log, clock, probe, spawn, bootMs })` → `{ server, close }`; `server.js` entry ~35 строк |
| `21f8b84` | шаг 4b: `test/server.test.js` in-process через `test/helpers/fleet-inprocess.js` (`startFleet`, `fakeClock`); спавн только для битого id и `EADDRINUSE` |
| `ca23943` | шаг 5: `src/channel/registry.js`, `src/channel/routes.js`, `src/http/body.js`; диагноз №10 закрыт фактом (`ps`: родитель всех процессов канала это `claude`, PPID = pid из лога) |
| `28dbd14` | шаг 6: `src/fleet/store.js` (`schema: 2`, миграция старого формата один раз, inline-миграций в `applyEvent` нет), `src/usage/scanner.js` |
| `76b8420` | шаг 7: `src/fleet/hook-event.js` (`normalizeHookEvent(raw, headers)` → `FleetEvent`), `applyEvent` берёт нормализованное, `applyRawEvent` фасад; тесты `state.test.js` переводят `agent`/`appId`/`processPid` в заголовки хелпером |

`node --test` на `76b8420`: 191 passed, 0 fail, 0 skipped (e2e канала идёт с SDK в
`channel/node_modules`; два хелпера под `test/helpers/` считаются за два пустых теста).
Живой сервер перезапущен после каждого шага: `/stats` даёт `boards 1`, каналы переподключаются,
`fleet.error.log` пуст. Живой `.fleet-state.json` уже в формате `schema: 2`.

## Следующий шаг

Шаг 8 (фронт): `public/js/ui/markup.js` (все строители строк из `board-view.js`: `cardHtml`,
`rowHtml`, `actsHtml`, `badgeFor`, `avatarHtml`, `originHtml`, `wtreeHtml`, `toolHtml`, `killHtml`,
`cardSig`) и `public/js/ui/order.js` (сортировки `rowOrder`, `waitOrder`, `layoutKey`);
`board-view.js` остаётся DOM-склейкой. RED: `test/markup.test.js` (кнопки только при `channel`,
плейсхолдер без промпта, экранирование), `test/order.test.js` (проект → агент → старшая выше;
дольше ждущий сверху). Вживую: Cmd+R борда (`osascript -e 'tell application "Yandex" to tell
active tab of first window to reload'`) и headless-скрин изолированной копии.

Дальше: 9 (`scripts/hooks-merge.mjs` из `install.sh`/`uninstall.sh`, RED: чужой хук переживает
установку и снятие, голый путь мигрирует в кавычки, битый JSON → exit 1 без записи), 10 (JSDoc +
`tsc --checkJs --noEmit` job, `types.d.ts`, `typescript` только devDependency корня), 11
(`FLEET_TOKEN`, `isTrustedPeer` в `guards.js`, cookie через `/?token=`, loopback без токена).

## Как проверяется вживую (работает, повторять так же)

- Живой сервер: `launchctl kickstart -k gui/$(id -u)/com.rasulkiller.claude-fleet`, через 5-6 с
  `curl -s http://127.0.0.1:4319/stats` (`boards` возвращается в 1 не сразу).
- Изолированная копия: rsync репозитория в scratchpad (без `node_modules`, `.git`, `.env`,
  `.fleet-state.json`), запуск `FLEET_PORT=4399 FLEET_STATE_FILE=<scratch>/state.json
  FLEET_TRANSCRIPTS=<пустая папка> FLEET_CHANNEL=1 FLEET_WEBSTORM= node server.js` в фоне; убивать
  по порту `lsof -ti :4399 | xargs kill`.
- Засев копии: скрипт на `fetch` в scratchpad, без литералов deny-паттернов (`rm -rf`,
  `git push --force` внутри JSON режут вызов). Для скрина брать PID живого процесса.
- Headless-скрин: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
  --disable-gpu --hide-scrollbars --no-first-run --user-data-dir=<свежая папка> --window-size=1600,1000
  --timeout=5000 --screenshot=<png> http://127.0.0.1:4399/`, процесс убить через `sleep 12; kill`
  (foreground `sleep` в туле заблокирован: использовать Monitor или фоновый запуск).
- Хелпер `startFleet` из `test/helpers/fleet-inprocess.js` поднимает экземпляр в процессе теста
  на свободном порту: для новых серверных тестов спавн не нужен.

## Тупики (не повторять)

- `--virtual-time-budget` в headless Chrome с открытым SSE не завершается никогда: только
  `--timeout=<мс>` плюс принудительный kill. Профиль Chrome на каждый прогон свежий.
- `timeout` (coreutils) на машине нет.
- Хелпер под `test/` нельзя импортировать из теста с экспортом оттуда: node прогнал бы его тесты
  дважды; поэтому `test/helpers/`.
- `process.getActiveResourcesInfo()` отпускает закрытый `TCPServerWrap` на следующем обороте
  цикла: замеры только после `sleep(0)`, иначе тест на «нет хендлов после close()» флапает.
- `mock.timers.reset()` обязан быть в `finally`: упавший тест с включёнными mock-таймерами
  роняет следующий («MockTimers is already enabled»).
- Карточка без `title` и без `tool` считается пустой и режется по `blankMs` (15 мин): в тестах
  store и state давать карточке задачу, иначе она «исчезает» без видимой причины.

## Решения и отклонения от плана (доложены владельцу, приняты коммитом)

- Job `channel` в CI идёт всегда, не по `paths: channel/**`.
- `guards.js` лёг в `src/http/`.
- У хаба SSE добавлен метод `end(handle)` сверх контракта RED-тестов (переподключение канала).
- Нечитающий клиент снимается с учёта синхронно внутри `hub.write`, не по событию `close`.
- `readBody`/`readJson` вынесены в `src/http/body.js` (план называл `router.js`, но роутер
  отдельным шагом не предусмотрен).
- Store принимает `fs` параметром и логирует обрезанный JSON; откат кода на версию до схемы 2
  прочитает `{ schema, sessions }` как две протухшие карточки и отбросит их (инвариант записан).
- `normalizeHookEvent` читает `agent`/`appId`/`pid` только из заголовков; поля `agent`,
  `appId`, `processPid` в теле события больше не читаются нигде.
- Бюджеты `verify:liveness` на ubuntu-раннере не проверены (локально 1.1 с).

## Не проверено

- CI на GitHub после пушей не смотрел (`gh run list` не запускался).
- Кнопка «Разрешить» на настоящей сессии руками не нажималась: вердикт покрыт e2e и тестами
  реестра.
- Цена посекундного `ACTIVE_STATUSES.has(el.dataset.status)` на фронте не мерялась.
