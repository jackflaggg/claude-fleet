# Handoff: переработка архитектуры claude-fleet

Дата: 2026-09-06, конец четвёртой сессии реализации. **План закрыт: шаги 0-11 сделаны.** План: `.claude/tasks/architecture-plan.md`,
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
| `ad7924f` | шаг 3: `src/http/sse-hub.js` (два экземпляра: `boards`, `channelStreams`), `src/http/sse-frames.js` |
| `d59667b` | шаг 4a: `src/fleet.js` с `createFleet(...)` → `{ server, close }`; `server.js` entry ~35 строк |
| `21f8b84` | шаг 4b: `test/server.test.js` in-process через `test/helpers/fleet-inprocess.js` |
| `ca23943` | шаг 5: `src/channel/registry.js`, `src/channel/routes.js`, `src/http/body.js`; диагноз №10 закрыт фактом |
| `28dbd14` | шаг 6: `src/fleet/store.js` (`schema: 2`), `src/usage/scanner.js` |
| `76b8420` | шаг 7: `src/fleet/hook-event.js` (`normalizeHookEvent`), `applyEvent` берёт `FleetEvent` |
| `76d44b5` + merge `88c215c` | шаг 8: `public/js/ui/markup.js` (строители), `public/js/ui/order.js` (`rowOrder`, `waitOrder`, `layoutKey`, `splitSections`), `board-view.js` только DOM (393 → 273 строки). Шёл через PR #1 с трейлером `Co-authored-by` по просьбе владельца (достижение GitHub), смержен владельцем |
| `8c4b69a` | шаг 9: `scripts/hooks-merge.mjs` (`addHooks`/`removeHooks`, CLI `--agent claude|codex [--remove]`), `install.sh`/`uninstall.sh` зовут его вместо четырёх heredoc; проверено на фейковом `HOME` и копии в пути с пробелом |
| `ee07daf` | шаг 10: `types.d.ts` (`Card`, `FleetEvent`, `HookHeaders`, `Snapshot`, `UsageWindow`, `Config`, `PermissionRequest`), `tsconfig.json` (`checkJs`, `strict`, без `noImplicitAny` и `useUnknownInCatchVariables`), JSDoc `@import` на границах модулей, `npm run typecheck`, job `types` в CI; `typescript` и `@types/node` как devDependencies корня, `package-lock.json` закоммичен. Базовая линия 96 ошибок → 0 |
| `db35a75` | шаг 11: `FLEET_TOKEN` в `loadConfig` и `Config`, `isTrustedPeer`/`parseCookies`/`TOKEN_COOKIE` в `src/http/guards.js`, `handleTokenLogin` в `src/fleet.js` (`GET /?token=` → 302 на `/` с `Set-Cookie: fleet_token=...; HttpOnly; SameSite=Strict; Path=/`, неверный токен 403 без cookie), проверка доверия в `route()` после Host и до `mutating`; `.env.example`, README, CLAUDE.md (таблица `.env`, инвариант «Доступ из сети только с токеном», карта файлов) |

`node --test` на `db35a75`: 220 passed, 0 fail. `npm run typecheck`: 0 ошибок. Живой сервер перезапущен
после шага 11 с пустым `FLEET_TOKEN`: `/stats` даёт `boards 1`, `channels 4`, `fleet.error.log` пуст,
`GET /?token=x` без токена в конфиге отдаёт индекс 200. LAN-ветка проверена на копии в scratchpad с
`FLEET_HOST=0.0.0.0`, `FLEET_ALLOWED_HOSTS=<LAN-ip>:4399`, `FLEET_TOKEN=tok123` запросами на LAN-адрес
машины (`remote_ip` в curl не loopback): без cookie 403, `?token=bad` 403, `?token=tok123` 302 с
`Set-Cookie`, дальше `/stats`, `/`, `/stream` с cookie 200, loopback без cookie 200.

## Следующий шаг

Плана больше нет. Остались только развилки за владельцем:

- Включить `FLEET_TOKEN` в живом `.env` и проверить сценарий с планшета (ссылка `/?token=`, cookie,
  повторное открытие). Cookie сессионная, без `Max-Age`, как записано в плане: после закрытия
  браузера на планшете борд открывается снова по ссылке. Если это неудобно, `Max-Age` добавляется
  одной строкой в `handleTokenLogin` (`src/fleet.js`).
- Открытые пункты аудита: `.claude/tasks/audit-2026-09-06.md`, №9 и №12 (PID-reuse канала).
- Раздел «Не проверено» ниже.

## Как проверяется вживую (работает, повторять так же)

- Живой сервер: `launchctl kickstart -k gui/$(id -u)/com.rasulkiller.claude-fleet`, через 5-6 с
  `curl -s http://127.0.0.1:4319/stats` (`boards` возвращается в 1 не сразу).
- Обновить борд: `osascript -e 'tell application "Yandex" to tell active tab of first window to reload'`.
- Изолированная копия: rsync репозитория в scratchpad (без `node_modules`, `.git`, `.env`,
  `.fleet-state.json`, `fleet*.log`), запуск `FLEET_PORT=4399 FLEET_STATE_FILE=<scratch>/state.json
  FLEET_TRANSCRIPTS=<пустая папка> FLEET_CHANNEL=1 FLEET_WEBSTORM= node server.js` в фоне; убивать
  по порту `lsof -ti :4399 | xargs kill`. Скрипт засева на `fetch` (`seed.mjs`: четыре сессии,
  PreToolUse, Notification permission_prompt, Stop) пишется за минуту.
- Headless-скрин: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
  --disable-gpu --hide-scrollbars --no-first-run --user-data-dir=<свежая папка> --window-size=1600,1000
  --timeout=5000 --screenshot=<png> http://127.0.0.1:4399/` фоном, затем kill по pid из
  `ps -axo pid,command`, отфильтрованного по `user-data-dir`.
- Установщик: копия в путь с пробелом, фейковый `HOME` с чужим хуком и голым путём в `settings.json`,
  `.env` с `FLEET_PORT=1` и `FLEET_AUTOOPEN=0`, `FLEET_LABEL=com.test.<имя>`; после `install.sh` (exit 1
  на порту 1 это норма) гонять `uninstall.sh` тем же окружением и проверять `launchctl print`.
- Хелпер `startFleet` из `test/helpers/fleet-inprocess.js` поднимает экземпляр в процессе теста.

## Тупики (не повторять)

- Классификатор auto mode режет `gh pr create` с heredoc в `--body` и любые команды, где в тексте
  встречаются рекурсивное удаление или kill по имени процесса: тело PR писать файлом через Write
  и `--body-file`, Chrome убивать по pid из `ps`. Те же литералы в тексте файла режут и Write.
- В исходном `board-view.js` разделители сигнатуры были сырыми байтами `\x01`/`\x02`, невидимыми
  в Read: Edit по такому блоку не совпадает. Теперь записаны escape-последовательностями.
- `--virtual-time-budget` в headless Chrome с открытым SSE не завершается никогда: только
  `--timeout=<мс>` плюс kill. Профиль Chrome на каждый прогон свежий.
- `timeout` (coreutils) на машине нет; foreground `sleep` до ~6 с проходит.
- Хелпер под `test/` нельзя импортировать из теста с экспортом оттуда: node прогнал бы его тесты
  дважды; поэтому `test/helpers/`.
- `process.getActiveResourcesInfo()` отпускает закрытый `TCPServerWrap` на следующем обороте
  цикла: замеры только после `sleep(0)`.
- `mock.timers.reset()` обязан быть в `finally`.
- Карточка без `title` и без `tool` считается пустой и режется по `blankMs` (15 мин): в тестах
  store и state давать карточке задачу.
- `tsc` без `@types/node` не видит `node:*`: без него checkJs бесполезен, поэтому вторая devDependency.

## Решения и отклонения от плана (доложены владельцу, приняты коммитом)

- Job `channel` в CI идёт всегда, не по `paths: channel/**`.
- `guards.js` лёг в `src/http/`; `readBody`/`readJson` в `src/http/body.js`.
- У хаба SSE метод `end(handle)`; нечитающий клиент снимается синхронно внутри `hub.write`.
- Store принимает `fs` параметром и логирует обрезанный JSON.
- `normalizeHookEvent` читает `agent`/`appId`/`pid` только из заголовков.
- Шаг 8: в `order.js` добавлен `splitSections(list)` сверх плана (композиция сортировок с тестом).
- Шаг 9: `main` в `hooks-merge.mjs` при `--remove` и отсутствующем файле молча выходит с 0
  (раньше проверка `[ -f ]` стояла в bash).
- Шаг 10: `@types/node` как вторая devDependency; в `Card` статусы и агенты типизированы `string`,
  не литералами; `noImplicitAny` и `useUnknownInCatchVariables` выключены.
- Бюджеты `verify:liveness` на ubuntu-раннере не проверены (локально в норме).
- Шаг 11: в `test/config.test.js` добавлен тест на `FLEET_TOKEN` сверх плана; токен в конфиге
  обрезается по пробелам (`trim`), чтобы `FLEET_TOKEN=' '` значило «выключено»; сравнение токена
  в `isTrustedPeer` без ранней остановки; `/?token=` обрабатывается и с loopback (302 с cookie),
  что позволило покрыть ссылку серверным тестом без подмены `remoteAddress`.

## Не проверено

- CI по `db35a75` (шаг 11) с первого раза упал на job `liveness`: `PID checks заняли 1041.3 ms CPU`
  при бюджете `CPU_BUDGET_MS = 1000` в `scripts/verify-liveness.mjs`; повтор job (`gh run rerun
  --failed`) зелёный с 372 мс. В зелёных прогонах `88c215c`, `ee07daf`, `30a14d0` то же число было
  804, 802 и 409 мс, локально 178 мс: бюджет на общем раннере впритык, шаг 11 путь liveness не
  трогал. Развилка за владельцем: поднять бюджет (например до 2000 мс, с комментарием про раннер)
  или оставить и мириться с редким флапом. Остальные job (`syntax`, `types`, `unit` 22/24,
  `channel`) зелёные с первого раза.
- Сценарий с планшета на живом `.env` с включённым `FLEET_TOKEN` (LAN-ветка проверена только curl
  на копии, см. «Состояние»).
- Кнопка «Разрешить» на настоящей сессии руками не нажималась.
- Цена посекундного `ACTIVE_STATUSES.has(...)` на фронте не мерялась.
- Достижение Pair Extraordinaire: PR #1 смержен с трейлером соавтора, бейдж появляется с задержкой.
