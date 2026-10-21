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
}

export const DEFAULT_CONFIG: GatewayConfig = {
  globalConcurrency: 0,
  userRpm: 0,
  modelRpm: 0,
  providerRpm: 0,
  retryAttempts: 3,
  maxResponseBytes: 32 * 1024 * 1024,
  holdTtlMs: 15 * 60 * 1000,
};
