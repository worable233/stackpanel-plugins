import { definePlugin, PluginError } from '@stackpanel/sdk';
import type { HttpReply, HttpRequest, PluginContext } from '@stackpanel/sdk';
import { z } from 'zod';
import { isAllowedUpstreamUrl } from './guard.js';
import { GATEWAY_SCOPE, newId, toStringArray } from './keys.js';
import { createRelayHandler, type GatewayRuntime } from './gateway.js';
import { PROTOCOLS } from './protocol.js';
import {
  gatewayAccountModel,
  gatewayKeyPolicyModel,
  gatewayLegacyKeyModel,
  gatewayModelPriceModel,
  gatewayUsageLogModel,
  gatewayUserSettingModel,
} from './data.js';
import {
  auth,
  bindContext,
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
  getPolicy,
  getPrice,
  getSetting,
  listActiveAccounts,
  listAllAccounts,
  listAllPrices,
  listEnabledPrices,
  listLogsSince,
  listPoliciesByTokens,
  listRecentAllLogs,
  listRecentLogs,
  listUserLogsSince,
  removeAccount,
  removePolicy,
  removePrice,
  setSetting,
  updateAccount,
  updatePrice,
  upsertPolicy,
} from './repository.js';

/**
 * API 中转网关（按量后付费）。
 *
 * - raw 透传路由 `/llm-gateway/*`：四种入口协议按 key 鉴权、选上游账号池转发，同协议直通、跨协议转换。
 * - API 计费开关（用户级）：开启后才能调用，一个入口调所有模型，可建多把 key。
 * - 后付费：请求结束按 token 用量 × 模型定价，调用内核钱包 `wallet.debit` 扣余额（幂等）。
 */

let runtime: GatewayRuntime | null = null;

/** Exact messages that map to a stable code (ADR-0012). */
const GATEWAY_ERROR_CODES: Record<string, string> = {
  参数无效: 'llm_gateway.params_invalid',
  '缺少 Base URL 或上游 API Key': 'llm_gateway.upstream_credentials_required',
  '密钥数量已达上限（50）': 'llm_gateway.key_limit_reached',
  未登录: 'auth.unauthenticated',
  密钥不存在: 'llm_gateway.key_not_found',
  账号不存在: 'llm_gateway.account_not_found',
  'API 中转插件未就绪': 'llm_gateway.not_ready',
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
  if (!runtime) throw new GatewayError(503, 'API 中转插件未就绪');
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

const modelsField = z.preprocess((value) => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return parseModels(value);
  return undefined;
}, z.array(z.string().min(1).max(128)).max(500).optional());

const optionalInt = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional());

const optionalString = (max: number) =>
  z.preprocess(blankToUndefined, z.string().min(1).max(max).optional());

const optionalEnum = <T extends [string, ...string[]]>(values: T) =>
  z.preprocess(blankToUndefined, z.enum(values).optional());

const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  models: modelsField,
  rpmLimit: optionalInt(0, 1_000_000),
  concurrencyLimit: optionalInt(0, 10_000),
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
  quotaLimit: z.preprocess(
    blankToUndefined,
    z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  ),
});

const accountSchema = z.object({
  name: z.string().min(1).max(64),
  baseUrl: z.string().url().max(500).refine(isAllowedUpstreamUrl, '上游地址必须为公网地址'),
  apiKey: z.string().min(1).max(500),
  provider: z.preprocess(blankToUndefined, z.enum(PROTOCOLS).optional()),
  models: modelsField,
  priority: optionalInt(-1_000_000, 1_000_000),
  weight: optionalInt(1, 100_000),
  maxConcurrency: optionalInt(0, 100_000),
  status: optionalEnum(['ACTIVE', 'DISABLED']),
});

const accountUpdateSchema = accountSchema.partial();

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
    return { url: `${base}/v1beta/models`, headers: { 'x-goog-api-key': apiKey } };
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

const priceSchema = z.object({
  model: z.string().min(1).max(128),
  upstreamModel: optionalString(128),
  inputPrice: z.coerce.number().int().min(0).max(2_000_000_000),
  outputPrice: z.coerce.number().int().min(0).max(2_000_000_000),
  cacheReadPrice: optionalInt(0, 2_000_000_000),
  cacheWritePrice: optionalInt(0, 2_000_000_000),
  capabilities: modelsField,
  multiplier: optionalInt(0, 100_000),
  enabled: z.preprocess(blankToUndefined, z.boolean().optional()),
});

const priceUpdateSchema = priceSchema.partial().omit({ model: true });

const idSchema = z.object({ id: z.string().min(1).max(191) });

const billingSchema = z.object({ enabled: z.boolean() });

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
    const inspection = await auth().inspectPlatformToken(token).catch(() => null);
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

/** 统一的 handler 错误包装。 */
function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof GatewayError) {
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

export const llmGatewayPlugin = definePlugin({
  manifest: {
    id: 'llm-gateway',
    name: 'API 中转',
    version: '0.1.0',
    description:
      'OpenAI 兼容 API 中转：用户级 API 计费开关、可建多把 key、统一入口调用所有模型、按 token 后付费扣钱包余额。',
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
    gatewayAccountModel,
    gatewayKeyPolicyModel,
    gatewayUserSettingModel,
    gatewayUsageLogModel,
    gatewayModelPriceModel,
    gatewayLegacyKeyModel,
  ],

  routes: [
    /* ------------------------------ 透传路由 ------------------------------ */
    {
      kind: 'raw',
      method: 'POST',
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
          data: models.map((id) => ({ id, object: 'model', created, owned_by: 'stackpanel' })),
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
          data: models.map((id) => ({ id, object: 'model', created, owned_by: 'stackpanel' })),
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
        if (revealedKey) await state().del(revealKey).catch(() => undefined);
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
        });
        await state()
          .set(`gw:reveal:${userId}`, created.plaintext, 5 * 60 * 1000)
          .catch(() => undefined);
        return reply.code(201).send({
          key: { id: created.token.id, name: created.token.name, keyPrefix: created.token.keyPrefix },
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
        const { name, status, models, rpmLimit, concurrencyLimit, quotaLimit } = body.data;
        const tokenPatch = defined({ name, status });
        if (Object.keys(tokenPatch).length > 0) {
          await auth().updatePlatformToken(token.id, tokenPatch);
        }
        const policyPatch = defined({ models, rpmLimit, concurrencyLimit, quotaLimit });
        if (Object.keys(policyPatch).length > 0) {
          await upsertPolicy(token.id, policyPatch);
        }
        const updated =
          status !== undefined ? { name: name ?? token.name, status } : { name: name ?? token.name, status: token.status };
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
          rows: Array<{ amount: number; totalTokens: number; createdAt: string | Date }>,
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
        const weekSeries = bucketBy(weekLogs, dayKeys(7), (d) => dayKey(d), (k) => k);
        const monthSeries = bucketBy(monthLogs, dayKeys(30), (d) => dayKey(d), (k) => k);

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

        const modelBreakdown = (rows: Array<{ model: string; amount: number; totalTokens: number }>) => {          const byModel = rows.reduce<
            Record<string, { model: string; amount: number; tokens: number; requests: number }>
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
            lastUsedAt: account.lastUsedAt,
            createdAt: account.createdAt,
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
        const { apiKey, ...rest } = parsed.data;
        const id = newId();
        const apiKeyRef = `account.${id}`;
        await secrets().set(apiKeyRef, apiKey);
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
          lastUsedAt: null,
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
        const { apiKey, ...rest } = body.data;
        if (apiKey) await secrets().set(existing.apiKeyRef, apiKey);
        const updated = await updateAccount(params.data.id, defined(rest));
        if (!updated) throw new GatewayError(404, '账号不存在');
        return { account: { id: updated.id, name: updated.name, status: updated.status } };
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
        await secrets()
          .remove(existing.apiKeyRef)
          .catch(() => null);
        await removeAccount(params.data.id);
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
        let account: { baseUrl: string; provider: string; apiKeyRef: string } | null = null;
        if (parsed.data.id) {
          const found = await getAccount(parsed.data.id);
          if (!found) throw new GatewayError(404, '账号不存在');
          account = found;
          baseUrl = baseUrl ?? found.baseUrl;
          apiKey =
            apiKey ??
            ((await secrets()
              .get(found.apiKeyRef)
              .catch(() => null)) ?? undefined);
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
        const data = { ...parsed.data, multiplier: parsed.data.multiplier ?? 100 };
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
        const updated = await updatePrice(params.data.id, defined(body.data));
        if (!updated) throw new GatewayError(404, '定价不存在');
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
        return reply.code(204).send();
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
        const [keys, accounts, logs, topModels, recentLogs] = await Promise.all([
          auth()
            .listPlatformTokensByScope(GATEWAY_SCOPE)
            .then((rows) => rows.length)
            .catch(() => 0),
          countAccounts(),
          listLogsSince(since, 20_000),
          listLogsSince(since, 20_000),
          listRecentAllLogs(50),
        ]);
        const summary = logs.reduce(
          (acc, log) => {
            acc.requests += 1;
            acc.amount += log.amount;
            acc.totalTokens += log.totalTokens;
            return acc;
          },
          { requests: 0, amount: 0, totalTokens: 0 },
        );
        const byModel = new Map<string, { requests: number; amount: number; totalTokens: number }>();
        for (const log of topModels) {
          const entry = byModel.get(log.model) ?? { requests: 0, amount: 0, totalTokens: 0 };
          entry.requests += 1;
          entry.amount += log.amount;
          entry.totalTokens += log.totalTokens;
          byModel.set(log.model, entry);
        }
        return {
          accounts,
          keys,
          summary,
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
  ],

  onActivate(ctx: PluginContext) {
    bindContext(ctx);
    runtime = {
      wallet: ctx.wallet,
      auth: ctx.auth,
      state: ctx.state,
      secrets: ctx.secrets,
      logger: ctx.logger,
    };
    ctx.logger.info('llm-gateway: activated');
  },

  onDeactivate(ctx: PluginContext) {
    runtime = null;
    resetContext();
    ctx.logger.info('llm-gateway: deactivated');
  },
});

export default llmGatewayPlugin;
