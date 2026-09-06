# План переработки архитектуры claude-fleet

Дата: 2026-09-06. Вход: `node --test` 132 passed (2.4 с), дерево чистое на `63fc807`. Живой
борд: `/stats` даёт `sessions 3, boards 1, channels 3`; у трёх `fleet-channel.js` родитель
`claude` (`ps`). Инварианты CLAUDE.md это ограничения плана. Развилки в разделе 5.

## 1. Диагноз (по убыванию цены владения)

1. **`server.js` 962 строки, восемь ответственностей, неимпортируем.** Конфиг `36-172`,
   персист `180-242`, SSE `282-306`, реестр каналов `255-443`, диагностика `450-511`, сканер
   транскриптов `519-627`, статика `790-829`, роутинг `851-907`, таймеры `926-947`, `listen`
   `960`. Синглтоны на уровне модуля (`sessions` 191, `channels` 255, `usageWindow` 519), поэтому
   маршруты тестируются только спавном (`test/server.test.js:30-81`). Канал добавил ~190 строк.
2. **Знание о статусах в пяти файлах.** `STATUS`/`WAIT_REASON` экспортированы из
   `state.js:11-27`, но снаружи ими никто не пользуется: `server.js:440` сравнивает с
   `'waiting'`/`'permission'`, `board-config.js:37-38` с `'waiting'`/`'finished'`,
   `board-view.js:68,84,100` с `'waiting'`/`'permission'`/`'question'`; `'codex'` литералом в
   `server.js:709`, `state.js:276-279`, `board-view.js:14,27,148`, `notifications.js:66`.
   Переименование причины это шесть файлов и ни одного упавшего теста.
3. **Два реестра SSE с одним жизненным циклом.** Борды (`handleStream` `725-740`) и каналы
   (`handleChannelCommands` `309-337`): heartbeat, `cleanup`, `on('close')`, `on('error')`
   повторены; `pendingPermissions` чистится в трёх местах (`330`, `398`, `441`).
4. **Словарь расходится с кодом.** `stale` на фронте это «4 мин, подсветить»
   (`board-config.js:24`, `board-view.js:329-332`), `pruneStale` на сервере «6 ч, удалить»
   (`state.js:483`). Одно и то же зовётся `snapshot()`/`payload()` (`server.js:244,629`) и
   `data` (`board-view.js:22`); `note`/`ask`/`description` (`state.js:403`, `board-view.js:101`,
   `server.js:369`); `sessions[id]` это карточка (`server.js:379`). Статус `waiting` покрывает
   и «ждут тебя», и «закончил ход», хотя владелец 05.09 их развёл. `isWaiting` (`state.js:460`)
   не вызывается, `relativeTime`/`durationText` (`format.js:1,12`) живут только в тесте.
5. **Граница чужой схемы событий не выделена.** `handleEvent` (`server.js:704-711`) дописывает
   в сырое событие `appId`/`agent`/`processPid` из заголовков, `applyEvent` (`state.js:271-330`)
   читает поля Claude и Codex напрямую (`event.prompt ?? event.user_prompt` 346), миграции
   персиста inline без версии схемы (`state.js:309-313`).
6. **Конфиг читается пятью способами.** `server.js:38-59` (`envNumber` с логом),
   `channel/fleet-channel.js:36` (`Number(x) || 4319`, паттерн, который `envNumber` вылечил),
   `hooks/report.sh:14-25` (законно отдельный), `scripts/install.sh:21-33`,
   `scripts/board.sh:17-18,33-34` (`grep|tail|cut|tr`).
7. **Слияние хуков написано четыре раза.** `install.sh:71-141` и `147-194`,
   `uninstall.sh:23-59` и `62-91`. Ноль тестов; аудит №5 так и остался «не проверено».
8. **`board-view.js` 395 строк смешивает чистое и DOM.** `cardHtml` `97-113`, `rowHtml`
   `117-129`, `actsHtml` `77-87`, `badgeFor` `67-72`, сортировки `185-196`, ключ раскладки `208`
   не трогают `document`, но живут в фабрике с реконсиляцией (`141-181`, `198-269`) и
   обработчиками (`357-392`). Тестов нет именно поэтому.
9. **Молчаливые `catch`.** В `server.js` 16 блоков `} catch {`; без лога персист (`238`),
   загрузка состояния (`186`), чтение транскрипта (`596`). В канале парсер SSE-кадров
   (`120-139`) inline рядом с MCP-логикой.
10. **Дока отстала от факта.** CLAUDE.md: «не проверено с настоящим Claude Code, что `ppid`
    канала это PID `claude`»; `ps` показывает обратное.
11. Мелочь: сортировка снимка на сервере (`server.js:245`) мертва, клиент сортирует сам
    (`board-view.js:202-204`).

## 2. Целевая структура

Контексты как папки. Импорты только вниз: `server.js` → `src/fleet.js` → `src/http/*` →
контексты → чистые ядра → `public/js/lib/*`; `public/js/lib` из `src/` не импортирует.

```
server.js                   entry: loadConfig(process.env) → createFleet(...).listen(); ~20 строк
src/config.js               loadConfig(env, { log, exists }) → frozen конфиг, все envNumber
src/log.js                  log() с меткой времени, единственный писатель fleet.log
src/fleet.js                createFleet({ config, clock, log, probe, spawn }) → { server, close }:
                            композиция, все таймеры внутри (unref, clear в close)
src/http/router.js          таблица маршрутов, guards, decodeId, readBody, guard(), mutating
src/http/sse-hub.js         createSseHub(): open/write/clients/broadcast с дебаунсом; борды и каналы
src/http/sse-frames.js      parseSseFrames(): чистый парсер кадров, его же берёт канал
src/http/static.js          index.html, /assets, /js
src/http/stats.js           счётчики событий и /stats
src/fleet/state.js          нынешний state.js без правок
src/fleet/hook-event.js     normalizeHookEvent(raw, headers) → FleetEvent: единственное место,
                            где известна схема Claude/Codex
src/fleet/store.js          createSessionStore({ file, clock, fs, log }): load с boot time,
                            атомарный persist 0600, версия схемы
src/fleet/liveness.js       как сейчас
src/usage/usage.js          как сейчас
src/usage/scanner.js        createUsageScanner({ dir, windowMs, alignMs, fs, log }): offsets, буфер
src/channel/registry.js     createChannelRegistry({ hub, clock, log }): каналы, разрешения, settle
src/channel/routes.js       четыре обработчика /channel/*
src/focus/focus.js          как сейчас; spawn приходит из createFleet
public/js/lib/domain.js     STATUS, WAIT_REASON, AGENT, sectionOf, isAttention: общий словарь
public/js/ui/markup.js      cardHtml, rowHtml, actsHtml, badgeFor: чистые строки
public/js/ui/order.js       rowOrder, waitOrder, layoutKey: чистые
public/js/ui/board-view.js  только DOM: реестр элементов, слоты, тик, обработчики
scripts/hooks-merge.mjs     одна программа слияния/снятия хуков (claude|codex, add|remove)
channel/fleet-channel.js    импортирует ../src/config.js и ../src/http/sse-frames.js
```

DDD в масштабе тулзы. Домен: флот сессий; карточка это проекция сессии; ожидание с причиной
(`permission`/`question`/`failed` зовут, `finished` нет); окно лимита у аккаунта; канал привязан
к PID. Окупается: словарь в одном модуле, контексты как папки, антикоррупция на схеме хуков.
Не окупается: сущности с методами, репозитории, доменные события. Один процесс, одна карта в
памяти, правила уже в чистых функциях; тактический DDD добавил бы классы и ничего не защитил.
Паттерны: Pure Fabrication (`SseHub`, `ChannelRegistry`, `UsageScanner`, `SessionStore`),
композиция в `createFleet`, Controller это `router.js`; Strategy не нужна.

## 3. Не делаем (YAGNI)

- DI-контейнер и классы: фабрики `createX()` с объектом зависимостей уже конвенция репо.
- Репозитории над `.fleet-state.json`: это страховка, не история.
- HTTP-фреймворк, бандлер, ESLint с плагинами: инвариант «без зависимостей».
- Дифф-протокол снимка (развилка 2), TypeScript с эмитом (развилка 1).
- Аутентификация для localhost: любой локальный процесс уже читает `~/.claude`.
- Переписывать `report.sh` и `board.sh`: инварианты про форки и launchd важнее.

## 4. Миграция по шагам

Шаг это коммит при зелёных тестах и живом борде. Проверка вживую везде: `launchctl kickstart -k
gui/$(id -u)/com.rasulkiller.claude-fleet`, борд, событие хука, `/stats`; синтетика только в
копию со своим портом и `FLEET_STATE_FILE`. Каждый шаг правит карту в CLAUDE.md.

**0. CI на несколько job.** Параллельно: `syntax` (`node --check` js/mjs, `bash -n` sh), `unit`
(matrix `22.x`/`24.x`), `liveness` (`verify:liveness`), `channel` (`paths: channel/**`, `npm ci`
в `channel/`, stdio-прогон `test/channel.e2e.test.js`), позже `typecheck`; `concurrency:
cancel-in-progress`. RED: e2e повторяет ручной прогон из CLAUDE.md (initialize →
`/stats.channels=1` → permission_request → вердикт → закрытие stdin → выход). 1.5 ч.

**1. `public/js/lib/domain.js`.** Переезд `STATUS`, `WAIT_REASON`, новый `AGENT`, `sectionOf`,
`isAttention`; потребители `state.js` (в том числе `'codex'` на `276-279`), `server.js:440,709`,
`board-config.js`, `board-view.js`, `notifications.js`, `rail.js`: после шага литералов статусов
и агентов вне `domain.js` нет. Удалить `isWaiting`, `relativeTime`, `durationText`. Развести
слова: `idle` (фронт, 4 мин, класс `.idle`) и `stale` (сервер, 6 ч). RED: `test/domain.test.js`;
`WAIT_BADGE` покрывает все `WAIT_REASON`. Вживую: Cmd+R и headless-скрин копии. 1.5 ч.

**2. `src/config.js` + `src/log.js`.** `loadConfig(env, { log, exists })`, `envNumber` внутри;
канал берёт порт тем же `loadConfig`. RED: `test/config.test.js` (дефолты, ноль и мусор в
лог, `FLEET_CHANNEL`). 1.5 ч.

**3. `src/http/sse-hub.js` + `sse-frames.js`.** `createSseHub({ log, maxBuffered, keepAliveMs })`
с `open`, `write`, `size`, `close`; борды и каналы через него. RED: хаб на `http.createServer`
в процессе (нечитающий клиент рвётся, heartbeat идёт, `close()` чистит интервалы); парсер на
склейке кадров. 2 ч.

**4. `createFleet` и тонкий `server.js`.** Два коммита. 4a: механически завернуть тело
`server.js` в `export function createFleet(...)` с `{ server, close }`, `server.js` это entry;
вживую до 4b. 4b: `test/server.test.js` in-process: порт по-прежнему резервирует `freePort()`
и идёт в `config.port`, потому что `ALLOWED_HOSTS` строится от порта до `listen`
(`guards.js:21-33`, `server.js:157-161`) и `listen(0)` дал бы 403 на каждый запрос; `close()` в
`finally`. Спавн остаётся для «битый id не роняет процесс» и `EADDRINUSE`. Таймеры через
`mock.timers`, `dropSettledPermissions` без `sleep(3000)`. RED: после `close()` нет открытых
хендлов. 4 ч.

**5. `src/channel/registry.js` + `routes.js`.** Каналы, `pendingPermissions`, `dropSettled`,
`REQUEST_ID_RE`, `MAX_CHANNELS` с одним `forget(pid)`. RED: реестр с фейковым `res`
(переподключение закрывает прежний поток, потолок 503, settle через `mock.timers`). Вживую:
`/stats.channels`, кнопка «Разрешить» на настоящей сессии. 2 ч.

**6. `src/fleet/store.js` + `src/usage/scanner.js`.** `load()` с `bootMs` параметром,
`persist()` атомарно 0600 с `schema: 2` (старый файл мигрирует один раз, inline-миграции из
`applyEvent:309-313` уходят). RED: store на fake fs (обрезанный JSON → пусто плюс лог, mtime
до boot → пусто); сканер на временной папке. 2.5 ч.

**7. `src/fleet/hook-event.js`.** `normalizeHookEvent(raw, headers)` → `{ agent, sessionId,
kind, cwd, appId, pid, prompt, tool, toolInput, notification, message, isError }`; `applyEvent`
принимает нормализованное, фасад `applyRawEvent` сохраняет 60 тестов `state.test.js`. RED:
нормализация на образцах Claude и Codex. 2 ч.

**8. Фронт: `ui/markup.js` и `ui/order.js`.** В `markup.js` уезжают все строители строк:
`cardHtml`, `rowHtml`, `actsHtml`, `badgeFor`, `avatarHtml`, `originHtml`, `wtreeHtml`,
`toolHtml`, `killHtml`, `cardSig`; в `order.js` сортировки и ключ раскладки. `board-view.js`
остаётся DOM-склейкой (~240 строк). RED: `markup.test.js` (кнопки только при
`channel`, плейсхолдер без промпта, экранирование), `order.test.js` (проект → агент → старшая
выше; дольше ждущий сверху). Вживую: Cmd+R, headless-скрин. 2 ч.

**9. `scripts/hooks-merge.mjs`.** `node hooks-merge.mjs <settings> <hook> --agent claude|codex
[--remove]` из `install.sh`/`uninstall.sh`. RED: чужой хук переживает установку и снятие,
голый путь мигрирует в кавычки, битый JSON → exit 1 без записи. 2 ч.

**10. Типы (развилка 1).** JSDoc + `tsc --checkJs --noEmit` job; `types.d.ts` с `Card`,
`FleetEvent`, `Snapshot`, `Config`; `@import` в JSDoc. `typescript` только devDependency
корня, рантайм без зависимостей. 4 ч.

**11. Доверие в LAN (развилка 4).** `FLEET_TOKEN` в `.env`, чистая `isTrustedPeer(remoteAddress,
cookies, token)` в `guards.js`, cookie `HttpOnly; SameSite=Strict` через `/?token=`, loopback без
токена. RED: тесты guards. 2 ч.

## 5. Развилки: решения владельца от 06.09.2026 (не переоткрывать)

Принято по всем шести рекомендуемое: 1 JSDoc + `tsc --checkJs`; 2 снимок целиком без серверной
сортировки; 3 чистые модули без DOM-эмулятора; 4 токен-cookie последним шагом; 5 `src/` с
папками контекстов; 6 в этой сессии только план, реализация в новой сессии.

1. **JSDoc + `tsc --checkJs`, `.ts` для сервера или без типов?** Рекомендую JSDoc. Факты:
   Node 22.22.3 снимает типы без флага с 22.18 (`process.features.typescript === 'strip'`,
   проверено пробой); нельзя `enum`, `namespace` с кодом, parameter properties, декораторы,
   `tsconfig` не читается, импорты только с `.ts` (проверено: `enum` падает, `import type`
   работает). Проверку типов Node не делает, `tsc` нужен в любом варианте; фронт без сборки
   `.ts` не исполнит, `public/js/lib` общий с сервером обязан остаться `.js`. `.ts`: две
   конвенции в репо, переименование 8 модулей и тестов, 8-10 ч. JSDoc: одна конвенция, 4 ч.
   Без типов: 0 ч, `Card` остаётся неявной структурой в 6 файлах.
2. **Снимок целиком или диффы по карточкам?** Рекомендую снимок без серверной сортировки.
   3.3 КБ при 3 сессиях, 20 КБ при 20, дебаунс 50 мс уже стоит. Диффы: версия карточки,
   `remove`, ресинк по `Last-Event-ID`, патчи на клиенте, новый класс ошибок «борд разошёлся»,
   ~200 строк с тестами; выигрыш только на Wi-Fi-планшете.
3. **Тесты фронта: чистые модули, `happy-dom` или `jsdom`?** Чистые модули (шаг 8): `happy-dom`
   20.14 тянет 7 прямых зависимостей, `jsdom` 30.0 - 21 (`npm view`); покрыли бы ещё `cardEl`
   и слоты. Цена: реконсиляция и клавиатура остаются на headless-скрине.
4. **Планшет в LAN: токен-cookie или туннель?** Токен (шаг 11) последним. Сейчас
   `FLEET_ALLOWED_HOSTS` открывает `/stream` со всеми промптами любому в сети. Туннель
   (SSH/Tailscale) это 0 строк, но на планшете нужен клиент.
5. **`src/<контекст>/` или плоский корень?** `src/`: переезд через `git mv` плюс пути в тестах
   и CLAUDE.md отдельным коммитом, entry `server.js` и plist не меняются.
6. **Эта сессия: только план или начать шаги 0-1?** Решено: только план.

## 6. Риски

- Шаг 4 самый крупный, борд используется ежедневно: 4a механический, вживую до 4b.
- Критик плана (sonnet, один прогон): две находки вошли в текст (порт в 4b, строки
  `uninstall.sh`); PID-reuse канала остаётся открытым риском аудита №12.
- `mock.timers` не мокает `Date.now` без `apis: ['Date']`; отсюда `clock` в фабрике.
- `channel/` импортирует `../src/config.js` через границу своего `package.json`: в ESM
  работает, `npm pack` из `channel/` не соберёт (не нужен).

## 7. Оценка

| Шаг | Часы | Шаг | Часы |
|-----|------|-----|------|
| 0 CI + e2e канала | 1.5 | 6 store + scanner | 2.5 |
| 1 domain.js | 1.5 | 7 hook-event | 2 |
| 2 config + log | 1.5 | 8 фронт чистые модули | 2 |
| 3 sse-hub | 2 | 9 hooks-merge | 2 |
| 4 createFleet | 4 | 10 типы (JSDoc) | 4 |
| 5 channel registry | 2 | 11 токен LAN | 2 |

Итого 27 ч; без шагов 10-11 21 ч. Шаги 0-3 (6.5 ч) дают тесты канала, словарь, конфиг и SSE
под тестом до того, как трогать композицию.
