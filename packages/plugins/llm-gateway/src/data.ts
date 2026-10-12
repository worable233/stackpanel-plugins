import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 中转网关的插件自治数据（ADR-0008 / E3）。
 *
 * 凭证本身是内核身份能力 `ApiToken`（经 `ctx.auth`），这里只放**插件域**数据：
 * 账号池、逐 key 策略、用户计费开关、用量流水、模型定价，以及 P0.6 迁移前的历史密钥表。
 */

/** 上游账号池。apiKey 不入库，明文加密存插件 secrets（apiKeyRef）。 */
export const gatewayAccountModel = defineModel({
  kind: 'llm-gateway/account',
  label: '中转上游账号',
  schema: z.object({
    name: z.string(),
    provider: z.string().default('openai-chat'),
    baseUrl: z.string(),
    apiKeyRef: z.string(),
    models: z.array(z.string()).default([]),
    status: z.string().default('ACTIVE'),
    priority: z.number().int().default(0),
    weight: z.number().int().default(100),
    maxConcurrency: z.number().int().default(0),
    lastUsedAt: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['lastUsedAt'], types: { lastUsedAt: 'string' } },
  ],
});

/** 对某把平台凭证（ApiToken）的插件级策略；实例 id 即 apiTokenId。 */
export const gatewayKeyPolicyModel = defineModel({
  kind: 'llm-gateway/key-policy',
  label: '中转密钥策略',
  schema: z.object({
    apiTokenId: z.string(),
    models: z.array(z.string()).default([]),
    rpmLimit: z.number().int().default(0),
    concurrencyLimit: z.number().int().default(0),
    quotaLimit: z.number().int().nullable().optional(),
    quotaUsed: z.number().default(0),
  }),
  indexes: [
    { fields: ['apiTokenId'], unique: true, types: { apiTokenId: 'string' } },
    { fields: ['quotaUsed'], types: { quotaUsed: 'number' } },
  ],
});

/** 用户级 API 计费开关；实例 id 即 userId。 */
export const gatewayUserSettingModel = defineModel({
  kind: 'llm-gateway/user-setting',
  label: '中转用户设置',
  schema: z.object({
    userId: z.string(),
    billingEnabled: z.boolean().default(false),
  }),
  indexes: [{ fields: ['userId'], unique: true, types: { userId: 'string' } }],
});

/** 逐请求用量流水；后付费据此扣钱包（幂等引用 = 本行 id）。 */
export const gatewayUsageLogModel = defineModel({
  kind: 'llm-gateway/usage-log',
  label: '中转用量流水',
  schema: z.object({
    apiKeyId: z.string(),
    userId: z.string(),
    accountId: z.string().nullable().optional(),
    model: z.string(),
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    cacheReadTokens: z.number().int().default(0),
    cacheWriteTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
    amount: z.number().default(0),
    currency: z.string().default('CNY'),
    status: z.string().default('SUCCESS'),
    httpStatus: z.number().int().nullable().optional(),
    latencyMs: z.number().int().nullable().optional(),
    clientIp: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['apiKeyId'], types: { apiKeyId: 'string' } },
    { fields: ['accountId'], types: { accountId: 'string' } },
  ],
});

/** 模型定价（minor / 百万 token）。 */
export const gatewayModelPriceModel = defineModel({
  kind: 'llm-gateway/model-price',
  label: '中转模型定价',
  schema: z.object({
    /**
     * 对外（用户）展示并可调用的模型名，也是计费与 key 白名单的键。
     * 可为自定义名，不必等于上游真实模型名。
     */
    model: z.string(),
    /**
     * 实际转发给上游的模型名。留空表示与 `model` 相同（向后兼容）。
     * 例如对外卖 `deepseek-chat`，上游绑定 `deepseek-v4-flash`。
     */
    upstreamModel: z.string().default(''),
    inputPrice: z.number().int().default(0),
    outputPrice: z.number().int().default(0),
    cacheReadPrice: z.number().int().default(0),
    cacheWritePrice: z.number().int().default(0),
    multiplier: z.number().int().default(100),
    capabilities: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  }),
  indexes: [
    { fields: ['model'], unique: true, types: { model: 'string' } },
    { fields: ['enabled'], types: { enabled: 'boolean' } },
  ],
});

/** P0.6 迁移前的历史网关密钥（双读兜底）；key 明文不入库。 */
export const gatewayLegacyKeyModel = defineModel({
  kind: 'llm-gateway/legacy-key',
  label: '中转历史密钥',
  schema: z.object({
    userId: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    keyHash: z.string(),
    status: z.string().default('ACTIVE'),
    models: z.array(z.string()).default([]),
    rpmLimit: z.number().int().default(0),
    concurrencyLimit: z.number().int().default(0),
    quotaLimit: z.number().int().nullable().optional(),
    quotaUsed: z.number().default(0),
    expiresAt: z.string().nullable().optional(),
    lastUsedAt: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['keyHash'], unique: true, types: { keyHash: 'string' } },
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['quotaUsed'], types: { quotaUsed: 'number' } },
    { fields: ['lastUsedAt'], types: { lastUsedAt: 'string' } },
  ],
});

/* ------------------------------- 载荷类型 ------------------------------- */

export interface GatewayAccountData {
  name: string;
  provider: string;
  baseUrl: string;
  apiKeyRef: string;
  models: string[];
  status: string;
  priority: number;
  weight: number;
  maxConcurrency: number;
  lastUsedAt?: string | null;
}

export interface GatewayKeyPolicyData {
  apiTokenId: string;
  models: string[];
  rpmLimit: number;
  concurrencyLimit: number;
  quotaLimit?: number | null;
  quotaUsed: number;
}

export interface GatewayUserSettingData {
  userId: string;
  billingEnabled: boolean;
}

export interface GatewayUsageLogData {
  apiKeyId: string;
  userId: string;
  accountId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  amount: number;
  currency: string;
  status: string;
  httpStatus?: number | null;
  latencyMs?: number | null;
  clientIp?: string | null;
  error?: string | null;
}

export interface GatewayModelPriceData {
  model: string;
  /** 实际转发给上游的模型名；空串表示与 `model` 相同。 */
  upstreamModel: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
  multiplier: number;
  capabilities: string[];
  enabled: boolean;
}

export interface GatewayLegacyKeyData {
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  status: string;
  models: string[];
  rpmLimit: number;
  concurrencyLimit: number;
  quotaLimit?: number | null;
  quotaUsed: number;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}
