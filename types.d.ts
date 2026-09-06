/**
 * Типы данных, которые ходят между модулями: карточка сессии, нормализованное событие хука,
 * снимок для борда и конфиг процесса. Рантайм остаётся на JS, файл читает только
 * `tsc --checkJs` (`npm run typecheck`); в коде на него ссылаются через JSDoc `@import`.
 *
 * Статусы, причины и агенты здесь строки, а не литералы: их значения живут в
 * `public/js/lib/domain.js`, и сравнения идут только с константами оттуда.
 */

/** Открытый запрос разрешения из Claude Code, пока борд или терминал не ответили. */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

/** Карточка сессии на борде: то, что лежит в состоянии сервера и уходит в снимок. */
export interface Card {
  /** id карточки; у Codex с префиксом `codex:`, чтобы пространства id не пересекались */
  sessionId: string;
  /** session_id как прислал агент */
  sourceSessionId?: string;
  /** AGENT.CLAUDE | AGENT.CODEX */
  agent: string;
  project: string;
  /** имя git-копии, если сессия живёт в `.claude/worktrees/<имя>` */
  worktree: string | null;
  cwd: string;
  /** bundle-id терминала, где живёт сессия */
  appId: string | null;
  /** подпись терминала для борда (WebStorm, Alacritty...) */
  terminal: string | null;
  /** PID процесса агента ($PPID hook-команды); по нему уборка закрытых и привязка канала */
  processPid: number | null;
  /** последний настоящий промпт */
  title: string;
  tool: string | null;
  toolInfo: string | null;
  /** STATUS.* */
  status: string;
  /** WAIT_REASON.* при STATUS.WAITING; незнакомая причина остаётся красной */
  reason: string | null;
  /** текст уведомления: чего именно ждут */
  note: string | null;
  /** момент входа в ожидание; таймер карточки считается отсюда, а не от updatedAt */
  waitingSince: number | null;
  /** момент первого события: возраст сессии */
  createdAt: number;
  updatedAt: number;
  /** искра: события по минутам, кольцевой буфер фиксированной длины */
  activity?: number[];
  activityMinute?: number;
  /** только при FLEET_CHANNEL=1: к сессии подключён канал ответа */
  channel?: boolean;
  /** только при FLEET_CHANNEL=1: открытый запрос разрешения */
  permission?: PermissionRequest | null;
}

/** Событие хука после `normalizeHookEvent`: ядро состояния сырой схемы не видит. */
export interface FleetEvent {
  /** AGENT.CLAUDE | AGENT.CODEX */
  agent: string;
  /** session_id как прислал агент */
  sessionId: string | null;
  /** hook_event_name */
  kind: string | null;
  cwd: string;
  /** bundle-id терминала сессии */
  appId: string | null;
  /** PID процесса агента ($PPID hook-команды) */
  pid: number | null;
  /** текст промпта (UserPromptSubmit) */
  prompt: string | null;
  /** имя инструмента */
  tool: string | null;
  /** tool_input как есть */
  toolInput: Record<string, unknown> | null;
  /** notification_type ('' если нет) */
  notification: string;
  /** текст уведомления или ошибки */
  message: string | null;
  /** инструмент ответил ошибкой */
  isError: boolean;
}

/** Заголовки запроса от `hooks/report.sh` (node отдаёт их в нижнем регистре). */
export type HookHeaders = Record<string, string | string[] | undefined>;

/** Окно лимита аккаунта, как его видит борд; оставшееся время фронт считает сам. */
export interface UsageWindow {
  startedAt: number;
  endsAt: number;
  requests: number;
  active: boolean;
}

/** Незнакомое событие хука и сколько раз пришло. */
export interface UnknownEvent {
  name: string;
  count: number;
}

/** Кадр SSE `/stream`: всё состояние целиком, сортирует клиент. */
export interface Snapshot {
  sessions: Card[];
  unknown?: UnknownEvent[];
  usage?: UsageWindow | null;
}

/** Конфиг процесса из `loadConfig` (`src/config.js`); заморожен. */
export interface Config {
  port: number;
  host: string;
  /** доп. значения заголовка Host через запятую (борд с планшета) */
  extraHosts: string;
  stateFile: string;
  staleMs: number;
  blankMs: number;
  transcriptsDir: string;
  usageWindowMs: number;
  usageAlignMs: number;
  /** путь к CLI-лаунчеру WebStorm, если он есть на машине */
  webstormLauncher: string | null;
  webstormApp: string;
  channelEnabled: boolean;
}
