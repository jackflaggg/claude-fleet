# Handoff: редизайн борда claude-fleet, канал ответа, дешёвые фиксы

Дата среза: 2026-09-05, вечер. Сессия claude-fleet-67 сменила claude-fleet-14 (аудит и макет).
Код изменён, НЕ закоммичен (владелец коммитов не просил). `git status --porcelain` - 20 записей.

## Решения владельца (приняты через AskUserQuestion, не переоткрывать)

1. Раскладка макета «Рейл, искры, ответ с борда» переносится целиком: уголок продолжения
   и плейсхолдер «новая сессия, промпта ещё нет» остаются.
2. Шрифты файлами в `public/assets/fonts` (Roboto Condensed вместо Barlow: у Barlow нет
   кириллицы; IBM Plex Sans; JetBrains Mono; subsets latin + cyrillic, 12 woff2, 334 КБ).
3. Ответ с борда: прототип за флагом `FLEET_CHANNEL=1`, папка `channel/` со своим package.json.
4. `MAX_BODY` поднят до 4 МБ.

## Сделано (проверено)

- `state.js`: `Agent`/`AskUserQuestion`/`Skill`/`ToolSearch` в `toolTarget`; `processPid`
  хранится для любого агента; искра активности `activity[10]` + `activityMinute`
  (`bumpActivity`, ограничена по построению); `unwrapPrompt` снимает обёртки
  `<cross-session-message>` и `<channel>` (жалоба владельца на «бред» в задаче: это был
  промпт от peer-сессии в XML). Реэкспорт из `public/js/lib/activity.js` (общий код с бордом).
- `liveness.js` (переименован из `codex-liveness.js`, тест тоже): `pruneClosedSessions`
  без фильтра по агенту. ⛔ Это расширение: закрытые сессии Claude теперь снимаются по PID
  за 10–20 с. Основание: выборка `ps` поймала процессы `bash` хука с PPID = PID `claude`
  (то есть `$PPID` в report.sh это сама сессия). Владельцу доложить явно.
- `server.js`: `child.on('error')` у spawn фокуса; `MAX_BODY` 4 МБ; отдача `.woff2`
  с immutable-кэшем; `scanLiveness` для всех агентов; за `FLEET_CHANNEL=1` маршруты
  `GET /channel/commands?pid=`, `POST /channel/permission-request`,
  `POST /channel/permission/:id`, `POST /channel/message/:id`; снимок обогащается полями
  `channel` и `permission`; `dropSettledPermissions` (пауза 3 с); `channels` в `/stats`;
  реестр каналов ограничен `MAX_CHANNELS=64`.
- `channel/fleet-channel.js` + `package.json` (sdk 1.30.0, zod 3.25.76, `npm install` сделан,
  `node_modules` 23 МБ, в .gitignore по паттерну). MCP-сервер на stdio: capability
  `claude/channel` + `claude/channel/permission`, SSE к борду за командами, permission_request
  пересылает борду. Привязка к карточке по `process.ppid`.
- Фронт: `index.html` (рейл под шапкой, `.win` убран), `styles.css` целиком (палитра
  макета, @font-face, subgrid-таблица `.tbl`, карточка с таймером 44px), `board-view.js`
  целиком (один слот на секцию, порядок строк append-ом, класс `cont`, искра в tickTimes
  через dataset, кнопки/форма ответа только при `c.channel`), `rail.js` новый,
  `format.js` + `ageText`/`timerText`, `fleet-api.js` + `sendPermission`/`sendReply`,
  `app.js` + `permit`/`reply`, тесты `client-format.test.js`.
- README (2), install.md (1), styles.css, index.html: длинные тире убраны; сортировка строк
  по `createdAt`.
- Проверки: `node --test` - 122 passed; скриншот копии на 4399 (CDP-скрипт `shot.mjs`
  в scratchpad, headless `--screenshot` виснет на открытом SSE) - раскладка как в макете;
  сквозной прогон канала `channel-test.mjs`: initialize с capability, `/stats.channels=1`,
  permission_request доходит до карточки, вердикт allow уходит в stdout, повторный 409,
  текст уходит как `notifications/claude/channel` с `meta.origin=board`, чужой Origin 403.

## Сделано в сессии-приёмнике (2026-09-05, вечер)

1. Выход процесса канала проверен на копии (4399, `FLEET_CHANNEL=1`): initialize с capability,
   `/stats.channels=1`, после `stdin.end()` процесс вышел за 3 мс с кодом 0, `channels=0`.
   Правок в `fleet-channel.js` не потребовалось. Скрипт: scratchpad `channel-test.mjs`.
2. Документация: `CLAUDE.md` (карта файлов, конфиг, инварианты, карточка, «после изменений»,
   v1), `README.md` (статусы, «Как выглядит», уборка по PID, рейл, прототип канала),
   `install.md` (раздел 7 «Ответ с борда»), `.env.example` (`FLEET_CHANNEL=0`,
   пояснение к `FLEET_BOARD_WAIT` 20/60).
3. `node --test` 122 passed; `npm run verify:liveness` прошёл (191 нс на PID-пробу,
   `finalMapSize` 0, RSS +1.3 МБ).
4. Живой сервер перезапущен через `launchctl kickstart -k`; `/stats`: 6 сессий, 1 борд,
   `channels` 0 (в живом `.env` флага `FLEET_CHANNEL` нет).

5. Решение владельца по «закончил ход»: **отдельная нейтральная секция «Закончили ход»**
   между красной и строками. Реализовано: `sectionOf` в `board-config.js` (тест
   `test/board-config.test.js`), три секции в `board-view.js`, `.card.done`/`.badge.done`
   в стилях, рейл без красной засечки у finished, счётчик «закончили ход» в шапке.
   Favicon, заголовок вкладки, сонар и уведомления считают только красные. Снимок копии
   с тремя секциями проверен (CDP, `shot.mjs` + `seed.sh` в scratchpad). `node --test` 125.

## Осталось

- Коммит только по просьбе владельца. Живой борд после правок фронта: Cmd+R.

## Не проверено

- Поведение канала с настоящим Claude Code: флаг `--dangerously-load-development-channels
  server:fleet`, диалог согласия на MCP-сервер, что PPID процесса канала = PID claude
  (для хука проверено, для MCP-сервера нет), что permission_request приходит одновременно
  с терминальным диалогом, что делает channel-сообщение при открытом AskUserQuestion.
- Порядок ключей в JSON события хука (не нужен: лимит просто поднят).
- Цена рендера искры (10 style-записей на строку в секунду при смене столбиков) - на глаз
  дёшево, не замерено.

## Тупики

- Headless Chrome `--screenshot` с `--virtual-time-budget` или `--timeout` виснет на странице
  с открытым EventSource: снимать через CDP (`--remote-debugging-port`, Node 22 `WebSocket`).
- Google Fonts CSS отдаёт woff2 только с Chrome UA; Barlow без кириллицы.
- `rm -rf` в scratchpad-командах режется пермишеном; `nohup ... &` тоже. Копию поднимать
  через `run_in_background`, гасить `lsof -ti :4399 | xargs kill`.
