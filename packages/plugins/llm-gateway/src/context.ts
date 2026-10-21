import type {
  AuthService,
  ExtensionClient,
  ExtensionTransaction,
  PluginContext,
  PluginLogger,
  PluginSecrets,
  StateService,
  WalletService,
} from "@stackpanel/sdk";

let ctx: PluginContext | null = null;
let extensionClient: ExtensionClient | null = null;
let transactionRunner:
  (<T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>) | null =
  null;
let authService: AuthService | null = null;
let walletService: WalletService | null = null;
let stateService: StateService | null = null;
let secretsService: PluginSecrets | null = null;
let loggerService: PluginLogger | null = null;

export function bindContext(pluginCtx: PluginContext): void {
  ctx = pluginCtx;
  extensionClient = pluginCtx.extensions;
  transactionRunner = pluginCtx.tx;
  authService = pluginCtx.auth;
  walletService = pluginCtx.wallet;
  stateService = pluginCtx.state;
  secretsService = pluginCtx.secrets;
  loggerService = pluginCtx.logger;
}

export function resetContext(): void {
  ctx = null;
  extensionClient = null;
  transactionRunner = null;
  authService = null;
  walletService = null;
  stateService = null;
  secretsService = null;
  loggerService = null;
}

/** The plugin's own extension client. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new Error("llm-gateway.not_ready");
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(
  fn: (tx: ExtensionTransaction) => Promise<T>,
): Promise<T> {
  if (!transactionRunner) throw new Error("llm-gateway.not_ready");
  return transactionRunner(fn);
}

export function auth(): AuthService {
  if (!authService) throw new Error("llm-gateway.not_ready");
  return authService;
}

export function wallet(): WalletService {
  if (!walletService) throw new Error("llm-gateway.not_ready");
  return walletService;
}

export function state(): StateService {
  if (!stateService) throw new Error("llm-gateway.not_ready");
  return stateService;
}

export function secrets(): PluginSecrets {
  if (!secretsService) throw new Error("llm-gateway.not_ready");
  return secretsService;
}

export function logger(): PluginLogger {
  if (!loggerService) throw new Error("llm-gateway.not_ready");
  return loggerService;
}

export function pluginContext(): PluginContext {
  if (!ctx) throw new Error("llm-gateway.not_ready");
  return ctx;
}

/** 声明本插件发出的通知类型（内核偏好目录据此生成配置项）。 */
export const GATEWAY_NOTIFICATION_TYPES = [
  {
    type: "gateway.quota.exhausted",
    category: "wallet" as const,
    label: "API 额度用尽",
    order: 60,
  },
];

/**
 * 额度用尽的回执（best-effort，按 key + 24h 去重）。
 *
 * 这条路径在请求热路径上：用户每次调用都会撞到 402，如果不做去重会把通知刷爆。
 * 用 `state` 记一个 24h 的哨兵，同一 key 一天只提醒一次；写通知本身不 await 也
 * 不行（isolate 可能提前结束），所以仍然 await，但包在 try/catch 里。
 */
export async function notifyQuotaExhausted(input: {
  userId: string;
  keyName: string;
  quotaLimit: number;
  quotaUsed: number;
}): Promise<void> {
  try {
    const ctx = pluginContext();
    const sentinel = `llm:quota-notified:${input.userId}:${input.keyName}`;
    if (await state().get(sentinel)) return;
    await state().set(sentinel, "1", 24 * 60 * 60 * 1000);
    await ctx.notifications.create({
      userId: input.userId,
      type: "gateway.quota.exhausted",
      title: "API 额度已用尽",
      body: `API 凭证「${input.keyName}」的额度已用尽（${input.quotaUsed}/${input.quotaLimit}），在调整额度前调用会被拒绝。`,
      link: "/account/api-keys",
      data: {
        keyName: input.keyName,
        quotaLimit: input.quotaLimit,
        quotaUsed: input.quotaUsed,
      },
      status: "error",
    });
  } catch (error) {
    try {
      logger().warn(`llm-gateway: quota notification failed: ${String(error)}`);
    } catch {
      // 上下文已失效（插件正在停用）：静默放弃。
    }
  }
}
