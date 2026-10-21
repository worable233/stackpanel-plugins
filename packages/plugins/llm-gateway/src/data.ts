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
    /**
     * 厂商特有配置（Azure 的 deployment/apiVersion、Vertex 的 project/region/
     * accessToken、Bedrock 的 region/accessKeyId/secretAccessKey、OpenRouter 的
     * httpReferer/xTitle…）。用 Json 而不是逐厂商加列：新增 provider 不应改动
     * 数据表（ADR-0008 插件自治，schema 变更要迁移）。
     */
    options: z.record(z.string(), z.unknown()).default({}),
    /** 每账号 RPM；0 = 不限。 */
    rpmLimit: z.number().int().default(0),
    /** 是否参与选号（运维可手动摘除而不删除）。 */
    enabled: z.boolean().default(true),
    /** 渠道亲和性标签：请求可带 `x-gateway-affinity` 指定优先命中同标签账号。 */
    affinity: z.string().default(''),
    lastUsedAt: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['lastUsedAt'], types: { lastUsedAt: 'string' } },
    { fields: ['enabled'], types: { enabled: 'boolean' } },
    { fields: ['affinity'], types: { affinity: 'string' } },
  ],
  /**
   * 账号池是热路径上的读多写少配置：每个中转请求都要挑账号，但配置极少变。
   * 任何对配置字段（models / status / priority / weight / maxConcurrency /
   * baseUrl）的写入都会让内核失效全部副本的缓存。
   */
  cacheTtlMs: 30_000,
  /**
   * `lastUsedAt` 是纯统计列：结算时都会刷新它，但它不改变路由结果。
   * 声明为 volatile 后，只写这一列的更新不会打穿账号池缓存
   * （PLAN-perf-hardening P11）。
   */
  volatileFields: ['lastUsedAt'],
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

/**
 * 平台级网关配置（单例，实例 id 固定 `'default'`）。
 *
 * 这些是**运维旋钮**而非业务数据：并发上限、各级 RPM、重试次数、响应体上限、
 * 预留 TTL。放在插件表而不是环境变量里，是为了让管理员在面板上改完立即生效，
 * 不必重启进程（目标七「并发和限流」可配可管控）。
 */
export const gatewayConfigModel = defineModel({
  kind: 'llm-gateway/config',
  label: '中转平台配置',
  schema: z.object({
    /** 全局在途请求上限；0 = 不限。 */
    globalConcurrency: z.number().int().default(0),
    /** 每用户 RPM；0 = 不限。 */
    userRpm: z.number().int().default(0),
    /** 每模型 RPM；0 = 不限。 */
    modelRpm: z.number().int().default(0),
    /** 每 provider RPM；0 = 不限。 */
    providerRpm: z.number().int().default(0),
    /** 上游失败最大尝试次数（含首次）。 */
    retryAttempts: z.number().int().default(3),
    /** 非流式响应体大小上限（字节）。 */
    maxResponseBytes: z
      .number()
      .int()
      .default(32 * 1024 * 1024),
    /** 预留 hold 的 TTL（毫秒）。 */
    holdTtlMs: z
      .number()
      .int()
      .default(15 * 60 * 1000),
  }),
  indexes: [],
  cacheTtlMs: 30_000,
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

/**
 * 逐请求用量流水；后付费据此扣钱包（幂等引用 = 本行 id）。
 *
 * 计费覆盖（目标五）要求按真实用量拆分到各类 token 与非 token 计费单位：
 * 文本 in/out、缓存读/写、推理 token、图片张数、音频秒数。上游不返回 usage 时
 * 按本仓估算器估算并置 `estimated=true`（**必须**包含 prompt，不允许把流式
 * fallback 的 prompt 计为 0）。
 */
export const gatewayUsageLogModel = defineModel({
  kind: 'llm-gateway/usage-log',
  label: '中转用量流水',
  schema: z.object({
    apiKeyId: z.string(),
    userId: z.string(),
    accountId: z.string().nullable().optional(),
    model: z.string(),
    /** 入口协议（openai-chat / anthropic / gemini / …），便于按协议对账。 */
    protocol: z.string().default('openai-chat'),
    /** 计费对应的 endpoint id（与 endpoints.ts 对应）。 */
    endpoint: z.string().default('chat.completions'),
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    cacheReadTokens: z.number().int().default(0),
    cacheWriteTokens: z.number().int().default(0),
    /** 推理 token（输出侧子集）。 */
    reasoningTokens: z.number().int().default(0),
    /** 图片张数（图片计费）。 */
    imageCount: z.number().int().default(0),
    /** 音频秒数（语音计费）。 */
    audioSeconds: z.number().default(0),
    totalTokens: z.number().int().default(0),
    amount: z.number().default(0),
    currency: z.string().default('CNY'),
    status: z.string().default('SUCCESS'),
    /** 用量是否为估算值（上游未返回 usage）。账单据此标记。 */
    estimated: z.boolean().default(false),
    /**
     * 价格版本快照的键（= 计费台账 referenceId）。对账时用它与台账的
     * `priceSnapshot` 关联，保证历史账单可复算。
     */
    priceRef: z.string().nullable().optional(),
    httpStatus: z.number().int().nullable().optional(),
    latencyMs: z.number().int().nullable().optional(),
    /** 首 token 延迟（毫秒）；非流式为 null。 */
    firstTokenMs: z.number().int().nullable().optional(),
    clientIp: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['apiKeyId'], types: { apiKeyId: 'string' } },
    { fields: ['accountId'], types: { accountId: 'string' } },
    { fields: ['model'], types: { model: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
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
    /** 推理 token 单价；0 表示按 outputPrice 计（不退化为免费）。 */
    reasoningPrice: z.number().int().default(0),
    /** 图片单价（minor/张）；用于 images/* 与多模态图片。 */
    imagePrice: z.number().int().default(0),
    /** 音频单价（minor/秒）；用于 audio/*。 */
    audioPrice: z.number().int().default(0),
    multiplier: z.number().int().default(100),
    capabilities: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  }),
  indexes: [
    { fields: ['model'], unique: true, types: { model: 'string' } },
    { fields: ['enabled'], types: { enabled: 'boolean' } },
  ],
  /**
   * 定价每请求都要读、却几乎从不改：缓存它可以直接消掉每个中转请求的
   * 「全表读定价」。改价写入会自动失效全部副本。
   */
  cacheTtlMs: 60_000,
});

/**
 * 计费台账（目标五）。一次请求一行，承载预留 → 结算 → 补偿的完整生命周期。
 *
 * 为什么要在 usage-log 之外再开一张表：usage-log 是**用量事实**（给用户看账单），
 * 一次请求可能因为补偿重试被更新多次；台账是**状态机**（给运维和补偿队列用），
 * 需要 `status` / `attempt` / `nextAttemptAt` / `lastError` 这些运维字段。
 * 两者用 `referenceId` 一对一关联，usage-log 保留幂等键（既有行为不变）。
 *
 * `priceSnapshot` 是**价格版本快照**：结算与补偿都按快照算，绝不回头读
 * model-price 现值。否则管理员改价会让在途请求按新价结算，甚至让补偿队列
 * 用新价重算历史账单 —— 这是资金正确性问题，不是口径问题。
 */
export const gatewayBillingEntryModel = defineModel({
  kind: 'llm-gateway/billing-entry',
  label: '中转计费台账',
  schema: z.object({
    userId: z.string(),
    apiKeyId: z.string(),
    accountId: z.string().nullable().optional(),
    model: z.string(),
    /** 关联的用量流水 id（usage-log 的主键），保证一对一并用于幂等。 */
    referenceId: z.string(),
    /** 预留的钱包 hold id；无预留（0 元）时为 null。 */
    holdId: z.string().nullable().optional(),
    /**
     * 计费状态机：
     * - RESERVED    已预留，请求在途；
     * - SETTLED     已按真实用量结算完成；
     * - RELEASED    请求失败且未消耗，已全额释放；
     * - COMPENSATING 结算/扣费失败，在补偿队列中等待重试；
     * - COMPENSATED 补偿成功；
     * - FAILED      补偿超过上限，已按欠费处理（冻结账户）。
     */
    status: z.string().default('RESERVED'),
    /** 预留金额（minor）。 */
    reservedAmount: z.number().default(0),
    /** 实际结算金额（minor）；未结算为 0。 */
    settledAmount: z.number().default(0),
    currency: z.string().default('CNY'),
    /** 价格版本快照：结算与补偿都读它，不读现值。 */
    priceSnapshot: z.record(z.string(), z.unknown()).default({}),
    /** 补偿重试次数。 */
    attempt: z.number().int().default(0),
    /** 下次补偿时间戳（ms）；0 表示可立即处理。 */
    nextAttemptAt: z.number().default(0),
    /** 最近一次失败原因（脱敏）。 */
    lastError: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['referenceId'], unique: true, types: { referenceId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['nextAttemptAt'], types: { nextAttemptAt: 'number' } },
  ],
});

/**
 * 异步任务记录（目标二/七：图片、音频、视频、批处理等异步任务的状态查询）。
 *
 * 上游厂商的异步任务（如 OpenAI Batches）由网关透传 `upstreamId`；网关自身的
 * 长任务（视频生成排队）用它记录本地状态。`kind` 区分，`status` 供管理端筛选。
 */
export const gatewayTaskModel = defineModel({
  kind: 'llm-gateway/task',
  label: '中转异步任务',
  schema: z.object({
    userId: z.string(),
    /** 任务种类：images / audio / video / batch / fine_tuning / file 等。 */
    kind: z.string(),
    /** 入口 endpoint id（与 endpoints.ts 对应，便于运维定位）。 */
    endpoint: z.string(),
    /** 上游返回的任务 id；纯本地任务可为空。 */
    upstreamId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    /** QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED / EXPIRED。 */
    status: z.string().default('QUEUED'),
    /** 上游原始状态（保留厂商语义，供排障）。 */
    upstreamStatus: z.string().nullable().optional(),
    /** 结果引用（文件 id / URL / 对象引用）。 */
    resultRef: z.string().nullable().optional(),
    /** 关联的计费台账 referenceId（异步结算用）。 */
    billingRef: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['kind'], types: { kind: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
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
  options: Record<string, unknown>;
  rpmLimit: number;
  enabled: boolean;
  affinity: string;
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

export interface GatewayConfigData {
  globalConcurrency: number;
  userRpm: number;
  modelRpm: number;
  providerRpm: number;
  retryAttempts: number;
  maxResponseBytes: number;
  holdTtlMs: number;
}

export interface GatewayUsageLogData {
  apiKeyId: string;
  userId: string;
  accountId?: string | null;
  model: string;
  protocol: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  imageCount: number;
  audioSeconds: number;
  totalTokens: number;
  amount: number;
  currency: string;
  status: string;
  estimated: boolean;
  priceRef?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  firstTokenMs?: number | null;
  clientIp?: string | null;
  error?: string | null;
}

/** 计费台账载荷类型（目标五状态机）。 */
export interface GatewayBillingEntryData {
  userId: string;
  apiKeyId: string;
  accountId?: string | null;
  model: string;
  referenceId: string;
  holdId?: string | null;
  status: string;
  reservedAmount: number;
  settledAmount: number;
  currency: string;
  priceSnapshot: Record<string, unknown>;
  attempt: number;
  nextAttemptAt: number;
  lastError?: string | null;
}

/** 异步任务载荷类型。 */
export interface GatewayTaskData {
  userId: string;
  kind: string;
  endpoint: string;
  upstreamId?: string | null;
  model?: string | null;
  status: string;
  upstreamStatus?: string | null;
  resultRef?: string | null;
  billingRef?: string | null;
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
  reasoningPrice: number;
  imagePrice: number;
  audioPrice: number;
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
