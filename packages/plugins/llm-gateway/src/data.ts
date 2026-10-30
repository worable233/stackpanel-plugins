import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';
import type { PriceTier } from './pricing.js';
import type { PriceWindow } from './pricing-window.js';

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
    /**
     * 参数/头改写与状态码映射（C4）。**默认关闭**：`enabled !== true` 时整条
     * 链路不做任何改写。写入时经 `validateRewriteConfig` 校验并归一化，
     * 每次改写都随用量流水的 `rewrites` 列留痕。
     */
    rewrites: z.record(z.string(), z.unknown()).default({}),
    /** 每账号 RPM；0 = 不限。 */
    rpmLimit: z.number().int().default(0),
    /** 是否参与选号（运维可手动摘除而不删除）。 */
    enabled: z.boolean().default(true),
    /** 渠道亲和性标签：请求可带 `x-gateway-affinity` 指定优先命中同标签账号。 */
    affinity: z.string().default(''),
    lastUsedAt: z.string().nullable().optional(),
    /**
     * 账号下的多把上游 key（A1）。`apiKeyRef` 仍是「主 key」，
     * 这样旧数据与旧调用方无需迁移即可继续工作；这里的每一条是额外的可用 key。
     *
     * 选号只决定「账号」；在账号内部再按这里的顺序与 `weight` 挑一把 key，
     * 某把 key 被上游限流/封禁时只冷却这一把（state 里的哨兵），不影响同账号其它
     * key——这是单 key 账号做不到的可用性。
     */
    keys: z
      .array(
        z.object({
          id: z.string(),
          label: z.string().default(''),
          apiKeyRef: z.string(),
          /** 组内加权；越大越先被选中。 */
          weight: z.number().int().default(100),
        }),
      )
      .default([]),
    /**
     * 上游余额快照（A2）：探测任务/管理员手动查询后写入，纯展示与告警用，
     * 不参与路由与计费。`null` = 未探测或该厂商不支持查询。
     */
    balance: z.number().nullable().optional(),
    balanceCurrency: z.string().default(''),
    balanceUpdatedAt: z.string().nullable().optional(),
    /** 最近一次上游失败的结构化摘要（A7 自动摘号的可见证据）。 */
    lastError: z.string().nullable().optional(),
    lastErrorAt: z.string().nullable().optional(),
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
    /**
     * 自动摘号（A7）：上游错误体命中任一关键词时，冷却该账号。
     * 典型值：余额不足 / 欠费 / 已封禁 / invalid api key。命中关键词说明重试
     * 同一账号没有意义，冷却比继续换 key 更省上游调用。
     */
    autoDisableKeywords: z.array(z.string()).default([]),
    /** 自动摘号（A7）：上游返回这些 HTTP 状态码时同样冷却账号。 */
    autoDisableStatusCodes: z.array(z.number().int()).default([]),
    /** 关键词/状态码命中的冷却时长（毫秒）。 */
    autoDisableCooldownMs: z
      .number()
      .int()
      .default(10 * 60 * 1000),
    /**
     * 预算限额的统计周期（B3）：逐用户限额可以覆盖它，这里只是全局默认。
     * `month` 与账单/订阅的结算周期一致，因此是默认值。
     */
    budgetPeriod: z.string().default('month'),
    /**
     * 敏感词表（D2）：空 = 关闭。命中后按 `sensitiveWordAction` 处理。
     * 只在文本片段上匹配（不解析图片/工具参数），并同时匹配「去空白」形态以
     * 拦住拆字规避。
     */
    sensitiveWords: z.array(z.string()).default([]),
    /** 命中动作（D2）：`block` 拒绝（不计费）/ `log` 放行并审计。 */
    sensitiveWordAction: z.string().default('block'),
    /**
     * 公开价格表换算汇率：1 USD 折合多少 minor（分）。
     * 默认 700（≈¥7.00/USD）。只影响「参考价」的展示，从不影响实际计费。
     */
    usdRateMinor: z.number().int().default(700),
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
    /**
     * 实际转发给上游的模型名（B4）。与 `model` 不同时说明命中了映射规则，
     * 排障「我明明调用的是 A」时看这一列。
     */
    upstreamModel: z.string().default(''),
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
    /**
     * 成本（A3）：按 `model-price.cost*` 与本次用量算出，与售价 `amount` 各自
     * 独立。成本价未配置时为 0（视为「未知」，看板按 0 计并标注覆盖率）。
     */
    costAmount: z.number().default(0),
    /** 本次实收应用的权限组折扣（百分比，0 = 未折扣）。 */
    discountPercent: z.number().int().default(0),
    /** 实际调用的上游 key（账号多 Key 时用于按 key 对账）。 */
    upstreamKeyId: z.string().default(''),
    /**
     * 本次请求实际被改写了什么（C4）：`body.set:temperature,header.unset:x-foo,
     * status.529>503`。空串 = 没有改写。改配置引发的事故要靠它回溯。
     */
    rewrites: z.string().default(''),
    /** 客户端中断后又继续了计费（A8）：账单需据此复核。 */
    aborted: z.boolean().default(false),
    /** 本次抵扣的套餐权益（B1）；空串 = 没有用套餐。 */
    entitlementId: z.string().default(''),
    /** 套餐抵扣的金额（minor）。`amount - entitlementAmount` 才是钱包实扣。 */
    entitlementAmount: z.number().default(0),
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
    /**
     * 成本价（A3，minor）——与售价同单位、同口径，只用于毛利与上游对账，
     * 不参与用户扣款。0 = 未知（看板把成本算作 0，并在「覆盖率」上体现）。
     */
    costInputPrice: z.number().int().default(0),
    costOutputPrice: z.number().int().default(0),
    costCacheReadPrice: z.number().int().default(0),
    costCacheWritePrice: z.number().int().default(0),
    costReasoningPrice: z.number().int().default(0),
    costImagePrice: z.number().int().default(0),
    costAudioPrice: z.number().int().default(0),
    /**
     * 公开参考价（minor/百万 token）——来自 LiteLLM 公开价格表，**仅供管理员
     * 对照**，从不参与任何计费。
     *
     * 为什么与 `cost*` 分开存：公开表是美元标价 × 汇率换算出来的「业界普遍进价」，
     * 而 `cost*` 是**这家上游实际收你多少**。两者经常不等（渠道折扣、阶梯返点、
     * 汇率差），混成一个字段就没法知道毛利算得准不准。
     */
    refInputPrice: z.number().int().default(0),
    refOutputPrice: z.number().int().default(0),
    refCacheReadPrice: z.number().int().default(0),
    /** 参考价的数据来源与抓取时间，让管理员知道这个数字有多旧。 */
    refSource: z.string().default(''),
    refFetchedAt: z.string().default(''),
    /**
     * 阶梯价（A4）：按本次**输入 token** 落到首個 `from <= promptTokens`
     * 的阶梯（`from` 升序，0 阶为默认价）。未填的字段继承基础价。
     * 买断上下文长度区间（如 32k 以上加价）就在这里表达，不必为每个
     * 夹段建一个模型。
     */
    tiers: z
      .array(
        z.object({
          from: z.number().int(),
          inputPrice: z.number().int().optional(),
          outputPrice: z.number().int().optional(),
          cacheReadPrice: z.number().int().optional(),
          cacheWritePrice: z.number().int().optional(),
          reasoningPrice: z.number().int().optional(),
        }),
      )
      .default([]),
    /**
     * 时段价（峰谷）：按请求到达时刻命中第一个窗口。
     * 与 `tiers` 正交，可同时生效（先时段、后阶梯）。
     */
    windows: z
      .array(
        z.object({
          timezone: z.string().default(''),
          weekdays: z.array(z.number().int()).default([]),
          hours: z.string(),
          percent: z.number().int().default(0),
          inputPrice: z.number().int().optional(),
          outputPrice: z.number().int().optional(),
          cacheReadPrice: z.number().int().optional(),
          cacheWritePrice: z.number().int().optional(),
          reasoningPrice: z.number().int().optional(),
          costInputPrice: z.number().int().optional(),
          costOutputPrice: z.number().int().optional(),
          costCacheReadPrice: z.number().int().optional(),
          costCacheWritePrice: z.number().int().optional(),
        }),
      )
      .default([]),
    /**
     * 该模型的输出上限（token，A8）。客户端不传 `max_tokens` 时，
     * 预授权按它估最坏情况；0 = 用全局默认。
     */
    maxOutputTokens: z.number().int().default(0),
    /** 是否叠加用户权限组折扣（内核 `PermissionGroup.discount`，取各组最大值）。 */
    groupDiscount: z.boolean().default(true),
    /** 计费模式（B2）：flat / tiered / expr；空串 = 自动推断。 */
    strategy: z.string().default(''),
    /** 受限算术表达式（B2）；结果即 minor 金额，不再乘 multiplier。 */
    expr: z.string().default(''),
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
    /** 本笔请求抵扣的套餐权益（B1）；无 = null。 */
    entitlementId: z.string().nullable().optional(),
    /** 套餐抵扣金额（minor）；补偿只处理钱包部分，不重复扣套餐。 */
    entitlementAmount: z.number().default(0),
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
    /* ---- 执行器字段（C1）：提交时写入，轮询时读取 ---- */
    /** 提交时选中的上游账号；轮询必须回到同一个账号（任务只存在于该厂商侧）。 */
    accountId: z.string().nullable().optional(),
    /** 任务描述 id（`tasks.ts` 的注册表键），决定轮询路径与状态词表。 */
    descriptorId: z.string().nullable().optional(),
    /** 提交时使用的网关 key，结算沿用同一归因。 */
    apiKeyId: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    /** 提交请求快照（JSON 字符串：params / upstreamModel / latency / clientIp）。 */
    requestSpec: z.string().nullable().optional(),
    /** 已轮询次数（上限由描述决定）。 */
    attempts: z.number().default(0),
    /** 下次轮询时间戳（毫秒）；终态置 null。 */
    nextPollAt: z.number().nullable().optional(),
    /** 任务过期时间戳：超过即判 EXPIRED 并全额释放冻结。 */
    expiresAt: z.number().nullable().optional(),
    /** 产物列表（JSON 字符串：`[{url, auth}]`；`auth` 表示需带凭据代理）。 */
    artifacts: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['kind'], types: { kind: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['nextPollAt'], types: { nextPollAt: 'number' } },
  ],
});

/**
 * 套餐权益（B1）：一次购买（或管理员手工发放）对应一条记录。
 *
 * 为什么不用权限组承载额度：折扣是「比例」，额度是「数量」，两者语义正交。
 * 权益表只回答「这个用户还有多少额度、覆盖哪些模型、什么时候过期」，扣减在
 * 结算时发生（见 `entitlements.ts`），因此不需要给每个请求建冻结单。
 */
export const gatewayEntitlementModel = defineModel({
  kind: 'llm-gateway/entitlement',
  label: '中转套餐权益',
  schema: z.object({
    userId: z.string(),
    /** 展示名（商品名或管理员备注）。 */
    name: z.string().default(''),
    /** 来源：product = 商店订单履约；admin = 后台手工发放。 */
    source: z.string().default('admin'),
    productId: z.string().default(''),
    orderId: z.string().default(''),
    /** 商店服务实例 id（suspend/terminate 据此定位权益）。 */
    serviceId: z.string().default(''),
    /** 总额度（minor）；0 = 不限量（只受有效期约束）。 */
    quotaAmount: z.number().default(0),
    /** 已抵扣（minor）。 */
    usedAmount: z.number().default(0),
    /** 覆盖的对外模型名；空数组 = 全部模型。 */
    models: z.array(z.string()).default([]),
    startsAt: z.string(),
    /** 到期时间（ISO）；null = 永久。 */
    expiresAt: z.string().nullable().optional(),
    /** ACTIVE / EXHAUSTED / EXPIRED / REVOKED。 */
    status: z.string().default('ACTIVE'),
    /** 扣减优先级：小的先扣（临期套餐更容易被优先用掉）。 */
    priority: z.number().int().default(0),
    revokedReason: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['serviceId'], types: { serviceId: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
  ],
});

/**
 * 模型名映射规则（B4）：对外模型名 → 上游模型名，支持一对多与灰度。
 *
 * 定价行上的 `upstreamModel` 是「一对一死绑定」；这张表补上运营需要的
 * 一对多 / 前缀 / 正则 / 权重分流，且不参与计费口径（映射只改转发目标）。
 */
export const gatewayModelMapModel = defineModel({
  kind: 'llm-gateway/model-map',
  label: '中转模型映射',
  schema: z.object({
    /** 匹配串：精确名 / 前缀 / 正则源码。 */
    from: z.string(),
    /** exact / prefix / regex。 */
    mode: z.string().default('exact'),
    /** 候选上游模型（按权重分流）。 */
    targets: z
      .array(
        z.object({
          model: z.string(),
          weight: z.number().int().default(100),
        }),
      )
      .default([]),
    /** 越大越先匹配。 */
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
    note: z.string().default(''),
  }),
  indexes: [
    { fields: ['enabled'], types: { enabled: 'boolean' } },
    { fields: ['priority'], types: { priority: 'number' } },
  ],
  /** 映射每请求都要解析：与定价一样按表缓存，改动立即失效。 */
  cacheTtlMs: 60_000,
});

/**
 * 预算限额（B3）：`userId === ''` 的行是全局默认。
 *
 * 只影响「是否放行 / 是否提醒」，不参与扣费金额计算——限额可以被并发短暂突破，
 * 真正的资金安全由钱包预留保证。
 */
export const gatewayBudgetLimitModel = defineModel({
  kind: 'llm-gateway/budget-limit',
  label: '中转预算限额',
  schema: z.object({
    userId: z.string().default(''),
    /** day / month。 */
    period: z.string().default('month'),
    /** 限额（minor）；0 = 不限。 */
    amountLimit: z.number().default(0),
    /** 预警阈值百分比（1–100）。 */
    warnPercent: z.number().int().default(80),
    /** warn = 只提醒；block = 达限后拒绝。 */
    action: z.string().default('warn'),
    enabled: z.boolean().default(true),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['enabled'], types: { enabled: 'boolean' } },
  ],
  cacheTtlMs: 30_000,
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

export interface GatewayAccountKeyData {
  id: string;
  label: string;
  apiKeyRef: string;
  weight: number;
}

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
  /** 参数/头改写配置（C4）；空对象或 `enabled !== true` = 不改写。 */
  rewrites?: Record<string, unknown> | null;
  rpmLimit: number;
  enabled: boolean;
  affinity: string;
  lastUsedAt?: string | null;
  /** 账号内额外 key（主 key 仍是 `apiKeyRef`）。 */
  keys: GatewayAccountKeyData[];
  /** 上游余额快照（探测写入；null = 未探测 / 不支持）。 */
  balance?: number | null;
  balanceCurrency: string;
  balanceUpdatedAt?: string | null;
  /** 最近一次上游失败摘要（自动摘号的可见证据）。 */
  lastError?: string | null;
  lastErrorAt?: string | null;
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
  /** 自动摘号（A7）：错误体关键词。 */
  autoDisableKeywords: string[];
  /** 自动摘号（A7）：命中即冷却的 HTTP 状态码。 */
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

export interface GatewayUsageLogData {
  apiKeyId: string;
  userId: string;
  accountId?: string | null;
  model: string;
  /** 实际转发的上游模型名（B4）；与 `model` 相同时可为空。 */
  upstreamModel: string;
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
  /** 本次请求的上游成本（minor）；0 = 成本价未配置（未知）。 */
  costAmount: number;
  /** 实收应用的权限组折扣（%，0 = 未折扣）。 */
  discountPercent: number;
  /** 实际调用的上游 key（账号多 Key 时用于对账）。 */
  upstreamKeyId: string;
  /** 本次请求被改写的痕迹（C4）；空串 = 未改写。 */
  rewrites: string;
  /** 客户端中断后仍计费（A8）。 */
  aborted: boolean;
  /** 抵扣的套餐权益（B1）；空串 = 未用套餐。 */
  entitlementId: string;
  /** 套餐抵扣金额（minor）。 */
  entitlementAmount: number;
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
  /** 抵扣的套餐权益（B1）。 */
  entitlementId?: string | null;
  /** 套餐抵扣金额（minor）。 */
  entitlementAmount: number;
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
  accountId?: string | null;
  descriptorId?: string | null;
  apiKeyId?: string | null;
  currency?: string | null;
  requestSpec?: string | null;
  /** 历史行可能没有该字段（模型演进），读侧一律按 0 处理。 */
  attempts?: number | null;
  nextPollAt?: number | null;
  expiresAt?: number | null;
  artifacts?: string | null;
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
  /** 成本价（minor）：只用于毛利核算。 */
  costInputPrice: number;
  costOutputPrice: number;
  costCacheReadPrice: number;
  costCacheWritePrice: number;
  costReasoningPrice: number;
  costImagePrice: number;
  costAudioPrice: number;
  /** 公开参考价（minor/百万 token）：只给管理员对照，不参与计费。 */
  refInputPrice: number;
  refOutputPrice: number;
  refCacheReadPrice: number;
  refSource: string;
  refFetchedAt: string;
  /** 阶梯价（按输入 token 选阶）。 */
  tiers: PriceTier[];
  /** 时段价（按请求到达时刻选窗口）；与阶梯价正交。 */
  windows: PriceWindow[];
  /** 该模型输出上限（token）；0 = 用全局默认。 */
  maxOutputTokens: number;
  /** 是否叠加用户权限组折扣。 */
  groupDiscount: boolean;
  /** 计费模式（B2）。 */
  strategy: string;
  /** 受限算术表达式（B2）。 */
  expr: string;
  multiplier: number;
  capabilities: string[];
  enabled: boolean;
}

export interface GatewayEntitlementData {
  userId: string;
  name: string;
  source: string;
  productId: string;
  orderId: string;
  serviceId: string;
  quotaAmount: number;
  usedAmount: number;
  models: string[];
  startsAt: string;
  expiresAt?: string | null;
  status: string;
  priority: number;
  revokedReason?: string | null;
}

export interface GatewayModelMapTargetData {
  model: string;
  weight: number;
}

export interface GatewayModelMapData {
  from: string;
  mode: string;
  targets: GatewayModelMapTargetData[];
  priority: number;
  enabled: boolean;
  note: string;
}

export interface GatewayBudgetLimitData {
  userId: string;
  period: string;
  amountLimit: number;
  warnPercent: number;
  action: string;
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
