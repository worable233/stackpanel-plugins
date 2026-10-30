import {
  createAgentProvider,
  gatewayAgentCallModel,
  agentProviderConfig,
  configureAgentProvider,
  clearAgentProvider,
} from './agent-provider.js';
import { definePlugin, PluginError, EXTENSION_POINTS } from '@stackpanel/sdk';
import type {
  HttpReply,
  HttpRequest,
  PluginContext,
  RawHttpReply,
  RawHttpRequest,
} from '@stackpanel/sdk';
import { z } from 'zod';
import { isAllowedUpstreamUrl } from './guard.js';
import { compileExpr } from './pricing-strategy.js';
import { applyDiscount, bestDiscountPercent } from './pricing.js';
import { validatePriceWindows } from './pricing-window.js';
import {
  CATALOG_TTL_MS,
  DEFAULT_USD_RATE_MINOR,
  fetchCatalog,
  hasHolidayGap,
  matchCatalog,
  type CatalogSnapshot,
} from './price-catalog.js';
import { entitlementStatusOf, remainingOf } from './entitlements.js';
import { validateModelMapRule } from './model-map.js';
import { entitlementProductType } from './product-type.js';
import type { GatewayKey } from './runtime.js';
import { GatewayError as HttpGatewayError } from './errors.js';
import { extractApiKey, GATEWAY_SCOPE, newId, toStringArray } from './keys.js';
import { resolveGatewayKey } from './auth.js';
import { PRIMARY_KEY_ID } from './account-keys.js';
import { createRelayHandler, readStream, type GatewayRuntime } from './relay.js';
import { buildArtifactLinks, serveArtifact, streamArtifactBytes } from './artifacts.js';
import {
  clampVideoLimit,
  createVideoBodySchema,
  descriptorIdForVideoModel,
  toOpenAIVideoObject,
  videoTaskParams,
} from './openai-videos.js';
import {
  cancelTask,
  listTaskDescriptors,
  pollTask,
  requireTask,
  runTaskTick,
  submitTask,
  TASK_POLL_INTERVAL_MS,
} from './tasks.js';
import { runCompensation } from './billing.js';
import type { GatewayAccountData } from './data.js';
import { validateRewriteConfig } from './rewrite.js';
import { validateCustomRoute } from './adaptors/custom-route.js';
import { normalizeWordlist } from './sensitive.js';
import { fetchBalance, probeAccount } from './probe.js';
import { readAllMetrics, readLatencyStats, type MetricName } from './observability.js';
import { diagnoseConversion } from './diagnostics.js';
import { runPlayground } from './playground.js';
import { isProtocol, PROTOCOLS } from '@stackpanel/llm-protocol';
import { isKnownProvider, listAdaptors } from './adaptors/index.js';
import {
  gatewayAccountModel,
  gatewayBillingEntryModel,
  gatewayConfigModel,
  gatewayKeyPolicyModel,
  gatewayLegacyKeyModel,
  gatewayModelPriceModel,
  gatewayTaskModel,
  gatewayUsageLogModel,
  gatewayEntitlementModel,
  gatewayModelMapModel,
  gatewayBudgetLimitModel,
  gatewayUserSettingModel,
} from './data.js';
import {
  auth,
  bindContext,
  GATEWAY_NOTIFICATION_TYPES,
  resetContext,
  secrets,
  state,
  wallet,
} from './context.js';
import {
  countAccounts,
  createAccount,
  createPrice,
  getAccount,
  getConfig,
  getPolicy,
  getPrice,
  getSetting,
  listActiveAccounts,
  listAllAccounts,
  listAllPrices,
  listCompensationEntries,
  listEnabledPrices,
  listLogsSince,
  listUsageLogs,
  type UsageLogRow,
  createBudgetLimit,
  createEntitlement,
  expireEntitlements,
  createModelMap,
  listAllEntitlements,
  listBudgetLimits,
  listLogsBetween,
  listModelMaps,
  listUserEntitlements,
  removeBudgetLimit,
  removeModelMap,
  updateBudgetLimit,
  updateEntitlement,
  updateModelMap,
  listPendingCompensations,
  listPoliciesByTokens,
  listRecentAllLogs,
  listRecentLogs,
  getTask,
  listTasks,
  listUserTasks,
  listUserLogsSince,
  removeAccount,
  removePolicy,
  removePrice,
  setConfig,
  setSetting,
  updateAccount,
  updatePrice,
  upsertPolicy,
} from './repository.js';

/**
 * 模型服务网关（预授权 + 按量结算）。
 *
 * - raw 透传路由 `/llm-gateway/*`：四种入口协议按 key 鉴权、选上游账号池转发，
 *   未注册路径 404 / 不支持 501 / 方法不符 405（`endpoints.ts` 注册表驱动）。
 * - API 计费开关（用户级）：开启后才能调用，一个入口调所有模型，可建多把 key。
 * - 计费：请求开始时按上限 `wallet.hold` 预留（冻结），结束时按真实用量结算并退差；
 *   结算失败进补偿队列（`llm-gateway.compensation` 任务）重试，绝不静默吞。
 */

/** CSV 单元格转义（引号翻倍 + 包引号；换行与逗号都安全）。 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 用量流水导出为 CSV（列与页面表格一致；金额为 minor 单位）。 */
function usageLogsCsv(rows: readonly UsageLogRow[]): string {
  const header = [
    'id',
    'createdAt',
    'userId',
    'apiKeyId',
    'accountId',
    'upstreamKeyId',
    'model',
    'endpoint',
    'protocol',
    'totalTokens',
    'amount',
    'costAmount',
    'discountPercent',
    'status',
    'estimated',
    'aborted',
    'httpStatus',
    'latencyMs',
    'error',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.createdAt,
        row.userId,
        row.apiKeyId,
        row.accountId ?? '',
        row.upstreamKeyId ?? '',
        row.model,
        row.endpoint,
        row.protocol,
        row.totalTokens,
        row.amount,
        row.costAmount ?? 0,
        row.discountPercent ?? 0,
        row.status,
        row.estimated,
        row.aborted ?? false,
        row.httpStatus ?? '',
        row.latencyMs ?? '',
        row.error ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

let runtime: GatewayRuntime | null = null;

/** 补偿队列轮询间隔（毫秒）；与 `billing.compensationDelay` 的退避上限无关。 */
const COMPENSATION_INTERVAL_MS = 30_000;

/** Exact messages that map to a stable code (ADR-0012). */
const GATEWAY_ERROR_CODES: Record<string, string> = {
  参数无效: 'llm_gateway.params_invalid',
  '缺少 Base URL 或上游 API Key': 'llm_gateway.upstream_credentials_required',
  '密钥数量已达上限（50）': 'llm_gateway.key_limit_reached',
  未登录: 'auth.unauthenticated',
  密钥不存在: 'llm_gateway.key_not_found',
  账号不存在: 'llm_gateway.account_not_found',
  模型服务插件未就绪: 'llm_gateway.not_ready',
};

/** Messages that carry a variable suffix; matched on the stable prefix. */
const GATEWAY_ERROR_PREFIX_CODES: Record<string, string> = {
  上游返回: 'llm_gateway.upstream_failed',
  拉取模型失败: 'llm_gateway.models_fetch_failed',
};

function gatewayErrorCode(message: string): string {
  const exact = GATEWAY_ERROR_CODES[message];
  if (exact) return exact;
  for (const [prefix, code] of Object.entries(GATEWAY_ERROR_PREFIX_CODES)) {
    if (message.startsWith(prefix)) return code;
  }
  return 'llm_gateway.error';
}

class GatewayError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = gatewayErrorCode(message);
  }
}

function getRuntime(): GatewayRuntime {
  if (!runtime) throw new GatewayError(503, '模型服务插件未就绪');
  return runtime;
}

/* ------------------------------- 校验 schema ------------------------------- */

/** 表单里空字符串/空值统一视为「未提供」。 */
const blankToUndefined = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

/** 模型清单：接受数组或逗号/换行分隔的字符串。 */
function parseModels(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 去掉值为 undefined 的键（Prisma 在 exactOptionalPropertyTypes 下不接受显式 undefined）。 */
type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Defined<T>;
}

const modelsField = z.preprocess(
  (value) => {
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === 'string');
    if (typeof value === 'string') return parseModels(value);
    return undefined;
  },
  z.array(z.string().min(1).max(128)).max(500).optional(),
);

const optionalInt = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional());

/** 允许小数的可选数值（配额窗口按小时，允许 0.5 小时这类设置）。 */
const optionalNumber = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().min(min).max(max).optional());

const optionalString = (max: number) =>
  z.preprocess(blankToUndefined, z.string().min(1).max(max).optional());

const optionalEnum = <T extends [string, ...string[]]>(values: T) =>
  z.preprocess(blankToUndefined, z.enum(values).optional());

const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  models: modelsField,
  rpmLimit: optionalInt(0, 1_000_000),
  concurrencyLimit: optionalInt(0, 10_000),
  /**
   * 长周期配额（P1）：每 `quotaWindowHours` 小时最多 `quotaMaxRequests` 次 /
   * `quotaMaxTokens` 个 token。0 = 不限。用于「零元免费模型每 6 小时 100 次」
   * 这类公平分配；与 60 秒窗口的 `rpmLimit` 互补，不是替代。
   */
  quotaWindowHours: optionalNumber(0, 8760),
  quotaMaxRequests: optionalInt(0, 10_000_000),
  quotaMaxTokens: optionalInt(0, 2_000_000_000),
  quotaLimit: z.preprocess(
    blankToUndefined,
    z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  ),
  expiresInDays: optionalInt(1, 3650),
});

const updateKeySchema = z.object({
  name: optionalString(64),
  status: optionalEnum(['ACTIVE', 'DISABLED']),
  models: modelsField,
  rpmLimit: optionalInt(0, 1_000_000),
  concurrencyLimit: optionalInt(0, 10_000),
  /**
   * 长周期配额（P1）：每 `quotaWindowHours` 小时最多 `quotaMaxRequests` 次 /
   * `quotaMaxTokens` 个 token。0 = 不限。用于「零元免费模型每 6 小时 100 次」
   * 这类公平分配；与 60 秒窗口的 `rpmLimit` 互补，不是替代。
   */
  quotaWindowHours: optionalNumber(0, 8760),
  quotaMaxRequests: optionalInt(0, 10_000_000),
  quotaMaxTokens: optionalInt(0, 2_000_000_000),
  quotaLimit: z.preprocess(
    blankToUndefined,
    z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  ),
});

/** 转换诊断入参（D4）：入口请求体原样传进来，不落库、不转发。 */
const convertDiagnosticsSchema = z.object({
  from: z.string().max(32),
  to: z.string().max(32),
  body: z.unknown(),
  model: optionalString(128),
});

const accountSchema = z.object({
  name: z.string().min(1).max(64),
  baseUrl: z.string().url().max(500).refine(isAllowedUpstreamUrl, '上游地址必须为公网地址'),
  apiKey: z.string().min(1).max(500),
  /**
   * 既接受四种协议名（历史数据与最简配置），也接受已注册的 adaptor id
   * （`deepseek` / `dashscope` / `custom` …）。此前这里只允许协议名，
   * 等于让「厂商预设」与「自定义路由」在管理端根本无法保存。
   */
  provider: z.preprocess(
    blankToUndefined,
    z
      .string()
      .max(64)
      .refine((value) => isProtocol(value) || isKnownProvider(value), '未知的上游 provider')
      .optional(),
  ),
  models: modelsField,
  priority: optionalInt(-1_000_000, 1_000_000),
  weight: optionalInt(1, 100_000),
  maxConcurrency: optionalInt(0, 100_000),
  status: optionalEnum(['ACTIVE', 'DISABLED']),
  /** adaptor 特有参数（如 vertex 的 project / accessToken、azure 的 apiVersion）。 */
  options: z.record(z.string(), z.unknown()).optional(),
  /**
   * 参数/头改写与状态码映射（C4）。默认关闭；这里只做形状检查，
   * 语义校验交给 `validateRewriteConfig`（点路径、头名、状态码范围）。
   */
  rewrites: z.record(z.string(), z.unknown()).optional(),
  /** 账号级 RPM；0 = 不限。 */
  rpmLimit: optionalInt(0, 1_000_000),
  enabled: z.preprocess(blankToUndefined, z.boolean().optional()),
  /** 亲和键：同键请求优先落到同账号（会话粘性）。 */
  affinity: optionalString(128),
  /** 额外 key（A1）：创建时一并写入；主 key 仍用 `apiKey`。最多 20 把。 */
  keys: z
    .array(
      z.object({
        label: optionalString(64),
        apiKey: z.string().min(1).max(500),
        weight: optionalInt(1, 100_000),
      }),
    )
    .max(20)
    .optional(),
});

const accountUpdateSchema = accountSchema.partial().omit({ keys: true });

/** 拉取上游模型清单：可指定已存在账号（复用其 baseUrl/密钥），或直接传临时凭据。 */
const fetchModelsSchema = z.object({
  id: optionalString(191),
  baseUrl: z.preprocess(
    blankToUndefined,
    z.string().url().max(500).refine(isAllowedUpstreamUrl, '上游地址必须为公网地址').optional(),
  ),
  apiKey: optionalString(500),
  provider: z.preprocess(blankToUndefined, z.enum(PROTOCOLS).optional()),
});

/** 上游模型清单：按协议选择 URL 与认证头。 */
function upstreamModelsRequest(
  provider: string,
  baseUrl: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    return {
      url: `${base}/v1/models`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  if (provider === 'gemini') {
    return {
      url: `${base}/v1beta/models`,
      headers: { 'x-goog-api-key': apiKey },
    };
  }
  // openai-chat / openai-responses
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  return { url, headers: { authorization: `Bearer ${apiKey}` } };
}

/** 从不同协议的模型清单响应里提取模型 id 集合并去重排序。 */
function extractModelIds(payload: unknown): string[] {
  const record = payload as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const ids = new Set<string>();
  for (const item of list) {
    if (typeof item === 'string') {
      // Gemini: "models/gemini-2.5-pro" → "gemini-2.5-pro"
      ids.add(item.replace(/^models\//, ''));
      continue;
    }
    if (item && typeof item === 'object') {
      const id =
        typeof (item as { id?: unknown }).id === 'string'
          ? (item as { id: string }).id
          : typeof (item as { name?: unknown }).name === 'string'
            ? (item as { name: string }).name
            : null;
      // Gemini: "models/gemini-2.5-pro" → 去掉前缀。
      if (id) ids.add(id.replace(/^models\//, ''));
    }
  }
  return [...ids].sort();
}

/**
 * 接受「数组」或「JSON 字符串形式的数组」。
 *
 * 存在的唯一理由：管理端表单是扁平的，`tiers`/`windows` 这类嵌套结构只能序列化
 * 成字符串提交。空串视为未提供（表单没填就不该覆盖已有值）。
 */
function jsonArray<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // 故意返回一个不可能通过校验的值：解析失败必须报错，不能变成空数组。
      return Number.NaN;
    }
    // 注意 `.optional()` 必须套在 schema 上（在这里），不能套在 preprocess 外层：
    // `z.preprocess(fn, schema).optional()` 里 preprocess 先把 undefined 交给
    // schema 校验，optional 根本没机会生效。
  }, schema.optional());
}

const priceSchema = z.object({
  model: z.string().min(1).max(128),
  upstreamModel: optionalString(128),
  inputPrice: z.coerce.number().int().min(0).max(2_000_000_000),
  outputPrice: z.coerce.number().int().min(0).max(2_000_000_000),
  cacheReadPrice: optionalInt(0, 2_000_000_000),
  cacheWritePrice: optionalInt(0, 2_000_000_000),
  reasoningPrice: optionalInt(0, 2_000_000_000),
  imagePrice: optionalInt(0, 2_000_000_000),
  audioPrice: optionalInt(0, 2_000_000_000),
  /** 成本价（minor）：只用于毛利核算。 */
  costInputPrice: optionalInt(0, 2_000_000_000),
  costOutputPrice: optionalInt(0, 2_000_000_000),
  costCacheReadPrice: optionalInt(0, 2_000_000_000),
  costCacheWritePrice: optionalInt(0, 2_000_000_000),
  costReasoningPrice: optionalInt(0, 2_000_000_000),
  costImagePrice: optionalInt(0, 2_000_000_000),
  costAudioPrice: optionalInt(0, 2_000_000_000),
  /**
   * 公开参考价（minor/百万 token）：由公开价格目录写入，**从不参与计费**。
   * 与 `cost*` 分开存，因为「业界普遍价」和「这家上游实际收你多少」是两件事。
   */
  refInputPrice: optionalInt(0, 2_000_000_000),
  refOutputPrice: optionalInt(0, 2_000_000_000),
  refCacheReadPrice: optionalInt(0, 2_000_000_000),
  refSource: optionalString(500),
  refFetchedAt: optionalString(64),
  /**
   * 阶梯价（A4）：按输入 token 选阶，未填字段继承基础价。
   *
   * 接受 JSON 字符串：管理端表单是扁平的（内核 `coerceActionInput` 只认
   * `string|integer|number|money|boolean|ids`），数组只能序列化后当字符串传。
   * 解析失败按「参数无效」处理，不会静默变成空数组——静默清空等于偷偷改价。
   */
  tiers: jsonArray(
    z
      .array(
        z.object({
          from: z.coerce.number().int().min(0).max(1_000_000_000),
          inputPrice: optionalInt(0, 2_000_000_000),
          outputPrice: optionalInt(0, 2_000_000_000),
          cacheReadPrice: optionalInt(0, 2_000_000_000),
          cacheWritePrice: optionalInt(0, 2_000_000_000),
          reasoningPrice: optionalInt(0, 2_000_000_000),
        }),
      )
      .max(20),
  ),
  /**
   * 时段价（峰谷）：按请求到达时刻命中第一个窗口。
   * 与 `tiers` 正交（先时段、后阶梯），可叠加「低谷 + 长上下文」。
   */
  windows: jsonArray(
    z
      .array(
        z.object({
          timezone: optionalString(64),
          weekdays: z.array(z.coerce.number().int().min(1).max(7)).max(7).optional(),
          hours: z.string().min(1).max(16),
          percent: optionalInt(0, 1000),
          inputPrice: optionalInt(0, 2_000_000_000),
          outputPrice: optionalInt(0, 2_000_000_000),
          cacheReadPrice: optionalInt(0, 2_000_000_000),
          cacheWritePrice: optionalInt(0, 2_000_000_000),
          reasoningPrice: optionalInt(0, 2_000_000_000),
          costInputPrice: optionalInt(0, 2_000_000_000),
          costOutputPrice: optionalInt(0, 2_000_000_000),
          costCacheReadPrice: optionalInt(0, 2_000_000_000),
          costCacheWritePrice: optionalInt(0, 2_000_000_000),
        }),
      )
      .max(24),
  ),
  /** 该模型输出上限（token）；客户端不传 max_tokens 时用于预留（A8）。 */
  maxOutputTokens: optionalInt(0, 10_000_000),
  /** 是否叠加用户权限组折扣（A4）。 */
  groupDiscount: z.preprocess(blankToUndefined, z.boolean().optional()),
  /**
   * 计费模式（B2）。空串 = 按 `tiers`/`expr` 自动推断，因此旧调用方不必改。
   * `expr` 模式要求能编译通过——写错的定价行宁可写不进去，也不要等首笔请求才发现。
   */
  strategy: z.enum(['', 'flat', 'tiered', 'expr']).optional(),
  /** 受限算术表达式（B2）；结果即 minor 金额。 */
  expr: z.string().max(1_000).optional(),
  capabilities: modelsField,
  multiplier: optionalInt(0, 100_000),
  enabled: z.preprocess(blankToUndefined, z.boolean().optional()),
});

const priceUpdateSchema = priceSchema.partial().omit({ model: true });

const priceCatalogQuerySchema = z.object({
  model: z.string().max(191).optional(),
  /**
   * 临时覆盖汇率（1 USD = ? minor），用于试算。
   * 传 0 表示「不使用参考价」：返回 available:true 但不做任何换算（disabled:true）。
   */
  rate: z.coerce.number().int().min(0).max(100_000).optional(),
  /** 强制跳过缓存重新拉取（价格表更新后手动刷新）。 */
  refresh: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1')
    .optional(),
});

/**
 * 公开价格目录的进程内缓存。
 *
 * 为什么缓存在内存而不是 state：目录是 3 MB / 4430 条、一天最多变几次的只读
 * 参考数据，落 state 只会给 Redis 塞一个没人会按 key 读的巨型 value。多副本
 * 各自缓存一份、各自 12 小时刷一次，代价远小于共享它。
 */
let catalogCache: { snapshot: CatalogSnapshot; expiresAt: number } | null = null;

async function loadCatalog(rate: number, refresh: boolean): Promise<CatalogSnapshot> {
  const now = Date.now();
  // 汇率变了就必须重算，否则「试算 7.2」会拿到 7.0 换算的旧数。
  if (
    !refresh &&
    catalogCache &&
    catalogCache.expiresAt > now &&
    catalogCache.snapshot.rate === rate
  ) {
    return catalogCache.snapshot;
  }
  const snapshot = await fetchCatalog(rate);
  catalogCache = { snapshot, expiresAt: now + CATALOG_TTL_MS };
  return snapshot;
}

/** 表达式定价的写入校验：模式是 expr 时必须给出可编译的表达式。 */
function assertExprPrice(input: {
  strategy?: string | undefined;
  expr?: string | undefined;
}): void {
  if (input.strategy !== 'expr') return;
  const source = (input.expr ?? '').trim();
  if (!source) throw new GatewayError(400, '表达式定价必须提供 expr');
  const compiled = compileExpr(source);
  if (!compiled.ok) throw new GatewayError(400, `表达式无效：${compiled.error}`);
}

/**
 * 时段价的写入校验：宁可写不进去，也不要等首笔请求才发现窗口格式错。
 * 时段算错一小时就是算错钱，所以这里用与运行时同一套解析函数。
 */
function assertPriceWindows(input: { windows?: PriceWindowInput[] | undefined }): void {
  if (!input.windows || input.windows.length === 0) return;
  const error = validatePriceWindows(
    input.windows.map((window) => ({
      timezone: window.timezone,
      weekdays: window.weekdays,
      hours: window.hours,
      percent: window.percent,
      inputPrice: window.inputPrice,
      outputPrice: window.outputPrice,
      cacheReadPrice: window.cacheReadPrice,
      cacheWritePrice: window.cacheWritePrice,
      reasoningPrice: window.reasoningPrice,
      costInputPrice: window.costInputPrice,
      costOutputPrice: window.costOutputPrice,
      costCacheReadPrice: window.costCacheReadPrice,
      costCacheWritePrice: window.costCacheWritePrice,
    })),
  );
  if (error) throw new GatewayError(400, error);
}

type PriceWindowInput = NonNullable<z.infer<typeof priceSchema>['windows']>[number];

const accountKeySchema = z.object({
  label: optionalString(64),
  apiKey: z.string().min(1).max(500),
  weight: optionalInt(1, 100_000),
});

const accountKeyParamsSchema = z.object({
  id: z.string().min(1).max(191),
  keyId: z.string().min(1).max(191),
});

/** 单账号 key 数量上限（主 key + 额外 key）。 */
const MAX_ACCOUNT_KEYS = 20;

const optionalModelSchema = z.object({
  keyId: optionalString(191),
  model: optionalString(191),
});

const usageLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  userId: optionalString(191),
  apiKeyId: optionalString(191),
  accountId: optionalString(191),
  model: optionalString(191),
  status: optionalString(32),
  /** 回溯天数（1–90）；默认 1 天。 */
  days: z.coerce.number().int().min(1).max(90).optional(),
});

const idSchema = z.object({ id: z.string().min(1).max(191) });

/** 模型映射规则（B4）。正则写入时就编译一次，别等请求来了才发现写错。 */
const modelMapSchema = z.object({
  from: z.string().min(1).max(191),
  mode: z.enum(['exact', 'prefix', 'regex']),
  targets: z
    .array(
      z.object({
        model: z.string().min(1).max(191),
        weight: optionalInt(1, 100_000),
      }),
    )
    .min(1)
    .max(20),
  priority: optionalInt(-1_000_000, 1_000_000),
  enabled: z.preprocess(blankToUndefined, z.boolean().optional()),
  note: z.string().max(500).optional(),
});

const modelMapUpdateSchema = modelMapSchema.partial();

/** 预算限额（B3）：`userId` 留空即全局默认。 */
const budgetLimitSchema = z.object({
  userId: z.string().max(191).optional(),
  period: z.enum(['day', 'month']),
  amountLimit: z.coerce.number().int().min(0).max(2_000_000_000),
  warnPercent: optionalInt(1, 100),
  action: z.enum(['warn', 'block']),
  enabled: z.preprocess(blankToUndefined, z.boolean().optional()),
});

const budgetLimitUpdateSchema = budgetLimitSchema.partial();

/** 套餐权益（B1）：管理员手工发放（商店履约走 productType provider，不经过这里）。 */
const entitlementCreateSchema = z.object({
  userId: z.string().min(1).max(191),
  name: z.string().max(191).optional(),
  /** 总额度（minor）；0 = 不限量。 */
  quotaAmount: z.coerce.number().int().min(0).max(2_000_000_000),
  /** 覆盖模型；空 = 全部。 */
  models: z.array(z.string().min(1).max(191)).max(200).optional(),
  /** 有效期（天）；不传且 expiresAt 也未给 = 永久。 */
  validityDays: optionalInt(1, 3650),
  startsAt: z.string().max(64).optional(),
  expiresAt: z.string().max(64).nullable().optional(),
  priority: optionalInt(-1_000_000, 1_000_000),
});

/** 对账单查询（B5）：`month=YYYY-MM`，缺省为当前月。 */
const taskSubmitSchema = z.object({
  descriptorId: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  params: z
    .record(z.string(), z.union([z.string().max(4_000), z.number(), z.boolean()]))
    .optional(),
});

const artifactQuerySchema = z.object({
  expires: z.coerce.number().int().positive(),
  sig: z.string().min(16).max(128),
});

const statementQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM')
    .optional(),
});

const billingSchema = z.object({ enabled: z.boolean() });

/** 平台级网关配置（全部可选，PATCH 语义）。 */
const playgroundSchema = z.object({
  model: z.string().trim().min(1).max(120),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().max(32_000),
      }),
    )
    .min(1)
    .max(50),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
});

const configUpdateSchema = z.object({
  globalConcurrency: optionalInt(0, 1_000_000),
  userRpm: optionalInt(0, 1_000_000),
  modelRpm: optionalInt(0, 1_000_000),
  providerRpm: optionalInt(0, 1_000_000),
  retryAttempts: optionalInt(1, 20),
  maxResponseBytes: optionalInt(1_024, 1_073_741_824),
  holdTtlMs: optionalInt(1_000, 86_400_000),
  /** 自动摘号（A7）：关键词 / 状态码 / 冷却时长。 */
  autoDisableKeywords: z.array(z.string().min(1).max(128)).max(50).optional(),
  autoDisableStatusCodes: z.array(z.coerce.number().int().min(400).max(599)).max(20).optional(),
  autoDisableCooldownMs: optionalInt(1_000, 86_400_000),
  /** 预算限额默认周期（B3）。 */
  budgetPeriod: z.enum(['day', 'month']).optional(),
  /** 敏感词（D2）：超长/超量由 normalizeWordlist 截断，不整份拒绝。 */
  sensitiveWords: z.array(z.string()).max(1000).optional(),
  sensitiveWordAction: z.enum(['block', 'log']).optional(),
  /**
   * 公开价格表换算汇率（1 USD = ? minor）；只影响参考价展示，不影响计费。
   * 0 = 关闭参考价功能（不再从公开表格取数）。
   */
  usdRateMinor: optionalInt(0, 100_000),
});

/** 管理端指标面板展示的指标集合（与 `observability.MetricName` 对应）。 */
const METRIC_NAMES: readonly MetricName[] = [
  'request.total',
  'request.error',
  'request.retry',
  'request.client_abort',
  'upstream.error',
  'upstream.429',
  'upstream.5xx',
  'upstream.timeout',
  'breaker.open',
  'account.failover',
  'billing.settle_failed',
  'billing.compensation_settled',
  'billing.compensation_failed',
  'stream.total',
  'stream.lease_lost',
  'stream.slow_client',
];

/** 基准价 × 倍率（百分数）→ 实际单价（minor / 百万 token）。 */
function scale(base: number, multiplier: number): number {
  return Math.round((base * (multiplier > 0 ? multiplier : 100)) / 100);
}

/** 统一收集可售模型：所有启用账号的模型 ∪ 启用定价的模型（去掉兜底 `*`）。 */
async function listGatewayModels(headers: unknown): Promise<string[]> {
  // 若携带网关 key，则按其白名单过滤（空 = 全部）。
  let allowed: string[] = [];
  const authHeader =
    headers && typeof headers === 'object'
      ? (headers as Record<string, unknown>)['authorization']
      : undefined;
  const token =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;
  if (token) {
    const inspection = await auth()
      .inspectPlatformToken(token)
      .catch(() => null);
    if (inspection) {
      const policy = await getPolicy(inspection.token.id);
      allowed = toStringArray(policy?.models);
    }
  }
  const [accounts, prices] = await Promise.all([listActiveAccounts(), listEnabledPrices()]);
  // 对外可售模型 = 已启用的定价行（去掉兜底 `*`）。用户调用与展示都用这个自定义名，
  // 实际转发到哪个上游模型由定价行的 `upstreamModel` 决定。
  // 尚未配置任何定价时，退回「上游账号的模型名」以保证可发现（旧行为）。
  const ids = new Set<string>();
  for (const price of prices) if (price.model !== '*') ids.add(price.model);
  if (ids.size === 0) {
    for (const account of accounts) {
      for (const model of toStringArray(account.models)) ids.add(model);
    }
  }

  const list = allowed.length > 0 ? [...ids].filter((id) => allowed.includes(id)) : [...ids];
  return list.sort();
}

/** 取当前登录用户 id（`auth: 'user'` 路由一定存在；取不到视为未登录）。 */
function requireUser(req: HttpRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new GatewayError(401, '需要登录');
  return userId;
}

/** 两类请求（普通路由对象 / raw 路由 URLSearchParams）统一的查询参数读取。 */
function queryValue(req: { query: unknown }, key: string): string {
  const query = req.query as { get?: (name: string) => string | null } & Record<string, unknown>;
  if (typeof query?.get === 'function') return query.get(key) ?? '';
  const value = query?.[key];
  return typeof value === 'string' ? value : '';
}

/** 两类请求统一的请求头读取。 */
function headerValue(req: { headers: unknown }, key: string): string | null {
  const headers = req.headers as { get?: (name: string) => string | null } | undefined;
  if (headers && typeof headers.get === 'function') return headers.get(key);
  const record = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const value = record[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * 任务对外视图：**不**暴露 accountId / requestSpec（含客户端 IP）等内部字段。
 * 产物只给签名链接，不给上游原始 URL。
 */
function taskView(
  task: {
    id: string;
    kind: string;
    endpoint: string;
    model?: string | null;
    status: string;
    upstreamStatus?: string | null;
    attempts?: number | null;
    error?: string | null;
    createdAt: string;
  },
  links: ReadonlyArray<{ index: number; url: string; expiresAt: number }>,
): Record<string, unknown> {
  return {
    id: task.id,
    kind: task.kind,
    descriptorId: task.endpoint,
    model: task.model ?? '',
    status: task.status,
    upstreamStatus: task.upstreamStatus ?? '',
    attempts: task.attempts ?? 0,
    error: task.error ?? null,
    createdAt: task.createdAt,
    artifacts: links.map((link) => ({
      index: link.index,
      url: link.url,
      expiresAt: link.expiresAt,
    })),
  };
}

/** 统一的 handler 错误包装。 */
/**
 * 管理端操作的审计（D2）。
 *
 * 走内核 `auth.audit`（append-only 的 `audit_logs`），不另建表：改配置、改账号、
 * 改价目这类操作必须和内核其它管理动作落在同一条时间线上，否则排障时要看两处。
 *
 * **永不抛错**：审计失败不能把已经成功的业务动作变成 500。
 */
async function auditAdmin(
  req: HttpRequest,
  action: string,
  resource: string,
  resourceId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  await rt.auth
    .audit({
      action,
      resource,
      resourceId,
      ...(req.user ? { actorId: req.user.id } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(meta ? { meta } : {}),
    })
    .catch(() => undefined);
}

/* -------------------- OpenAI Videos 兼容面（/v1/videos） -------------------- */

/** 视频提交只需要 prompt/参数，给 256 KiB 足够；不让它变成第二个上传通道。 */
const VIDEO_BODY_LIMIT = 256 * 1024;

/** OpenAI 风格错误体（客户端 SDK 靠 `error.message` 与 `error.code`）。 */
function videoError(reply: RawHttpReply, status: number, code: string, message: string): void {
  reply.status(status);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(
    JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code } }),
  );
}

function jsonReply(reply: RawHttpReply, status: number, body: unknown): void {
  reply.status(status);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(JSON.stringify(body));
}

/** 兼容面同样只认网关 key（平台凭证），与 relay 用同一套校验。 */
async function videoKey(rt: GatewayRuntime, req: RawHttpRequest): Promise<GatewayKey> {
  const plaintext = extractApiKey(req.headers) ?? req.query.get('key')?.trim() ?? null;
  req.query.delete('key');
  if (!plaintext) throw new HttpGatewayError(401, 'invalid_api_key', '缺少 API key');
  const resolved = await resolveGatewayKey(rt, plaintext, req.ip);
  if (!resolved.ok) throw new HttpGatewayError(resolved.status, resolved.code, resolved.message);
  return resolved.key;
}

/**
 * raw 路由没有「抛错→JSON」的中间件，所以统一在这里把 `GatewayError` 翻成
 * OpenAI 错误体；未知异常只记日志并回固定文案，不外泄内部细节。
 */
function videoRoute(
  handler: (rt: GatewayRuntime, req: RawHttpRequest, reply: RawHttpReply) => Promise<void>,
) {
  return async (req: RawHttpRequest, reply: RawHttpReply): Promise<void> => {
    const rt = getRuntime();
    try {
      await handler(rt, req, reply);
    } catch (error) {
      if (error instanceof HttpGatewayError) {
        videoError(reply, error.status, error.code, error.message);
        return;
      }
      if (error instanceof GatewayError) {
        videoError(reply, error.status, error.code, error.message);
        return;
      }
      rt.logger.warn(
        `llm-gateway: /v1/videos 处理异常: ${error instanceof Error ? error.message : String(error)}`,
      );
      videoError(reply, 500, 'internal_error', '网关内部错误');
    }
  };
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof GatewayError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      // 转发层（relay/playground/tasks）抛的是 `errors.ts` 的版本：它带稳定的
      // machine code 与 type。两套都在这里收口，否则上游错误会被 kernel 当成
      // 未知异常、统一变成 500。
      if (error instanceof HttpGatewayError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/* --------------------------------- 插件 --------------------------------- */

/* ------------------------------ 对账单（B5） ------------------------------ */

/** 月份区间（UTC）：`YYYY-MM`，缺省当前月。 */
function monthRange(month?: string | undefined): { label: string; since: Date; until: Date } {
  const label = month ?? new Date().toISOString().slice(0, 7);
  const since = new Date(`${label}-01T00:00:00.000Z`);
  const until = new Date(since);
  until.setUTCMonth(until.getUTCMonth() + 1);
  return { label, since, until };
}

interface StatementBucket {
  requests: number;
  tokens: number;
  amount: number;
  cost: number;
  entitlementAmount: number;
}

function emptyBucket(): StatementBucket {
  return { requests: 0, tokens: 0, amount: 0, cost: 0, entitlementAmount: 0 };
}

function addToBucket(bucket: StatementBucket, row: UsageLogRow): void {
  bucket.requests += 1;
  bucket.tokens += row.totalTokens ?? 0;
  bucket.amount += row.amount ?? 0;
  bucket.cost += row.costAmount ?? 0;
  bucket.entitlementAmount += row.entitlementAmount ?? 0;
}

/**
 * 把一个月内的流水聚合成对账单。
 *
 * 只做「加总 + 分组」，不重新计价：金额一律取当时写进流水的快照
 * （`amount` / `costAmount` / `discountPercent`），否则改价会篡改历史账单。
 */
function aggregateStatement(rows: readonly UsageLogRow[]): {
  total: StatementBucket;
  byModel: Array<{ model: string } & StatementBucket>;
  byUser: Array<{ userId: string } & StatementBucket>;
} {
  const total = emptyBucket();
  const byModel = new Map<string, StatementBucket>();
  const byUser = new Map<string, StatementBucket>();
  for (const row of rows) {
    addToBucket(total, row);
    const model = row.model || 'unknown';
    const modelBucket = byModel.get(model) ?? emptyBucket();
    addToBucket(modelBucket, row);
    byModel.set(model, modelBucket);
    const userBucket = byUser.get(row.userId) ?? emptyBucket();
    addToBucket(userBucket, row);
    byUser.set(row.userId, userBucket);
  }
  const sortBy = (a: StatementBucket, b: StatementBucket): number => b.amount - a.amount;
  return {
    total,
    byModel: [...byModel.entries()].map(([model, bucket]) => ({ model, ...bucket })).sort(sortBy),
    byUser: [...byUser.entries()].map(([userId, bucket]) => ({ userId, ...bucket })).sort(sortBy),
  };
}

function statementCsv(rows: readonly UsageLogRow[]): string {
  const header = [
    'id',
    'createdAt',
    'userId',
    'model',
    'upstreamModel',
    'endpoint',
    'totalTokens',
    'amount',
    'entitlementAmount',
    'costAmount',
    'discountPercent',
    'status',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.createdAt,
        row.userId,
        row.model,
        row.upstreamModel ?? '',
        row.endpoint,
        row.totalTokens,
        row.amount,
        row.entitlementAmount ?? 0,
        row.costAmount ?? 0,
        row.discountPercent ?? 0,
        row.status,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

export const llmGatewayPlugin = definePlugin({
  manifest: {
    id: 'llm-gateway',
    name: '模型服务',
    version: '0.4.0',
    description:
      'OpenAI 兼容模型服务：用户级 API 计费开关、可建多把 key、统一入口调用所有模型、按 token 预授权冻结用量后结算。',
    // ADR-0021: the `gateway` refined-scope resource is declared here, by the
    // plugin that owns the permission — the kernel no longer hardcodes
    // `llm-gateway.use/admin`. Holding either permission governs `gateway:read|write`.
    permissions: [
      { key: 'llm-gateway.use', scope: 'gateway' },
      { key: 'llm-gateway.admin', scope: 'gateway' },
    ],
    roleTemplates: [
      { role: 'USER', permissions: ['llm-gateway.use'] },
      { role: 'ADMIN', permissions: ['llm-gateway.admin'] },
    ],
    // Open-platform surface (P1 slice four). Every entry mirrors one internal
    // route below and dispatches to the *same* handler; the refined
    // `gateway:read|write` scope narrows the coarse `llm-gateway.use` gate —
    // a read token can never perform a write. Read vs write is the whole point.
    capabilities: [
      {
        id: 'gateway.billing.read',
        method: 'GET',
        route: '/llm-gateway/billing',
        path: '/api/v1/gateway/billing',
        summary: "The caller's API billing status",
        scope: 'gateway:read',
      },
      {
        id: 'gateway.billing.write',
        method: 'POST',
        route: '/llm-gateway/billing',
        path: '/api/v1/gateway/billing',
        summary: "Toggle the caller's API billing switch",
        mutating: true,
        scope: 'gateway:write',
      },
      {
        id: 'gateway.prices.read',
        method: 'GET',
        route: '/llm-gateway/prices',
        path: '/api/v1/gateway/prices',
        summary: 'Model pricing visible to the caller',
        scope: 'gateway:read',
      },
      {
        id: 'gateway.models.read',
        method: 'GET',
        route: '/llm-gateway/models',
        path: '/api/v1/gateway/models',
        summary: 'Models available to the caller',
        scope: 'gateway:read',
      },
      {
        id: 'gateway.usage.read',
        method: 'GET',
        route: '/llm-gateway/usage',
        path: '/api/v1/gateway/usage',
        summary: "The caller's API usage",
        scope: 'gateway:read',
      },
      {
        id: 'gateway.keys.read',
        method: 'GET',
        route: '/llm-gateway/keys',
        path: '/api/v1/gateway/keys',
        summary: "The caller's gateway keys",
        scope: 'gateway:read',
      },
      {
        id: 'gateway.keys.create',
        method: 'POST',
        route: '/llm-gateway/keys',
        path: '/api/v1/gateway/keys',
        summary: 'Create a gateway key',
        mutating: true,
        scope: 'gateway:write',
      },
      {
        id: 'gateway.keys.update',
        method: 'PATCH',
        route: '/llm-gateway/keys/:id',
        path: '/api/v1/gateway/keys/:id',
        summary: 'Update a gateway key',
        mutating: true,
        scope: 'gateway:write',
      },
      {
        id: 'gateway.keys.delete',
        method: 'DELETE',
        route: '/llm-gateway/keys/:id',
        path: '/api/v1/gateway/keys/:id',
        summary: 'Delete a gateway key',
        mutating: true,
        scope: 'gateway:write',
      },
    ],
  },

  customModels: [
    gatewayAgentCallModel,
    gatewayAccountModel,
    gatewayKeyPolicyModel,
    gatewayUserSettingModel,
    gatewayUsageLogModel,
    gatewayModelPriceModel,
    gatewayLegacyKeyModel,
    gatewayConfigModel,
    gatewayBillingEntryModel,
    gatewayTaskModel,
    // B 阶段（0.3.0）：套餐权益、模型映射、预算限额。
    gatewayEntitlementModel,
    gatewayModelMapModel,
    gatewayBudgetLimitModel,
  ],

  routes: [
    {
      method: 'GET',
      path: '/llm-gateway/admin/agent-provider',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: async () => agentProviderConfig(),
    },
    {
      method: 'PUT',
      path: '/llm-gateway/admin/agent-provider',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: configureAgentProvider,
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/agent-provider',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: async () => clearAgentProvider(),
    },
    {
      /**
       * 产物下载（C2）：签名链接是唯一凭据。
       *
       * `auth: 'optional'` 是刻意的：视频要能被 `<video src>` 直接播放，而浏览器
       * 不会在 `<video>` 上带 Authorization。签名里已绑定 taskId + index + 过期时间。
       */
      method: 'GET',
      path: '/llm-gateway/artifacts/:id/:index',
      kind: 'raw',
      auth: 'optional',
      handler: async (req, reply) => {
        const parsed = artifactQuerySchema.safeParse({
          expires: queryValue(req, 'expires'),
          sig: queryValue(req, 'sig'),
        });
        const index = Number(req.params.index);
        if (!parsed.success || !Number.isInteger(index) || index < 0) {
          reply.status(400);
          reply.header('content-type', 'application/json; charset=utf-8');
          reply.end(JSON.stringify({ error: { code: 'invalid_request', message: '链接无效' } }));
          return;
        }
        await serveArtifact(getRuntime(), reply, {
          taskId: String(req.params.id),
          index,
          expiresAt: parsed.data.expires,
          signature: parsed.data.sig,
          range: headerValue(req, 'range'),
        });
      },
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/playground',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const parsed = playgroundSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const result = await runPlayground(getRuntime(), {
          model: parsed.data.model,
          messages: parsed.data.messages,
          temperature: parsed.data.temperature,
          maxTokens: parsed.data.maxTokens,
        });
        return { result };
      }),
    },

    /* ------------------------ OpenAI Videos 兼容面（/v1/videos） ------------------------ */
    {
      path: '/llm-gateway/v1/videos',
      kind: 'raw',
      method: 'POST',
      auth: 'public',
      handler: videoRoute(async (rt, req, reply) => {
        const key = await videoKey(rt, req);
        const rawBody = await readStream(req.body, VIDEO_BODY_LIMIT);
        let body: unknown = {};
        if (rawBody.byteLength > 0) {
          try {
            body = JSON.parse(Buffer.from(rawBody).toString('utf8'));
          } catch {
            throw new HttpGatewayError(400, 'invalid_json', '请求体不是合法 JSON');
          }
        }
        const parsed = createVideoBodySchema.safeParse(body);
        if (!parsed.success) throw new HttpGatewayError(400, 'invalid_request', '参数无效');
        const descriptorId = descriptorIdForVideoModel(parsed.data.model);
        if (!descriptorId) throw new HttpGatewayError(400, 'unsupported_model', '不支持的视频模型');
        if (key.models.length > 0 && !key.models.includes(parsed.data.model)) {
          throw new HttpGatewayError(403, 'model_not_allowed', '模型不在该 key 的允许范围内');
        }
        const task = await submitTask(rt, {
          userId: key.userId,
          apiKeyId: key.id,
          descriptorId,
          model: parsed.data.model,
          params: videoTaskParams(parsed.data, descriptorId),
          currency: 'CNY',
          clientIp: req.ip ?? null,
        });
        jsonReply(reply, 200, toOpenAIVideoObject(task));
      }),
    },
    {
      path: '/llm-gateway/v1/videos',
      kind: 'raw',
      method: 'GET',
      auth: 'public',
      handler: videoRoute(async (rt, req, reply) => {
        const key = await videoKey(rt, req);
        const limit = clampVideoLimit(req.query.get('limit'));
        const rows = await listUserTasks(key.userId, limit);
        jsonReply(reply, 200, {
          object: 'list',
          data: rows.map((row) => toOpenAIVideoObject(row)),
        });
      }),
    },
    {
      path: '/llm-gateway/v1/videos/:id',
      kind: 'raw',
      method: 'GET',
      auth: 'public',
      handler: videoRoute(async (rt, req, reply) => {
        const key = await videoKey(rt, req);
        const task = await requireTask(String(req.params['id'] ?? ''), key.userId);
        jsonReply(reply, 200, toOpenAIVideoObject(task));
      }),
    },
    {
      path: '/llm-gateway/v1/videos/:id/content',
      kind: 'raw',
      method: 'GET',
      auth: 'public',
      handler: videoRoute(async (rt, req, reply) => {
        const key = await videoKey(rt, req);
        const task = await requireTask(String(req.params['id'] ?? ''), key.userId);
        // 未完成的任务没有产物：给 409，客户端的轮询逻辑据此继续等，而不是当成失败。
        if (task.status !== 'SUCCEEDED') {
          throw new HttpGatewayError(409, 'video_not_ready', '视频尚未生成完成');
        }
        // 这里用 key 鉴权（没有签名），所以复用同一段下载实现、但跳过验签。
        await streamArtifactBytes(rt, reply, {
          task,
          index: 0,
          range: headerValue(req, 'range'),
        });
      }),
    },
    {
      path: '/llm-gateway/v1/videos/:id',
      kind: 'raw',
      method: 'DELETE',
      auth: 'public',
      handler: videoRoute(async (rt, req, reply) => {
        const key = await videoKey(rt, req);
        const task = await requireTask(String(req.params['id'] ?? ''), key.userId);
        // 语义是「取消」而不是抹除：台账行要留着对账，已结算的不会退钱。
        const cancelled = await cancelTask(rt, task, key.userId);
        jsonReply(reply, 200, toOpenAIVideoObject(cancelled));
      }),
    },

    /* ------------------------------ 透传路由 ------------------------------ */
    {
      kind: 'raw',
      method: 'POST',
      path: '/llm-gateway/*',
      auth: 'public',
      handler: createRelayHandler(getRuntime),
    },
    // 内核 dispatcher 按精确 method 匹配，GET/DELETE 的 endpoint
    // （GET /v1/models、GET /v1/files、DELETE /v1/files/:id、GET /v1/batches/:id、
    // GET /v1/fine_tuning/jobs/:id）必须各自登记，否则到不了 relay。
    {
      kind: 'raw',
      method: 'GET',
      path: '/llm-gateway/*',
      auth: 'public',
      handler: createRelayHandler(getRuntime),
    },
    {
      kind: 'raw',
      method: 'DELETE',
      path: '/llm-gateway/*',
      auth: 'public',
      handler: createRelayHandler(getRuntime),
    },

    /* ------------------------------ 计费开关 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/billing',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = req.user?.id ?? '';
        const [setting, walletAccount] = await Promise.all([
          getSetting(userId),
          wallet()
            .getAccount(userId)
            .catch(() => null),
        ]);
        return {
          enabled: setting?.billingEnabled ?? false,
          balance: walletAccount?.balance ?? 0,
          currency: walletAccount?.currency ?? 'CNY',
        };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/billing',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const parsed = billingSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const userId = req.user?.id;
        if (!userId) throw new GatewayError(401, '未登录');
        const setting = await setSetting(userId, parsed.data.enabled);
        return { enabled: setting.billingEnabled };
      }),
    },

    /* ------------------------------ 模型定价（用户） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/prices',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = req.user?.id ?? '';
        const [prices, walletAccount] = await Promise.all([
          listEnabledPrices().then((rows) => rows.sort((a, b) => a.model.localeCompare(b.model))),
          wallet()
            .getAccount(userId)
            .catch(() => null),
        ]);
        return {
          currency: walletAccount?.currency ?? 'CNY',
          unitTokens: 1_000_000,
          prices: prices.map((price) => ({
            model: price.model,
            multiplier: price.multiplier,
            capabilities: toStringArray(price.capabilities),
            // 实际单价 = 基准价 × 倍率（minor / 百万 token）。
            inputPrice: scale(price.inputPrice, price.multiplier),
            outputPrice: scale(price.outputPrice, price.multiplier),
            cacheReadPrice: scale(price.cacheReadPrice || price.inputPrice, price.multiplier),
            cacheWritePrice: scale(price.cacheWritePrice || price.inputPrice, price.multiplier),
          })),
        };
      }),
    },

    /* ------------------------------ 模型发现 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/v1/models',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        // 允许携带网关 key（Bearer）或登录会话；普通路由鉴权走会话，这里额外兼容 key。
        const models = await listGatewayModels(req.headers);
        const created = Math.floor(Date.now() / 1000);
        return {
          object: 'list',
          data: models.map((id) => ({
            id,
            object: 'model',
            created,
            owned_by: 'stackpanel',
          })),
        };
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/models',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const models = await listGatewayModels(req.headers);
        const created = Math.floor(Date.now() / 1000);
        return {
          object: 'list',
          data: models.map((id) => ({
            id,
            object: 'model',
            created,
            owned_by: 'stackpanel',
          })),
        };
      }),
    },

    /* ------------------------------ 用户密钥 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/keys',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = req.user?.id ?? '';
        // 网关密钥 = 持有 llm-gateway.use scope 的平台凭证；策略在 key-policy。
        const tokens = (await auth().listPlatformTokens(userId)).filter((token) =>
          token.scopes.includes(GATEWAY_SCOPE),
        );
        const policies = await listPoliciesByTokens(tokens.map((token) => token.id));
        const policyById = new Map(policies.map((policy) => [policy.apiTokenId, policy]));
        const revealKey = `gw:reveal:${userId}`;
        const revealedKey = await state()
          .get(revealKey)
          .catch(() => null);
        if (revealedKey)
          await state()
            .del(revealKey)
            .catch(() => undefined);
        return {
          revealedKey,
          keys: tokens.map((token) => {
            const policy = policyById.get(token.id);
            return {
              id: token.id,
              name: token.name,
              keyPrefix: token.keyPrefix,
              status: token.status,
              models: toStringArray(policy?.models),
              rpmLimit: policy?.rpmLimit ?? 0,
              concurrencyLimit: policy?.concurrencyLimit ?? 0,
              quotaLimit: policy?.quotaLimit ?? null,
              quotaUsed: policy?.quotaUsed ?? 0,
              quotaWindowHours: policy?.quotaWindowHours ?? 0,
              quotaMaxRequests: policy?.quotaMaxRequests ?? 0,
              quotaMaxTokens: policy?.quotaMaxTokens ?? 0,
              expiresAt: token.expiresAt,
              lastUsedAt: token.lastUsedAt,
              createdAt: token.createdAt,
            };
          }),
        };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/keys',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const parsed = createKeySchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const userId = req.user?.id;
        if (!userId) throw new GatewayError(401, '未登录');
        const existing = (await auth().listPlatformTokens(userId)).length;
        if (existing >= 50) throw new GatewayError(400, '密钥数量已达上限（50）');
        // 凭证写内核 ApiToken（含 scope），业务策略写 key-policy。
        const created = await auth().createPlatformToken({
          userId,
          name: parsed.data.name,
          scopes: [GATEWAY_SCOPE],
          expiresAt: parsed.data.expiresInDays
            ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
            : null,
        });
        await upsertPolicy(created.token.id, {
          models: parsed.data.models ?? [],
          rpmLimit: parsed.data.rpmLimit ?? 0,
          concurrencyLimit: parsed.data.concurrencyLimit ?? 0,
          quotaLimit: parsed.data.quotaLimit ?? null,
          quotaWindowHours: parsed.data.quotaWindowHours ?? 0,
          quotaMaxRequests: parsed.data.quotaMaxRequests ?? 0,
          quotaMaxTokens: parsed.data.quotaMaxTokens ?? 0,
        });
        await state()
          .set(`gw:reveal:${userId}`, created.plaintext, 5 * 60 * 1000)
          .catch(() => undefined);
        return reply.code(201).send({
          key: {
            id: created.token.id,
            name: created.token.name,
            keyPrefix: created.token.keyPrefix,
          },
          plaintext: created.plaintext,
        });
      }),
    },
    {
      method: 'PATCH',
      path: '/llm-gateway/keys/:id',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        const body = updateKeySchema.safeParse(req.body);
        if (!params.success || !body.success) throw new GatewayError(400, '参数无效');
        const userId = req.user?.id ?? '';
        const token = (await auth().listPlatformTokens(userId)).find(
          (item) => item.id === params.data.id && item.scopes.includes(GATEWAY_SCOPE),
        );
        if (!token) throw new GatewayError(404, '密钥不存在');
        const {
          name,
          status,
          models,
          rpmLimit,
          concurrencyLimit,
          quotaLimit,
          quotaWindowHours,
          quotaMaxRequests,
          quotaMaxTokens,
        } = body.data;
        const tokenPatch = defined({ name, status });
        if (Object.keys(tokenPatch).length > 0) {
          await auth().updatePlatformToken(token.id, tokenPatch);
        }
        const policyPatch = defined({
          models,
          rpmLimit,
          concurrencyLimit,
          quotaLimit,
          quotaWindowHours,
          quotaMaxRequests,
          quotaMaxTokens,
        });
        if (Object.keys(policyPatch).length > 0) {
          await upsertPolicy(token.id, policyPatch);
        }
        const updated =
          status !== undefined
            ? { name: name ?? token.name, status }
            : { name: name ?? token.name, status: token.status };
        const policy = await getPolicy(token.id);
        return {
          key: {
            id: token.id,
            name: updated.name,
            status: updated.status,
            models: toStringArray(policy?.models),
          },
        };
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/keys/:id',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const userId = req.user?.id ?? '';
        const token = (await auth().listPlatformTokens(userId)).find(
          (item) => item.id === params.data.id && item.scopes.includes(GATEWAY_SCOPE),
        );
        if (!token) throw new GatewayError(404, '密钥不存在');
        await removePolicy(token.id);
        await auth().deletePlatformToken(token.id);
        return reply.code(204).send();
      }),
    },

    /* ------------------------------ 用户用量 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/usage',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = req.user?.id ?? '';
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const startOfWeek = new Date();
        startOfWeek.setHours(0, 0, 0, 0);
        startOfWeek.setDate(startOfWeek.getDate() - 6);
        const since30 = daysAgo(30);
        const [logs, todayLogs, weekLogs, monthLogs] = await Promise.all([
          listRecentLogs(userId, 100),
          // 今日逐小时（本地时区）。
          listUserLogsSince(userId, startOfToday),
          // 近 7 天逐日。
          listUserLogsSince(userId, startOfWeek),
          // 近 30 天逐日。
          listUserLogsSince(userId, since30),
        ]);

        const dayKey = (date: Date): string => `${date.getMonth() + 1}/${date.getDate()}`;

        const bucketBy = (
          rows: Array<{
            amount: number;
            totalTokens: number;
            createdAt: string | Date;
          }>,
          keys: string[],
          keyOf: (date: Date) => string,
          labelOf: (key: string, index: number) => string,
        ) => {
          const index = new Map(keys.map((key, i) => [key, i]));
          const points = keys.map((key, i) => ({
            label: labelOf(key, i),
            amount: 0,
            tokens: 0,
          }));
          for (const row of rows) {
            const target = points[index.get(keyOf(new Date(row.createdAt))) ?? -1];
            if (!target) continue;
            target.amount += row.amount;
            target.tokens += row.totalTokens;
          }
          return points;
        };

        // 今日：24 个小时桶。
        const hourKeys = Array.from({ length: 24 }, (_, i) => String(i));
        const todaySeries = bucketBy(
          todayLogs,
          hourKeys,
          (d) => String(d.getHours()),
          (k) => `${k}:00`,
        );

        // 近 7 / 30 天：逐日桶（含无消费的空白日）。
        const dayKeys = (days: number) => {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          start.setDate(start.getDate() - (days - 1));
          return Array.from({ length: days }, (_, i) => {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            return dayKey(d);
          });
        };
        const weekSeries = bucketBy(
          weekLogs,
          dayKeys(7),
          (d) => dayKey(d),
          (k) => k,
        );
        const monthSeries = bucketBy(
          monthLogs,
          dayKeys(30),
          (d) => dayKey(d),
          (k) => k,
        );

        const summarize = (rows: Array<{ amount: number; totalTokens: number }>) =>
          rows.reduce<{
            requests: number;
            amount: number;
            totalTokens: number;
          }>(
            (acc, row) => {
              acc.amount += row.amount;
              acc.totalTokens += row.totalTokens;
              acc.requests += 1;
              return acc;
            },
            { requests: 0, amount: 0, totalTokens: 0 },
          );

        const modelBreakdown = (
          rows: Array<{ model: string; amount: number; totalTokens: number }>,
        ) => {
          const byModel = rows.reduce<
            Record<
              string,
              {
                model: string;
                amount: number;
                tokens: number;
                requests: number;
              }
            >
          >((acc, row) => {
            const entry = (acc[row.model] ??= {
              model: row.model,
              amount: 0,
              tokens: 0,
              requests: 0,
            });
            entry.amount += row.amount;
            entry.tokens += row.totalTokens;
            entry.requests += 1;
            return acc;
          }, {});
          return Object.values(byModel)
            .sort((a, b) => b.amount - a.amount || b.tokens - a.tokens)
            .slice(0, 20);
        };

        return {
          ranges: {
            today: {
              summary: summarize(todayLogs),
              series: todaySeries,
              byModel: modelBreakdown(todayLogs),
            },
            '7d': {
              summary: summarize(weekLogs),
              series: weekSeries,
              byModel: modelBreakdown(weekLogs),
            },
            '30d': {
              summary: summarize(monthLogs),
              series: monthSeries,
              byModel: modelBreakdown(monthLogs),
            },
          },
          logs: logs.map((log) => ({
            id: log.id,
            model: log.model,
            promptTokens: log.promptTokens,
            completionTokens: log.completionTokens,
            cacheReadTokens: log.cacheReadTokens,
            cacheWriteTokens: log.cacheWriteTokens,
            totalTokens: log.totalTokens,
            amount: log.amount,
            status: log.status,
            latencyMs: log.latencyMs,
            createdAt: log.createdAt,
          })),
        };
      }),
    },

    /* ------------------------------ 管理端账号池 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/accounts',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        const accounts = await listAllAccounts();
        return {
          accounts: accounts.map((account) => ({
            id: account.id,
            name: account.name,
            provider: account.provider,
            baseUrl: account.baseUrl,
            models: toStringArray(account.models),
            status: account.status,
            priority: account.priority,
            weight: account.weight,
            maxConcurrency: account.maxConcurrency,
            options: account.options ?? {},
            rewrites: account.rewrites ?? {},
            rpmLimit: account.rpmLimit,
            enabled: account.enabled,
            affinity: account.affinity,
            lastUsedAt: account.lastUsedAt,
            createdAt: account.createdAt,
            /** 额外 key 只回显元数据，永不回显 secret 引用之外的内容（A1）。 */
            keys: (account.keys ?? []).map((key) => ({
              id: key.id,
              label: key.label,
              weight: key.weight,
            })),
            keyCount: 1 + (account.keys ?? []).length,
            balance: account.balance ?? null,
            balanceCurrency: account.balanceCurrency ?? '',
            balanceUpdatedAt: account.balanceUpdatedAt ?? null,
            lastError: account.lastError ?? null,
            lastErrorAt: account.lastErrorAt ?? null,
          })),
        };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/accounts',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const parsed = accountSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const { apiKey, keys: extraKeys, rewrites: rawRewrites, ...rest } = parsed.data;
        // C4：改写配置在写入时校验（点路径/头名/状态码范围），非法直接 400，
        // 避免一份坏配置在运行期悄悄改坏所有请求。
        const rewrites = validateRewriteConfig(rawRewrites);
        if (!rewrites.ok) {
          throw new GatewayError(400, `改写配置无效：${rewrites.issues.join('；')}`);
        }
        // C3：自定义路由是「进程内配置」而非代码，但仍必须在写入时就完整合法——
        // 否则第一次真实请求才会 400，运维很难定位。
        if ((rest.provider ?? 'openai-chat') === 'custom') {
          const route = validateCustomRoute((rest.options ?? {})['route']);
          if (!route.ok) {
            throw new GatewayError(400, `自定义路由无效：${route.issues.join('；')}`);
          }
        }
        const id = newId();
        const apiKeyRef = `account.${id}`;
        await secrets().set(apiKeyRef, apiKey);
        // 额外 key（A1）：明文只在这里出现一次，落库的是 secrets 引用。
        const keys: Array<{ id: string; label: string; apiKeyRef: string; weight: number }> = [];
        for (const [index, key] of (extraKeys ?? []).entries()) {
          const keyId = newId();
          const ref = `account.${id}.key.${keyId}`;
          await secrets().set(ref, key.apiKey);
          keys.push({
            id: keyId,
            label: key.label ?? `key-${index + 1}`,
            apiKeyRef: ref,
            weight: key.weight ?? 100,
          });
        }
        const created = await createAccount({
          name: rest.name,
          provider: rest.provider ?? 'openai-chat',
          baseUrl: rest.baseUrl,
          apiKeyRef,
          models: rest.models ?? [],
          status: rest.status ?? 'ACTIVE',
          priority: rest.priority ?? 0,
          weight: rest.weight ?? 100,
          maxConcurrency: rest.maxConcurrency ?? 0,
          options: rest.options ?? {},
          rewrites: rewrites.config as unknown as Record<string, unknown>,
          rpmLimit: rest.rpmLimit ?? 0,
          enabled: rest.enabled ?? true,
          affinity: rest.affinity ?? '',
          lastUsedAt: null,
          keys,
          balance: null,
          balanceCurrency: '',
          balanceUpdatedAt: null,
          lastError: null,
          lastErrorAt: null,
        });
        await auditAdmin(req, 'llm-gateway.account.create', 'gateway-account', created.id, {
          provider: created.provider,
          baseUrl: created.baseUrl,
          models: created.models.length,
          keyCount: 1 + keys.length,
          rewritesEnabled:
            (created.rewrites as Record<string, unknown> | null)?.['enabled'] === true,
        });
        return reply.code(201).send({ account: { id: created.id, name: created.name } });
      }),
    },
    {
      method: 'PATCH',
      path: '/llm-gateway/admin/accounts/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        const body = accountUpdateSchema.safeParse(req.body);
        if (!params.success || !body.success) throw new GatewayError(400, '参数无效');
        const existing = await getAccount(params.data.id);
        if (!existing) throw new GatewayError(404, '账号不存在');
        const { apiKey, rewrites: rawRewrites, ...rest } = body.data;
        if (apiKey) await secrets().set(existing.apiKeyRef, apiKey);
        const patch: Partial<GatewayAccountData> = defined(rest);
        if (rawRewrites !== undefined) {
          const rewrites = validateRewriteConfig(rawRewrites);
          if (!rewrites.ok) {
            throw new GatewayError(400, `改写配置无效：${rewrites.issues.join('；')}`);
          }
          patch.rewrites = rewrites.config as unknown as Record<string, unknown>;
        }
        const nextProvider = patch.provider ?? existing.provider;
        if (nextProvider === 'custom') {
          const nextOptions = patch.options ?? existing.options ?? {};
          const route = validateCustomRoute(nextOptions['route']);
          if (!route.ok) {
            throw new GatewayError(400, `自定义路由无效：${route.issues.join('；')}`);
          }
        }
        const updated = await updateAccount(params.data.id, patch);
        if (!updated) throw new GatewayError(404, '账号不存在');
        await auditAdmin(req, 'llm-gateway.account.update', 'gateway-account', updated.id, {
          fields: Object.keys(patch),
          ...(apiKey ? { keyRotated: true } : {}),
        });
        return {
          account: {
            id: updated.id,
            name: updated.name,
            status: updated.status,
          },
        };
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/accounts/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const existing = await getAccount(params.data.id);
        if (!existing) throw new GatewayError(404, '账号不存在');
        // 主 key 与所有额外 key 的 secret 一并清理，不留悬空引用（A1）。
        for (const key of [
          existing.apiKeyRef,
          ...(existing.keys ?? []).map((item) => item.apiKeyRef),
        ]) {
          await secrets()
            .remove(key)
            .catch(() => null);
        }
        await removeAccount(params.data.id);
        await auditAdmin(req, 'llm-gateway.account.delete', 'gateway-account', params.data.id, {
          name: existing.name,
          provider: existing.provider,
        });
        return reply.code(204).send();
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/upstream-models',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const parsed = fetchModelsSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        let baseUrl = parsed.data.baseUrl;
        let apiKey = parsed.data.apiKey;
        let account: {
          baseUrl: string;
          provider: string;
          apiKeyRef: string;
        } | null = null;
        if (parsed.data.id) {
          const found = await getAccount(parsed.data.id);
          if (!found) throw new GatewayError(404, '账号不存在');
          account = found;
          baseUrl = baseUrl ?? found.baseUrl;
          apiKey =
            apiKey ??
            (await secrets()
              .get(found.apiKeyRef)
              .catch(() => null)) ??
            undefined;
        }
        if (!baseUrl || !apiKey) throw new GatewayError(400, '缺少 Base URL 或上游 API Key');
        const provider = parsed.data.provider ?? account?.provider ?? 'openai-chat';
        const request = upstreamModelsRequest(provider, baseUrl, apiKey);
        if (!isAllowedUpstreamUrl(request.url)) {
          throw new GatewayError(400, '上游地址必须为公网地址');
        }
        let upstream: Response;
        try {
          upstream = await fetch(request.url, {
            headers: { ...request.headers, accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '上游不可达';
          throw new GatewayError(502, `拉取模型失败：${message}`);
        }
        if (!upstream.ok) {
          throw new GatewayError(502, `上游返回 ${upstream.status}`);
        }
        const payload = (await upstream.json().catch(() => null)) as unknown;
        return { models: extractModelIds(payload) };
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/admin/upstream-model-catalog',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        // 汇总「上游真实存在的模型名」，供定价绑定选择。账号显式配置了模型清单直接采用；
        // 配置为「不限」的账号则临时拉取其 /models（best-effort，单个失败不影响整体）。
        const accounts = await listActiveAccounts();
        const ids = new Set<string>();
        await Promise.all(
          accounts.map(async (account) => {
            const explicit = toStringArray(account.models);
            if (explicit.length > 0) {
              for (const model of explicit) ids.add(model);
              return;
            }
            const apiKey = await secrets()
              .get(account.apiKeyRef)
              .catch(() => null);
            if (!apiKey) return;
            const request = upstreamModelsRequest(account.provider, account.baseUrl, apiKey);
            if (!isAllowedUpstreamUrl(request.url)) return;
            try {
              const upstream = await fetch(request.url, {
                headers: { ...request.headers, accept: 'application/json' },
                signal: AbortSignal.timeout(15_000),
              });
              if (!upstream.ok) return;
              const payload = (await upstream.json().catch(() => null)) as unknown;
              for (const model of extractModelIds(payload)) ids.add(model);
            } catch {
              // 单个账号不可达时忽略，返回已知并集。
            }
          }),
        );
        return { models: [...ids].sort() };
      }),
    },
    {
      /**
       * 公开价格目录查询：按模型名给「建议价」。
       *
       * 只读、不写库：管理员看到候选后自己确认再抄进定价，避免一次误匹配
       * 就把所有请求的价格改错。`rate` 可临时覆盖汇率（试算「如果汇率是 7.2」）。
       * 目录拉不到时返回 `available: false` 而不是 5xx：页面照常用，只是没有建议。
       */
      method: 'GET',
      path: '/llm-gateway/admin/price-catalog',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const query = priceCatalogQuerySchema.safeParse(req.query);
        if (!query.success) throw new GatewayError(400, '参数无效');
        const cfg = await getConfig();
        const rate = query.data.rate ?? cfg.usdRateMinor ?? DEFAULT_USD_RATE_MINOR;
        const model = query.data.model ?? '';
        // 汇率 0 = 管理员关掉了参考价功能（不想被美元标价误导）。
        // 这时候不去拉 3MB 数据源，直接告诉前端「已关闭」。
        if (rate === 0) return { available: false, disabled: true, rate, model, matches: [] };

        let snapshot: CatalogSnapshot;
        try {
          snapshot = await loadCatalog(rate, query.data.refresh === true);
        } catch (error) {
          getRuntime().logger.warn(
            `llm-gateway: 公开价格目录不可用: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { available: false, rate, model, matches: [] as unknown[] };
        }
        const matches = model === '' ? [] : matchCatalog(snapshot.entries, model);
        return {
          available: true,
          rate,
          model,
          source: snapshot.source,
          fetchedAt: snapshot.fetchedAt,
          total: snapshot.total,
          currency: snapshot.currency,
          matches: matches.map((match) => ({
            via: match.via,
            model: match.entry.model,
            provider: match.entry.provider,
            inputPrice: match.entry.inputPrice,
            outputPrice: match.entry.outputPrice,
            // 美元原值：界面要能展示 `$0.30/M × 7.00 = 210 分/M` 的换算过程。
            usdInputPerToken: match.entry.usdInputPerToken,
            usdOutputPerToken: match.entry.usdOutputPerToken,
            cacheReadPrice: match.entry.cacheReadPrice,
            maxInputTokens: match.entry.maxInputTokens,
            maxOutputTokens: match.entry.maxOutputTokens,
            tiers: match.entry.tiers,
            windows: match.entry.windows,
            // 峰谷价是否缺「节假日全天低谷」规则（DeepSeek 官方有，数据源没有）。
            holidayGap: hasHolidayGap(match.entry),
          })),
        };
      }),
    },

    /* ------------------------------ 管理端定价 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/prices',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        const prices = await listAllPrices();
        return { prices };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/prices',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const parsed = priceSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        assertExprPrice(parsed.data);
        assertPriceWindows(parsed.data);
        const data = {
          ...parsed.data,
          multiplier: parsed.data.multiplier ?? 100,
        };
        const upstreamModel = data.upstreamModel ?? '';
        const existing = await getPrice(data.model);
        const saved = existing
          ? await updatePrice(existing.id, defined({ ...data, upstreamModel }))
          : await createPrice({
              model: data.model,
              upstreamModel,
              inputPrice: data.inputPrice,
              outputPrice: data.outputPrice,
              cacheReadPrice: data.cacheReadPrice ?? 0,
              cacheWritePrice: data.cacheWritePrice ?? 0,
              reasoningPrice: data.reasoningPrice ?? 0,
              imagePrice: data.imagePrice ?? 0,
              audioPrice: data.audioPrice ?? 0,
              costInputPrice: data.costInputPrice ?? 0,
              costOutputPrice: data.costOutputPrice ?? 0,
              costCacheReadPrice: data.costCacheReadPrice ?? 0,
              costCacheWritePrice: data.costCacheWritePrice ?? 0,
              costReasoningPrice: data.costReasoningPrice ?? 0,
              costImagePrice: data.costImagePrice ?? 0,
              costAudioPrice: data.costAudioPrice ?? 0,
              tiers: data.tiers ?? [],
              windows: (data.windows ?? []).map((window) => ({
                timezone: window.timezone ?? '',
                weekdays: window.weekdays ?? [],
                hours: window.hours,
                percent: window.percent ?? 0,
                ...(window.inputPrice !== undefined ? { inputPrice: window.inputPrice } : {}),
                ...(window.outputPrice !== undefined ? { outputPrice: window.outputPrice } : {}),
                ...(window.cacheReadPrice !== undefined
                  ? { cacheReadPrice: window.cacheReadPrice }
                  : {}),
                ...(window.cacheWritePrice !== undefined
                  ? { cacheWritePrice: window.cacheWritePrice }
                  : {}),
                ...(window.reasoningPrice !== undefined
                  ? { reasoningPrice: window.reasoningPrice }
                  : {}),
                ...(window.costInputPrice !== undefined
                  ? { costInputPrice: window.costInputPrice }
                  : {}),
                ...(window.costOutputPrice !== undefined
                  ? { costOutputPrice: window.costOutputPrice }
                  : {}),
                ...(window.costCacheReadPrice !== undefined
                  ? { costCacheReadPrice: window.costCacheReadPrice }
                  : {}),
                ...(window.costCacheWritePrice !== undefined
                  ? { costCacheWritePrice: window.costCacheWritePrice }
                  : {}),
              })),
              refInputPrice: data.refInputPrice ?? 0,
              refOutputPrice: data.refOutputPrice ?? 0,
              refCacheReadPrice: data.refCacheReadPrice ?? 0,
              refSource: data.refSource ?? '',
              refFetchedAt: data.refFetchedAt ?? '',
              maxOutputTokens: data.maxOutputTokens ?? 0,
              groupDiscount: data.groupDiscount ?? true,
              strategy: data.strategy ?? '',
              expr: data.expr ?? '',
              multiplier: data.multiplier,
              capabilities: data.capabilities ?? [],
              enabled: data.enabled ?? true,
            });
        return reply.code(201).send({ price: saved });
      }),
    },
    {
      method: 'PATCH',
      path: '/llm-gateway/admin/prices/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        const body = priceUpdateSchema.safeParse(req.body);
        if (!params.success || !body.success) throw new GatewayError(400, '参数无效');
        assertExprPrice(body.data);
        assertPriceWindows(body.data);
        const updated = await updatePrice(params.data.id, defined(body.data));
        if (!updated) throw new GatewayError(404, '定价不存在');
        await auditAdmin(req, 'llm-gateway.price.update', 'gateway-price', updated.id, {
          model: updated.model,
          fields: Object.keys(body.data),
        });
        return { price: updated };
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/prices/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        await removePrice(params.data.id);
        await auditAdmin(req, 'llm-gateway.price.delete', 'gateway-price', params.data.id);
        return reply.code(204).send();
      }),
    },

    /* ------------------------------ 管理端配置（目标七） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/config',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => ({ config: await getConfig() })),
    },
    {
      method: 'PATCH',
      path: '/llm-gateway/admin/config',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const parsed = configUpdateSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const input = defined(parsed.data);
        // 敏感词（D2）：超长/超量截断而不是整份拒绝——词表是运维随时会调的东西。
        const dropped = input.sensitiveWords ? normalizeWordlist(input.sensitiveWords).dropped : 0;
        if (input.sensitiveWords)
          input.sensitiveWords = normalizeWordlist(input.sensitiveWords).words;
        const config = await setConfig(input);
        await auditAdmin(req, 'llm-gateway.config.update', 'gateway-config', 'default', {
          fields: Object.keys(input),
          sensitiveWords: config.sensitiveWords.length,
          sensitiveWordAction: config.sensitiveWordAction,
        });
        return { config, droppedWords: dropped };
      }),
    },

    /* ------------------------------ 管理端补偿队列（目标五/七） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/compensations',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        const [recent, pending] = await Promise.all([
          listCompensationEntries(100),
          listPendingCompensations(Date.now()),
        ]);
        return {
          entries: recent,
          pending: pending.length,
        };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/compensations/run',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        const result = await runCompensation(wallet(), runtime!.logger);
        return { result };
      }),
    },

    /* ------------------------------ 管理端任务（目标七） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/tasks',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const status =
          typeof req.query?.['status'] === 'string' ? (req.query['status'] as string) : undefined;
        const tasks = await listTasks(100, status);
        return { tasks };
      }),
    },

    /* ------------------------------ 管理端指标（目标七/九） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/metrics',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        const metrics = await readAllMetrics(state(), METRIC_NAMES);
        return { metrics };
      }),
    },

    /* ------------------------------ 管理端概览 ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/overview',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => {
        const since = daysAgo(30);
        const [keys, accounts, logs, topModels, recentLogs, latency, firstToken] =
          await Promise.all([
            auth()
              .listPlatformTokensByScope(GATEWAY_SCOPE)
              .then((rows) => rows.length)
              .catch(() => 0),
            countAccounts(),
            listLogsSince(since, 20_000),
            listLogsSince(since, 20_000),
            listRecentAllLogs(50),
            // D5：延迟分布（1 小时窗口的分桶分位数）。
            readLatencyStats(state(), 'latency'),
            readLatencyStats(state(), 'first_token'),
          ]);
        const summary = logs.reduce(
          (acc, log) => {
            acc.requests += 1;
            acc.amount += log.amount;
            acc.cost += log.costAmount ?? 0;
            acc.discounted += log.discountPercent > 0 ? 1 : 0;
            // 成本覆盖率看的是「这条流水有没有算过成本」，不是有没有打折。
            // 历史上这里错用了 discounted，导致打了折的请求被当成「未覆盖成本」。
            acc.costCovered += (log.costAmount ?? 0) > 0 ? 1 : 0;
            acc.totalTokens += log.totalTokens;
            return acc;
          },
          { requests: 0, amount: 0, cost: 0, discounted: 0, costCovered: 0, totalTokens: 0 },
        );
        const byModel = new Map<
          string,
          { requests: number; amount: number; totalTokens: number }
        >();
        for (const log of topModels) {
          const entry = byModel.get(log.model) ?? {
            requests: 0,
            amount: 0,
            totalTokens: 0,
          };
          entry.requests += 1;
          entry.amount += log.amount;
          entry.totalTokens += log.totalTokens;
          byModel.set(log.model, entry);
        }
        return {
          accounts,
          keys,
          summary: {
            ...summary,
            /* 毛利按「营收 - 成本」；成本覆盖率提醒管理员有多少请求还没填成本价。 */
            margin: summary.amount - summary.cost,
            costCoverage: summary.requests > 0 ? summary.costCovered / summary.requests : 1,
          },
          /** 延迟分位数（D5）：档位上界，1 小时窗口。 */
          latency: {
            windowMs: 60 * 60 * 1000,
            total: latency,
            firstToken,
          },
          topModels: [...byModel.entries()]
            .map(([model, stats]) => ({ model, ...stats }))
            .sort((a, b) => b.amount - a.amount || b.totalTokens - a.totalTokens)
            .slice(0, 10),
          logs: recentLogs.map((log) => ({
            id: log.id,
            model: log.model,
            totalTokens: log.totalTokens,
            amount: log.amount,
            status: log.status,
            createdAt: log.createdAt,
          })),
        };
      }),
    },

    /* ------------------------------ 转换诊断（D4） ------------------------------ */
    {
      method: 'POST',
      path: '/llm-gateway/admin/diagnostics/convert',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const parsed = convertDiagnosticsSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const { from, to, body, model } = parsed.data;
        if (!isProtocol(from) || !isProtocol(to)) {
          throw new GatewayError(400, '不支持的协议');
        }
        return diagnoseConversion({ from, to, body, model });
      }),
    },
    {
      /**
       * 适配器矩阵：哪个 provider 说哪种方言、支持哪些 operation。
       * 排障时不用再去翻代码，「这个号为什么不支持 embeddings」一眼可见。
       */
      method: 'GET',
      path: '/llm-gateway/admin/diagnostics/adaptors',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () =>
        listAdaptors().map((adaptor) => ({
          id: adaptor.id,
          label: adaptor.label,
          protocol: adaptor.protocol,
          operations: [...adaptor.capabilities.operations],
          streaming: adaptor.capabilities.streaming,
          toolCalls: adaptor.capabilities.toolCalls,
          images: adaptor.capabilities.images,
          promptCache: adaptor.capabilities.promptCache,
          streamUsage: adaptor.capabilities.streamUsage,
          preservedFields: [...adaptor.preservedFields],
        })),
      ),
    },

    /* ------------------------------ 上游账号：多 Key（A1） ------------------------------ */
    {
      method: 'POST',
      path: '/llm-gateway/admin/accounts/:id/keys',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = idSchema.safeParse(req.params);
        const body = accountKeySchema.safeParse(req.body);
        if (!params.success || !body.success) throw new GatewayError(400, '参数无效');
        const account = await getAccount(params.data.id);
        if (!account) throw new GatewayError(404, '账号不存在');
        const current = account.keys ?? [];
        if (current.length >= MAX_ACCOUNT_KEYS) {
          throw new GatewayError(400, '单账号 key 数量已达上限（20）');
        }
        const keyId = newId();
        const apiKeyRef = `account.${account.id}.key.${keyId}`;
        await secrets().set(apiKeyRef, body.data.apiKey);
        const label = body.data.label ?? `key-${current.length + 1}`;
        const weight = body.data.weight ?? 100;
        await updateAccount(account.id, {
          keys: [...current, { id: keyId, label, apiKeyRef, weight }],
        });
        return reply.code(201).send({ key: { id: keyId, label, weight } });
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/accounts/:id/keys/:keyId',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = accountKeyParamsSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const account = await getAccount(params.data.id);
        if (!account) throw new GatewayError(404, '账号不存在');
        const target = (account.keys ?? []).find((key) => key.id === params.data.keyId);
        if (!target) throw new GatewayError(404, 'key 不存在');
        await secrets()
          .remove(target.apiKeyRef)
          .catch(() => null);
        await updateAccount(account.id, {
          keys: (account.keys ?? []).filter((key) => key.id !== target.id),
        });
        return reply.code(204).send();
      }),
    },

    /* ------------------------------ 上游账号：测活 / 余额（A2） ------------------------------ */
    {
      method: 'POST',
      path: '/llm-gateway/admin/accounts/:id/test',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const account = await getAccount(params.data.id);
        if (!account) throw new GatewayError(404, '账号不存在');
        const probe = optionalModelSchema.safeParse(req.body ?? {});
        if (!probe.success) throw new GatewayError(400, '参数无效');
        // 指定 keyId 时测那一把；否则用主 key（测活不消耗推理额度）。
        const keyId = probe.data.keyId ?? PRIMARY_KEY_ID;
        const apiKeyRef =
          keyId === PRIMARY_KEY_ID
            ? account.apiKeyRef
            : (account.keys ?? []).find((key) => key.id === keyId)?.apiKeyRef;
        if (!apiKeyRef) throw new GatewayError(404, 'key 不存在');
        const apiKey = await secrets()
          .get(apiKeyRef)
          .catch(() => null);
        if (!apiKey) throw new GatewayError(400, '上游账号凭证缺失');
        const result = await probeAccount({
          provider: account.provider,
          baseUrl: account.baseUrl,
          apiKey,
          model: probe.data.model ?? account.models?.[0] ?? '',
        });
        return { result };
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/admin/accounts/:id/balance',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const account = await getAccount(params.data.id);
        if (!account) throw new GatewayError(404, '账号不存在');
        const apiKey = await secrets()
          .get(account.apiKeyRef)
          .catch(() => null);
        if (!apiKey) throw new GatewayError(400, '上游账号凭证缺失');
        const result = await fetchBalance({
          provider: account.provider,
          baseUrl: account.baseUrl,
          apiKey,
        });
        // 快照只写「查到了」的结果：查不到时保留上一次已知值，避免看板被清空。
        if (result.supported && result.amount !== null) {
          await updateAccount(account.id, {
            balance: result.amount,
            balanceCurrency: result.currency,
            balanceUpdatedAt: result.checkedAt,
          }).catch(() => undefined);
        }
        return { balance: result };
      }),
    },

    /* ------------------------------ 管理端用量日志（A5） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/usage-logs',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const parsed = usageLogQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const query = parsed.data;
        const since = new Date(Date.now() - (query.days ?? 1) * 24 * 60 * 60 * 1000);
        const page = await listUsageLogs({
          userId: query.userId,
          apiKeyId: query.apiKeyId,
          accountId: query.accountId,
          model: query.model,
          status: query.status,
          since,
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 50,
        });
        return {
          logs: page.items.map((log) => ({
            id: log.id,
            userId: log.userId,
            apiKeyId: log.apiKeyId,
            accountId: log.accountId ?? null,
            upstreamKeyId: log.upstreamKeyId ?? '',
            rewrites: log.rewrites ?? '',
            model: log.model,
            protocol: log.protocol,
            endpoint: log.endpoint,
            totalTokens: log.totalTokens,
            amount: log.amount,
            costAmount: log.costAmount ?? 0,
            discountPercent: log.discountPercent ?? 0,
            status: log.status,
            estimated: log.estimated,
            aborted: log.aborted ?? false,
            httpStatus: log.httpStatus ?? null,
            latencyMs: log.latencyMs ?? null,
            error: log.error ?? null,
            createdAt: log.createdAt,
          })),
          total: page.total,
          page: page.page,
          pageSize: page.pageSize,
        };
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/admin/usage-logs.csv',
      kind: 'raw',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: async (req, reply) => {
        try {
          const params = req.query;
          const days = Number(params.get('days') ?? '1');
          const parsed = usageLogQuerySchema.safeParse({
            days: Number.isFinite(days) ? days : 1,
            page: 1,
            pageSize: 200,
            ...(params.get('userId') ? { userId: params.get('userId') } : {}),
            ...(params.get('model') ? { model: params.get('model') } : {}),
            ...(params.get('status') ? { status: params.get('status') } : {}),
            ...(params.get('accountId') ? { accountId: params.get('accountId') } : {}),
          });
          if (!parsed.success) throw new GatewayError(400, '参数无效');
          const since = new Date(Date.now() - (parsed.data.days ?? 1) * 24 * 60 * 60 * 1000);
          const page = await listUsageLogs({
            userId: parsed.data.userId,
            apiKeyId: parsed.data.apiKeyId,
            accountId: parsed.data.accountId,
            model: parsed.data.model,
            status: parsed.data.status,
            since,
            page: 1,
            pageSize: 200,
          });
          reply.status(200);
          reply.header('content-type', 'text/csv; charset=utf-8');
          reply.header(
            'content-disposition',
            `attachment; filename="gateway-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
          );
          // BOM 让 Excel 直接按 UTF-8 打开（中文列名不乱码）。
          reply.end(`\uFEFF${usageLogsCsv(page.items)}`);
        } catch (error) {
          const status = error instanceof GatewayError ? error.status : 500;
          const message = error instanceof Error ? error.message : '导出失败';
          reply.status(status);
          reply.header('content-type', 'application/json; charset=utf-8');
          reply.end(JSON.stringify({ error: { message } }));
        }
      },
    },

    /* ------------------------------ 用户端：套餐权益（B1） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/entitlements',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = requireUser(req);
        const rows = await listUserEntitlements(userId);
        return {
          entitlements: rows.map((row) => ({
            id: row.id,
            name: row.name,
            source: row.source,
            quotaAmount: row.quotaAmount,
            usedAmount: row.usedAmount,
            remaining: row.quotaAmount > 0 ? remainingOf(row) : null,
            models: row.models,
            startsAt: row.startsAt,
            expiresAt: row.expiresAt ?? null,
            status: entitlementStatusOf(row),
            priority: row.priority,
            createdAt: row.createdAt,
          })),
        };
      }),
    },

    /* ------------------------------ 用户端：对账单（B5） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/statement',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = requireUser(req);
        const parsed = statementQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const range = monthRange(parsed.data.month);
        const rows = await listLogsBetween(range.since, range.until, 50_000, { userId });
        const statement = aggregateStatement(rows);
        return {
          month: range.label,
          total: statement.total,
          byModel: statement.byModel,
        };
      }),
    },

    /* ------------------------------ 公开价目（B6） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/public/prices',
      // 匿名可读：价格页不该强制登录。登录时叠加该用户权限组的折扣。
      auth: 'optional',
      handler: handle(async (req: HttpRequest) => {
        const prices = await listAllPrices();
        const userId = req.user?.id ?? '';
        const groups = userId
          ? await auth()
              .listUserGroups(userId)
              .catch(() => [])
          : [];
        const discountPercent = bestDiscountPercent(groups);
        return {
          currency: 'CNY',
          discountPercent,
          models: prices
            .filter((price) => price.enabled && price.model !== '*')
            .map((price) => ({
              model: price.model,
              inputPrice: price.inputPrice,
              outputPrice: price.outputPrice,
              cacheReadPrice: price.cacheReadPrice ?? 0,
              cacheWritePrice: price.cacheWritePrice ?? 0,
              reasoningPrice: price.reasoningPrice ?? 0,
              imagePrice: price.imagePrice ?? 0,
              audioPrice: price.audioPrice ?? 0,
              multiplier: price.multiplier,
              capabilities: price.capabilities ?? [],
              tiers: price.tiers ?? [],
              strategy: price.strategy || '',
              // 折扣后的实付单价（向下取整；0 表示免费）
              discountedInputPrice: applyDiscount(price.inputPrice, discountPercent),
              discountedOutputPrice: applyDiscount(price.outputPrice, discountPercent),
            }))
            .sort((a, b) => a.model.localeCompare(b.model)),
        };
      }),
    },

    /* ------------------------------ 管理端：模型映射（B4） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/model-maps',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => ({ maps: await listModelMaps() })),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/model-maps',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const parsed = modelMapSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const data = parsed.data;
        const invalid = validateModelMapRule({
          from: data.from,
          mode: data.mode,
          targets: data.targets.map((target) => ({
            model: target.model,
            weight: target.weight ?? 100,
          })),
        });
        if (invalid) throw new GatewayError(400, invalid);
        const saved = await createModelMap({
          from: data.from,
          mode: data.mode,
          targets: data.targets.map((target) => ({
            model: target.model,
            weight: target.weight ?? 100,
          })),
          priority: data.priority ?? 0,
          enabled: data.enabled ?? true,
          note: data.note ?? '',
        });
        return reply.code(201).send({ map: saved });
      }),
    },
    {
      method: 'PATCH',
      path: '/llm-gateway/admin/model-maps/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        const body = modelMapUpdateSchema.safeParse(req.body);
        if (!params.success || !body.success) throw new GatewayError(400, '参数无效');
        const existing = (await listModelMaps()).find((row) => row.id === params.data.id);
        if (!existing) throw new GatewayError(404, '映射不存在');
        const targets = body.data.targets?.map((target) => ({
          model: target.model,
          weight: target.weight ?? 100,
        }));
        const merged = {
          from: body.data.from ?? existing.from,
          mode: body.data.mode ?? existing.mode,
          targets: targets ?? existing.targets,
        };
        const invalid = validateModelMapRule(merged);
        if (invalid) throw new GatewayError(400, invalid);
        const saved = await updateModelMap(params.data.id, {
          ...defined({ ...body.data, targets: undefined }),
          ...(targets ? { targets } : {}),
        });
        return { map: saved };
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/model-maps/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const removed = await removeModelMap(params.data.id);
        if (!removed) throw new GatewayError(404, '映射不存在');
        return reply.code(204).send();
      }),
    },

    /* ------------------------------ 管理端：预算限额（B3） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/budget-limits',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async () => ({ limits: await listBudgetLimits() })),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/budget-limits',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const parsed = budgetLimitSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const saved = await createBudgetLimit({
          userId: parsed.data.userId ?? '',
          period: parsed.data.period,
          amountLimit: parsed.data.amountLimit,
          warnPercent: parsed.data.warnPercent ?? 80,
          action: parsed.data.action,
          enabled: parsed.data.enabled ?? true,
        });
        return reply.code(201).send({ limit: saved });
      }),
    },
    {
      method: 'PATCH',
      path: '/llm-gateway/admin/budget-limits/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        const body = budgetLimitUpdateSchema.safeParse(req.body);
        if (!params.success || !body.success) throw new GatewayError(400, '参数无效');
        const saved = await updateBudgetLimit(params.data.id, defined(body.data));
        if (!saved) throw new GatewayError(404, '限额不存在');
        return { limit: saved };
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/budget-limits/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const removed = await removeBudgetLimit(params.data.id);
        if (!removed) throw new GatewayError(404, '限额不存在');
        return reply.code(204).send();
      }),
    },

    /* ------------------------------ 管理端：套餐权益（B1） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/entitlements',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const userId = typeof req.query?.['userId'] === 'string' ? req.query['userId'] : '';
        const rows = userId ? await listUserEntitlements(userId) : await listAllEntitlements();
        return {
          entitlements: rows.map((row) => ({
            ...row,
            remaining: row.quotaAmount > 0 ? remainingOf(row) : null,
            liveStatus: entitlementStatusOf(row),
          })),
        };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/entitlements',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const parsed = entitlementCreateSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const data = parsed.data;
        const now = new Date();
        const startsAt = data.startsAt ?? now.toISOString();
        const expiresAt =
          data.expiresAt !== undefined
            ? data.expiresAt
            : data.validityDays
              ? new Date(now.getTime() + data.validityDays * 24 * 60 * 60 * 1000).toISOString()
              : null;
        const saved = await createEntitlement({
          userId: data.userId,
          name: data.name ?? '',
          source: 'admin',
          productId: '',
          orderId: '',
          serviceId: '',
          quotaAmount: data.quotaAmount,
          usedAmount: 0,
          models: data.models ?? [],
          startsAt,
          expiresAt,
          status: 'ACTIVE',
          priority: data.priority ?? 0,
        });
        return reply.code(201).send({ entitlement: saved });
      }),
    },
    {
      method: 'DELETE',
      path: '/llm-gateway/admin/entitlements/:id',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const reason =
          typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string'
            ? String((req.body as { reason?: string }).reason).slice(0, 300)
            : '管理员撤销';
        const saved = await updateEntitlement(params.data.id, {
          status: 'REVOKED',
          revokedReason: reason,
        });
        if (!saved) throw new GatewayError(404, '权益不存在');
        return { entitlement: saved };
      }),
    },

    /* ------------------------------ 管理端：对账单（B5） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/admin/statements',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const parsed = statementQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const range = monthRange(parsed.data.month);
        const rows = await listLogsBetween(range.since, range.until);
        return { month: range.label, ...aggregateStatement(rows) };
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/admin/statements.csv',
      kind: 'raw',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: async (req, reply) => {
        try {
          const month = req.query.get('month') ?? undefined;
          const parsed = statementQuerySchema.safeParse(month ? { month } : {});
          if (!parsed.success) {
            reply.status(400);
            reply.header('content-type', 'application/json; charset=utf-8');
            reply.end(JSON.stringify({ error: { message: '参数无效' } }));
            return;
          }
          const range = monthRange(parsed.data.month);
          const rows = await listLogsBetween(range.since, range.until);
          reply.header('content-type', 'text/csv; charset=utf-8');
          reply.header(
            'content-disposition',
            `attachment; filename="gateway-statement-${range.label}.csv"`,
          );
          // BOM 让 Excel 直接按 UTF-8 打开。
          reply.end(`\uFEFF${statementCsv(rows)}`);
        } catch (error) {
          const status = error instanceof GatewayError ? error.status : 500;
          const message = error instanceof Error ? error.message : '导出失败';
          reply.status(status);
          reply.header('content-type', 'application/json; charset=utf-8');
          reply.end(JSON.stringify({ error: { message } }));
        }
      },
    },
    /* ------------------------------ 用户端：异步任务（C1/C2） ------------------------------ */
    {
      method: 'GET',
      path: '/llm-gateway/tasks/descriptors',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async () => ({
        descriptors: listTaskDescriptors().map((descriptor) => ({
          id: descriptor.id,
          label: descriptor.label,
          kind: descriptor.kind,
          params: descriptor.params,
          billing: descriptor.billing.unit,
        })),
      })),
    },
    {
      method: 'POST',
      path: '/llm-gateway/tasks',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const userId = requireUser(req);
        const parsed = taskSubmitSchema.safeParse(req.body);
        if (!parsed.success) throw new GatewayError(400, '参数无效');
        const task = await submitTask(getRuntime(), {
          userId,
          apiKeyId: `task:${userId}`,
          descriptorId: parsed.data.descriptorId,
          model: parsed.data.model,
          params: parsed.data.params ?? {},
          currency: 'CNY',
          clientIp: req.ip ?? null,
        });
        const links = await buildArtifactLinks(getRuntime(), task);
        return reply.code(201).send({ task: taskView(task, links) });
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/tasks',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = requireUser(req);
        const rows = await listUserTasks(userId, 50);
        const rt = getRuntime();
        const tasks = await Promise.all(
          rows.map(async (row) => taskView(row, await buildArtifactLinks(rt, row))),
        );
        return { tasks };
      }),
    },
    {
      method: 'GET',
      path: '/llm-gateway/tasks/:id',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = requireUser(req);
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const task = await requireTask(params.data.id, userId);
        const rt = getRuntime();
        return { task: taskView(task, await buildArtifactLinks(rt, task)) };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/tasks/:id/cancel',
      auth: 'user',
      permission: 'llm-gateway.use',
      handler: handle(async (req: HttpRequest) => {
        const userId = requireUser(req);
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const task = await requireTask(params.data.id, userId);
        const cancelled = await cancelTask(getRuntime(), task, userId);
        return { task: taskView(cancelled, []) };
      }),
    },
    {
      method: 'POST',
      path: '/llm-gateway/admin/tasks/:id/poll',
      auth: 'admin',
      permission: 'llm-gateway.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) throw new GatewayError(400, '参数无效');
        const task = await getTask(params.data.id);
        if (!task) throw new GatewayError(404, '任务不存在');
        const outcome = await pollTask(getRuntime(), task);
        return { task: taskView(outcome.task, []), finished: outcome.finished };
      }),
    },
  ],

  onActivate(ctx: PluginContext) {
    bindContext(ctx);
    // 声明本插件发出的通知类型，供内核偏好目录展示（未声明 = 永远投递、不可关闭）。
    for (const definition of GATEWAY_NOTIFICATION_TYPES) {
      ctx.registerExtension(EXTENSION_POINTS.notificationType, definition);
    }
    ctx.registerExtension(EXTENSION_POINTS.llmProvider, createAgentProvider(getRuntime));
    // 商品类型（B1）：商店卖「模型额度包」，履约落成本插件的权益记录。
    ctx.registerExtension(EXTENSION_POINTS.productType, entitlementProductType);
    runtime = {
      wallet: ctx.wallet,
      auth: ctx.auth,
      state: ctx.state,
      secrets: ctx.secrets,
      logger: ctx.logger,
    };
    // 补偿队列（ADR-0013）：插件不能自建定时器，交给内核 worker 池，多副本下只跑一次。
    ctx.jobs.handle('compensation', async () => {
      await runCompensation(ctx.wallet, ctx.logger).catch((error: unknown) => {
        ctx.logger.warn(
          `llm-gateway: compensation cycle failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    void ctx.jobs
      .schedule('compensation', { everyMs: COMPENSATION_INTERVAL_MS })
      .catch(() => undefined);
    // 余额巡检（A2）：每 6 小时刷新一次账号余额快照。只读上游，不碰计费。
    ctx.jobs.handle('balance-refresh', async () => {
      const accounts = await listAllAccounts().catch(() => []);
      for (const account of accounts.slice(0, 20)) {
        if (account.enabled === false || account.status !== 'ACTIVE') continue;
        const apiKey = await secrets()
          .get(account.apiKeyRef)
          .catch(() => null);
        if (!apiKey) continue;
        const result = await fetchBalance({
          provider: account.provider,
          baseUrl: account.baseUrl,
          apiKey,
        }).catch(() => null);
        if (result?.supported && result.amount !== null) {
          await updateAccount(account.id, {
            balance: result.amount,
            balanceCurrency: result.currency,
            balanceUpdatedAt: result.checkedAt,
          }).catch(() => undefined);
        }
      }
    });
    void ctx.jobs
      .schedule('balance-refresh', { everyMs: 6 * 60 * 60 * 1000 })
      .catch(() => undefined);
    /**
     * 权益到期清扫（B1）：把过期的 `ACTIVE` 行标成 `EXPIRED`。
     *
     * 这不承担「准时」责任——抵扣读路径用 `isLive()` 按 `expiresAt` 即时判断，
     * 清扫只是让管理端列表和统计不把死行算成可用。
     */
    ctx.jobs.handle('entitlement-expiry', async () => {
      const expired = await expireEntitlements(new Date()).catch(() => 0);
      if (expired > 0) ctx.logger.info(`llm-gateway: ${expired} 个套餐权益已过期`);
    });
    void ctx.jobs
      .schedule('entitlement-expiry', { everyMs: 60 * 60 * 1000 })
      .catch(() => undefined);
    /**
     * 异步任务执行器（C1）：每 15 秒把到期的 QUEUED / RUNNING 任务推进一格。
     *
     * 每轮最多 10 个且**串行**：单个上游可能限流，一批任务同时打过去只会让它们
     * 一起失败；串行还能保证「一个卡住的上游」不占满 job 的时间片。
     */
    ctx.jobs.handle('task-poller', async () => {
      await runTaskTick(getRuntime()).catch((error: unknown) => {
        ctx.logger.warn(
          `llm-gateway: task poller failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    void ctx.jobs
      .schedule('task-poller', { everyMs: TASK_POLL_INTERVAL_MS })
      .catch(() => undefined);
    ctx.logger.info('llm-gateway: activated');
  },

  onDeactivate(ctx: PluginContext) {
    runtime = null;
    resetContext();
    ctx.logger.info('llm-gateway: deactivated');
  },
});

export default llmGatewayPlugin;
