/**
 * 运行时共享类型。
 *
 * 单独成文件是为了打断 `gateway.ts ↔ relay.ts` 的循环 import：两个模块都需要
 * 描述「运行时依赖」与「归一化凭证」，把它们放在这里后，两边都只依赖本文件。
 */

import type {
  AuthService,
  PluginLogger,
  PluginSecrets,
  StateService,
  WalletService,
} from '@stackpanel/sdk';

/** 运行时依赖，由 index.ts 在 onActivate 时注入。 */
export interface GatewayRuntime {
  wallet: WalletService;
  auth: AuthService;
  state: StateService;
  secrets: PluginSecrets;
  logger: PluginLogger;
}

/**
 * 归一化后的网关凭证：内核 `ApiToken` + 插件策略 `GatewayKeyPolicy`，
 * 或历史 `GatewayApiKey`（P0.6 双读兜底）。
 */
export interface GatewayKey {
  id: string;
  userId: string;
  name: string;
  status: string;
  models: string[];
  rpmLimit: number;
  concurrencyLimit: number;
  quotaLimit: number | null;
  quotaUsed: number;
  /** 长周期配额（P1）：每 `quotaWindowHours` 小时最多 X 次 / Y token；0 = 不限。 */
  quotaWindowHours: number;
  quotaMaxRequests: number;
  quotaMaxTokens: number;
  expiresAt: string | null;
  /** 凭证来源：内核平台凭证，或历史表兜底。 */
  source: 'token' | 'legacy';
}

/** 平台级网关配置（管理端可调，见 `llm-gateway/config`）。 */
export interface GatewayConfig {
  /** 全局在途请求上限；0 = 不限。 */
  globalConcurrency: number;
  /** 每用户 RPM；0 = 不限。 */
  userRpm: number;
  /** 每模型 RPM；0 = 不限。 */
  modelRpm: number;
  /** 每 provider RPM；0 = 不限。 */
  providerRpm: number;
  /** 上游失败最大尝试次数（含首次）。 */
  retryAttempts: number;
  /** 非流式响应体大小上限（字节）。 */
  maxResponseBytes: number;
  /** 预留 hold 的 TTL（毫秒）。 */
  holdTtlMs: number;
  /** 自动摘号：错误体关键词（大小写无关）。 */
  autoDisableKeywords: string[];
  /** 自动摘号：命中即冷却整号的 HTTP 状态码。 */
  autoDisableStatusCodes: number[];
  /** 自动摘号冷却时长（毫秒）。 */
  autoDisableCooldownMs: number;
  /** 预算限额默认周期（B3）：day / month。 */
  budgetPeriod: string;
  /** 敏感词表（D2）；空数组 = 不过滤。 */
  sensitiveWords: string[];
  /** 命中动作（D2）：block / log。 */
  sensitiveWordAction: string;
  /** 公开价格表换算汇率（1 USD = ? minor）；只影响参考价展示。 */
  usdRateMinor: number;
}

export const DEFAULT_CONFIG: GatewayConfig = {
  globalConcurrency: 0,
  userRpm: 0,
  modelRpm: 0,
  providerRpm: 0,
  retryAttempts: 3,
  maxResponseBytes: 32 * 1024 * 1024,
  holdTtlMs: 15 * 60 * 1000,
  autoDisableKeywords: [
    'insufficient balance',
    'insufficient_quota',
    '余额不足',
    '已欠费',
    'account has been disabled',
    'invalid api key',
  ],
  autoDisableStatusCodes: [],
  autoDisableCooldownMs: 10 * 60 * 1000,
  budgetPeriod: 'month',
  // 默认关闭：词表为空即不过滤。合规要求开启时由管理员显式配词。
  sensitiveWords: [],
  sensitiveWordAction: 'block',
  usdRateMinor: 700,
};
