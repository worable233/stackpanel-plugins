import type {
  AuthService,
  EventBus,
  ExtensionClient,
  ExtensionTransaction,
  NotificationsService,
} from "@stackpanel/sdk";

/** Stable codes for ticket errors (ADR-0012 §2). */
const TICKET_ERROR_CODES: Record<string, string> = {
  查询参数无效: "ticket.query.invalid",
  请求参数无效: "ticket.request.invalid",
  工单插件未就绪: "ticket.not_ready",
  未登录: "auth.unauthenticated",
  "缺少工单 ID": "ticket.id_required",
  工单不存在: "ticket.not_found",
  无权访问该工单: "ticket.forbidden",
};

export class TicketError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TicketError";
    this.code = TICKET_ERROR_CODES[message] ?? "ticket.error";
  }
}

let extensionClient: ExtensionClient | null = null;
let events: EventBus | null = null;
let auth: AuthService | null = null;
let notificationsService: NotificationsService | null = null;
let transactionRunner:
  (<T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>) | null =
  null;

/** The plugin's own model client, bound at activation. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new TicketError(503, "工单插件未就绪");
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(
  fn: (tx: ExtensionTransaction) => Promise<T>,
): Promise<T> {
  if (!transactionRunner) throw new TicketError(503, "工单插件未就绪");
  return transactionRunner(fn);
}

/** Kernel events bus, bound at activation. */
export function bus(): EventBus {
  if (!events) throw new TicketError(503, "工单插件未就绪");
  return events;
}

/** Kernel auth service, bound at activation. */
export function authService(): AuthService {
  if (!auth) throw new TicketError(503, "工单插件未就绪");
  return auth;
}

/** Kernel notification service, bound at activation. */
export function notifications(): NotificationsService {
  if (!notificationsService) throw new TicketError(503, "工单插件未就绪");
  return notificationsService;
}

export function bindContext(
  extensionClientIn: ExtensionClient,
  eventsIn: EventBus,
  authIn: AuthService,
  runTransactionFn: <T>(
    fn: (tx: ExtensionTransaction) => Promise<T>,
  ) => Promise<T>,
  notificationsIn?: NotificationsService,
): void {
  extensionClient = extensionClientIn;
  events = eventsIn;
  auth = authIn;
  transactionRunner = runTransactionFn;
  // Older call sites may omit it; ticket notifications are best-effort.
  notificationsService = notificationsIn ?? null;
}

export function resetContext(): void {
  extensionClient = null;
  events = null;
  auth = null;
  notificationsService = null;
  transactionRunner = null;
}
