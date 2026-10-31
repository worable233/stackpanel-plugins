/**
 * 中转转发器（目标一 relay + 目标四 14 项必修）。
 *
 * 这是新的唯一入口，取代旧 `gateway.ts` 的 `createRelayHandler`。与旧实现的差别：
 * - 入口路径**不再回落到 Chat**：未注册的路径 404、注册但不支持的 501、
 *   方法不符 405（`endpoints.matchEndpoint`）。
 * - 计费走预授权状态机（`billing.ts`），不再「先查余额、用完再扣」。
 * - 上游调用带 AbortController + deadline + 断开传播（`upstream.ts`）、
 *   账号健康/熔断/冷却与长流租约续期（`scheduler.ts`）、并发与 RPM 走 Redis。
 * - 错误一律稳定 OpenAI schema（`errors.ts`），日志/URL/异常经 `redactSecrets`。
 * - 多 provider adaptor（`adaptors/`）：端点构造、鉴权头、usage、错误分类、重试。
 *
 * 顺序纪律（`billing.ts` 头注释）：先预留、再选账号、后执行上游。
 */

import type { Readable } from 'node:stream';
import type { RawHttpReply, RawHttpRequest, RawRouteHandler, StateLease } from '@stackpanel/sdk';
import { isWalletError } from '@stackpanel/sdk';
import { isAllowedUpstreamUrl } from './guard.js';
import { notifyQuotaExhausted } from './context.js';
import { extractApiKey, toStringArray } from './keys.js';
import {
  matchEndpoint,
  knownPathPrefix,
  ENDPOINTS,
  type EndpointFamily,
  type EndpointSpec,
} from './endpoints.js';
import { codecFor } from '@stackpanel/llm-protocol';
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from '@stackpanel/llm-protocol';
import {
  GatewayError,
  sendGatewayError,
  toGatewayError,
  redactSecrets,
  errorBody,
} from './errors.js';
import { resolveGatewayKey } from './auth.js';
import { Scheduler, LeaseKeeper, DEFAULT_LEASE_TTL_MS } from './scheduler.js';
import { pickAccount } from './routing.js';
import {
  clearAccountKeyCooldown,
  coolAccountKey,
  pickAccountKey,
  type AccountKey,
} from './account-keys.js';
import { resolveAdaptor, registerBuiltinAdaptors } from './adaptors/index.js';
import { signBedrockCall } from './adaptors/anthropic.js';
import type { AdaptorAccount, ProviderAdaptor, UpstreamCall } from './adaptors/types.js';
import {
  BackpressureWriter,
  fetchUpstream,
  isRetryableFailure,
  retryDelayMs,
  readResponseBody,
  sleep,
  UpstreamFailure,
  DEFAULT_CONNECT_TIMEOUT_MS,
} from './upstream.js';
import {
  estimateReserve,
  release,
  reserve,
  settle,
  type BillingContext,
  type SettleResult,
} from './billing.js';
import { checkQuota, recordQuotaTokens, releaseQuotaRequest, type QuotaRule } from './quota.js';
import {
  applyBodyRewrites,
  applyHeaderRewrites,
  mapStatus,
  rewriteConfigOf,
  traceOf,
} from './rewrite.js';
import { bestDiscountPercent, reservedOutputTokens, resolveServedPrice } from './pricing.js';
import { applyWindow } from './pricing-window.js';
import { resolveModelMap } from './model-map.js';
import { pickEntitlement, remainingOf } from './entitlements.js';
import { checkBudget, maybeWarnBudget, recordSpend, spendKey } from './limits.js';
import { OutputAccumulator, estimateUsage, resolveStreamUsage, toTokenUsage } from './metering.js';
import { Metrics, type RequestObservation } from './observability.js';
import {
  asNumber,
  isRecord,
  type IRRequest,
  type IRUsage,
  type Protocol,
} from '@stackpanel/llm-protocol';
import {
  addLegacyUsage,
  addPolicyUsage,
  getConfig,
  getSetting,
  listActiveAccounts,
  listEnabledPrices,
  listActiveEntitlements,
  listBudgetLimitsFor,
  listEnabledModelMaps,
  listPricesForModel,
  updateAccount,
  type AccountRow,
} from './repository.js';
import { DEFAULT_CONFIG } from './runtime.js';
import { scanRequest } from './sensitive.js';
import type { GatewayConfig, GatewayRuntime } from './runtime.js';

export type { GatewayRuntime } from './runtime.js';

/** 入口协议族（走 IR 编解码的对话类）。 */
const CHAT_FAMILIES: ReadonlySet<EndpointFamily> = new Set<EndpointFamily>([
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
]);

/** 错误响应体读取上限（仅用于分类；真实响应体走 config.maxResponseBytes）。 */
const ERROR_BODY_LIMIT = 1024 * 1024;

/** 读请求体的兜底上限（逐 endpoint 的 spec.bodyLimit 优先，均不超过它）。 */
const DEFAULT_REQUEST_LIMIT = 512 * 1024 * 1024;

/** 转发上游时剥离的 hop-by-hop / 鉴权头。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version',
]);

/** 纯统计列（账号 lastUsedAt）的刷新节流窗口。 */
const LAST_USED_THROTTLE_MS = 30_000;

/* ------------------------------ 小工具 ------------------------------ */

export async function readStream(stream: Readable, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > limit) {
      throw new GatewayError(413, 'payload_too_large', `请求体超过 ${limit} 字节上限`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function familyProtocol(family: EndpointFamily): Protocol | null {
  switch (family) {
    case 'openai-chat':
      return 'openai-chat';
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'gemini';
    default:
      return null;
  }
}

/**
 * 该 endpoint 走 IR（对话类）还是原样 operation 透传。
 *
 * `anthropic.count_tokens` 虽是 anthropic 族但不带 `operation`，语义上是「透传请求体
 * 到 `/v1/messages/count_tokens`」，不能走对话 IR 的 `/v1/messages` 路径。
 */
function chatProtocolFor(spec: EndpointSpec): Protocol | null {
  if (spec.operation !== undefined) return null;
  if (spec.id === 'anthropic.count_tokens') return null;
  if (!CHAT_FAMILIES.has(spec.family)) return null;
  return familyProtocol(spec.family);
}

/** 把 spec.path 里的 `:param` 段替换为实际值（`model` 用映射后的上游模型名）。 */
function buildSubPath(
  spec: EndpointSpec,
  params: Record<string, string>,
  upstreamModel: string,
): string {
  return spec.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const second = segment.indexOf(':', 1);
      if (second > 0) {
        // `:model:generateContent` → 参数名 + 字面后缀。
        const name = segment.slice(1, second);
        const suffix = segment.slice(second);
        const value = name === 'model' ? upstreamModel : (params[name] ?? '');
        return encodeURIComponent(value) + suffix;
      }
      const name = segment.slice(1);
      const value = name === 'model' ? upstreamModel : (params[name] ?? '');
      return encodeURIComponent(value);
    })
    .join('/');
}

function emptyIr(model: string, raw: unknown): IRRequest {
  return { model, messages: [], stream: false, raw };
}

/** 是否存在「另一方法」命中的同路径 endpoint（用于 405 判定）。 */
function methodMismatch(rest: string, method: string): boolean {
  for (const candidate of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'] as const) {
    if (candidate === method) continue;
    if (matchEndpoint(candidate, rest)) return true;
  }
  return false;
}

/** 客户端断开信号：由 `reply.onClientClose` 触发，向上游传播。 */
interface ClientSignal {
  signal: AbortSignal;
  get aborted(): boolean;
}

function clientSignalOf(reply: RawHttpReply): ClientSignal {
  const controller = new AbortController();
  let aborted = false;
  reply.onClientClose(() => {
    aborted = true;
    controller.abort(new Error('client disconnected'));
  });
  return {
    signal: controller.signal,
    get aborted() {
      return aborted;
    },
  };
}

function forwardResponseHeaders(upstream: Response, reply: RawHttpReply): void {
  const setCookies =
    typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') return;
    reply.header(name, value);
  });
  if (setCookies.length > 0) reply.header('set-cookie', setCookies);
}

function headersSent(reply: RawHttpReply): boolean {
  return (reply.raw as { headersSent?: boolean } | undefined)?.headersSent === true;
}

/** 上游错误：保留上游状态码（既有行为），消息/字段走脱敏后的稳定 schema。 */
function sendUpstreamError(reply: RawHttpReply, status: number, error: GatewayError): void {
  if (headersSent(reply)) {
    reply.end();
    return;
  }
  reply.status(status);
  reply.header('content-type', 'application/json; charset=utf-8');
  if (error.retryAfterSeconds !== null) {
    reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterSeconds))));
  }
  reply.end(
    JSON.stringify(
      errorBody(
        {
          message: redactSecrets(error.message),
          type: error.type,
          code: error.code,
          param: error.param,
        },
        status,
      ),
    ),
  );
}

function isJsonContentType(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function toAdaptorAccount(row: AccountRow, apiKey: string): AdaptorAccount {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey,
    options: row.options ?? {},
  };
}

/** 账号 `lastUsedAt` 节流刷新（纯统计，不参与路由）。 */
async function markAccountUsed(rt: GatewayRuntime, accountId: string): Promise<void> {
  const marker = `gw:acct:${accountId}:used`;
  const recorded = await rt.state.acquire(marker, LAST_USED_THROTTLE_MS).catch(() => null);
  if (!recorded) return;
  await updateAccount(accountId, {
    lastUsedAt: new Date().toISOString(),
  }).catch(() => null);
}

/**
 * 自动摘号判定（A7）：上游错误体/状态码命中配置时返回命中原因，否则 null。
 *
 * 关键词比较大小写无关；错误体已由调用方限制在 1MiB 内，不扫全量响应。
 */
function autoDisableHit(cfg: GatewayConfig, status: number, bodyText: string): string | null {
  if (cfg.autoDisableStatusCodes.includes(status)) return `HTTP ${status}`;
  const lower = bodyText.toLowerCase();
  for (const raw of cfg.autoDisableKeywords) {
    const keyword = raw.trim();
    if (keyword.length === 0) continue;
    if (lower.includes(keyword.toLowerCase())) return keyword.slice(0, 64);
  }
  return null;
}

/** key 级冷却时长：优先上游 Retry-After，否则一分钟（比账号熔断短得多）。 */
const DEFAULT_KEY_COOLDOWN_MS = 60_000;
function cooldownMsOf(retryAfterSeconds: number | null | undefined): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  return DEFAULT_KEY_COOLDOWN_MS;
}

/* ------------------------------ 主流程 ------------------------------ */

/** 构造 relay 处理器。runtime 缺失（插件未激活）时返回 503。 */
export function createRelayHandler(getRuntime: () => GatewayRuntime | null): RawRouteHandler {
  registerBuiltinAdaptors();

  return async (req: RawHttpRequest, reply: RawHttpReply): Promise<void> => {
    const startedAt = Date.now();
    let rt: GatewayRuntime;
    try {
      const resolved = getRuntime();
      if (!resolved) {
        sendGatewayError(reply, new GatewayError(503, 'upstream_unavailable', '网关未就绪'));
        return;
      }
      rt = resolved;
    } catch (error) {
      sendGatewayError(reply, toGatewayError(error));
      return;
    }

    const signal = clientSignalOf(reply);
    const metrics = new Metrics(rt.state, rt.logger);
    const obs: RequestObservation = {
      endpoint: 'unknown',
      protocol: 'openai-chat',
      model: '',
      latencyMs: 0,
      firstTokenMs: null,
      status: 200,
      retries: 0,
      accountId: null,
      stream: false,
      clientAborted: false,
      settled: true,
    };

    try {
      await handleRelay(rt, metrics, req, reply, signal, startedAt, obs);
    } catch (error) {
      const gw = toGatewayError(error);
      obs.status = gw.status;
      rt.logger.error(`llm-gateway: relay failed: ${redactSecrets(gw.message)}`);
      if (!headersSent(reply)) {
        sendGatewayError(reply, gw);
      } else {
        reply.end();
      }
    } finally {
      obs.latencyMs = Date.now() - startedAt;
      obs.clientAborted = signal.aborted;
      await metrics.observe(obs).catch(() => null);
    }
  };
}

async function handleRelay(
  rt: GatewayRuntime,
  metrics: Metrics,
  req: RawHttpRequest,
  reply: RawHttpReply,
  signal: ClientSignal,
  startedAt: number,
  obs: RequestObservation,
): Promise<void> {
  /* ---------------------------- 鉴权 ---------------------------- */
  const plaintext = extractApiKey(req.headers) ?? req.query.get('key')?.trim() ?? null;
  if (!plaintext) throw new GatewayError(401, 'invalid_api_key', '缺少 API key');
  // 查询串里的 key 只用于网关鉴权，转发上游前删掉（禁止把 key 拼进 URL）。
  req.query.delete('key');

  const resolved = await resolveGatewayKey(rt, plaintext, req.ip);
  if (!resolved.ok) {
    throw new GatewayError(resolved.status, resolved.code, resolved.message);
  }
  const key = resolved.key;

  if (key.quotaLimit !== null && key.quotaUsed >= key.quotaLimit) {
    // 热路径上每天最多提醒一次（见 notifyQuotaExhausted），不 await 结果也不阻塞拒绝。
    await notifyQuotaExhausted({
      userId: key.userId,
      keyName: key.name,
      quotaLimit: key.quotaLimit,
      quotaUsed: key.quotaUsed,
    });
    throw new GatewayError(402, 'quota_exceeded', '额度已用尽');
  }

  const setting = await getSetting(key.userId).catch(() => null);
  if (!setting?.billingEnabled) {
    throw new GatewayError(403, 'billing_disabled', 'API 计费未开启，请先在账户中心开启');
  }

  /* ---------------------------- endpoint 匹配 ---------------------------- */
  const rest = req.params['*'] ?? '';
  const match = matchEndpoint(req.method, rest);
  if (!match) {
    if (methodMismatch(rest, req.method)) {
      throw new GatewayError(405, 'method_not_allowed', `该路径不支持 ${req.method} 方法`);
    }
    throw new GatewayError(
      404,
      'endpoint_not_found',
      knownPathPrefix(rest) ? '接口不存在' : '路径不存在',
    );
  }
  const spec = match.spec;
  const params = match.params;
  obs.endpoint = spec.id;

  if (spec.status === 'unsupported') {
    throw new GatewayError(501, 'unsupported_endpoint', spec.note ?? '该接口本期未实现');
  }
  if (spec.status === 'reserved') {
    throw new GatewayError(404, 'endpoint_not_found', spec.note ?? '接口未开放');
  }

  const cfg = await loadConfig();

  /* ---------------------------- 模型发现（本地） ---------------------------- */
  if (spec.family === 'meta') {
    await handleMetaEndpoint(key, spec, params, reply);
    obs.status = 200;
    return;
  }

  const chatProtocol = chatProtocolFor(spec);
  const chat = chatProtocol !== null;
  const logProtocol = chatProtocol ?? spec.family;
  obs.protocol = logProtocol;

  /* ---------------------------- 读取请求体 ---------------------------- */
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const bodyKind = spec.bodyKind;
  const bodyLimit = spec.bodyLimit ?? DEFAULT_REQUEST_LIMIT;
  const rawBody =
    hasBody && bodyKind !== 'none' ? await readStream(req.body, bodyLimit) : new Uint8Array(0);
  const requestBodyText = rawBody.byteLength > 0 ? Buffer.from(rawBody).toString('utf8') : '';
  const contentType = firstHeader(req.headers['content-type']) ?? '';
  // 对二进制/多部分请求体，保留原始头以便透传（json 走 JSON 序列化）。
  const passThroughContentType = bodyKind === 'json' ? 'application/json' : contentType;

  let bodyJson: unknown = null;
  if (bodyKind === 'json' && requestBodyText.length > 0) {
    try {
      bodyJson = JSON.parse(requestBodyText);
    } catch {
      throw new GatewayError(400, 'invalid_json', '请求体不是合法 JSON');
    }
  }

  /* ---------------------------- 解析模型与协议 ---------------------------- */
  let ir: IRRequest | null = null;
  let model = '';
  let wantsStream = false;

  if (chat && chatProtocol) {
    const ingressCodec = codecFor(chatProtocol);
    try {
      ir = ingressCodec.decodeRequest(bodyJson);
    } catch {
      throw new GatewayError(400, 'invalid_request', '请求体无法解析');
    }
    if (!ir.model && typeof params['model'] === 'string') ir.model = params['model'];
    // Gemini 的流式由路径 action 决定（body 里没有 stream 字段）。
    if (spec.responseKind === 'sse') ir.stream = true;
    model = ir.model;
    wantsStream = ir.stream;
    if (!model) throw new GatewayError(400, 'missing_model', '请求缺少 model');
  } else {
    model = operationModel(spec, params, bodyJson);
    wantsStream = false;
  }
  obs.model = model;
  obs.stream = wantsStream;

  /**
   * 敏感词过滤（D2）。
   *
   * 位置很关键：在**预留资金之前**、在选号之前。命中即拒的请求不冻结、不扣费、
   * 不写用量流水——如果放在扣费之后，被拒的请求会留下一笔"已冻结待结算"的
   * 悬空账，还得靠补偿队列收拾。
   *
   * 只扫描文本片段（system + 各消息的 text），图片/工具参数不解析：合规要求
   * 通常针对文案，而扫描二进制既无意义又慢。
   */
  if (ir && cfg.sensitiveWords.length > 0) {
    const scan = scanRequest(ir, cfg.sensitiveWords);
    if (scan && scan.hits.length > 0) {
      const action = cfg.sensitiveWordAction === 'log' ? 'log' : 'block';
      await auditSensitiveHit(rt, {
        apiKeyId: key.id,
        userId: key.userId,
        hits: scan.hits,
        action,
        model,
        endpoint: spec.id,
        clientIp: req.ip ?? null,
        scannedChars: scan.scannedChars,
      });
      if (action === 'block') {
        // 不回显命中的词：把词表回给调用方，等于附送一份规避指南。
        throw new GatewayError(
          400,
          'sensitive_content',
          `请求内容命中 ${scan.hits.length} 条内容策略`,
        );
      }
    }
  }

  const allowedModels = key.models;
  if (model && allowedModels.length > 0 && !allowedModels.includes(model)) {
    throw new GatewayError(403, 'model_not_allowed', `模型 ${model} 不在该 key 的允许范围内`);
  }

  const served = applyWindow(
    resolveServedPrice(await listPricesForModel(model), model),
    new Date(),
  );
  /**
   * 上游模型名（B4）：定价行写死的 `upstreamModel` 最优先（管理员对一个模型
   * 的明确绑定）；没写死时才查映射表（一对多/前缀/正则/灰度）。
   */
  const boundUpstream = model ? served.upstreamModel : model;
  const mapped =
    model && boundUpstream === model
      ? resolveModelMap(await listEnabledModelMaps().catch(() => []), model)
      : null;
  const upstreamModel = mapped ? mapped.model : boundUpstream;

  /**
   * 权限组折扣（A4）：与内核商店同一口径，取用户各组中的最大折扣。
   * 读不到组（auth 故障 / 用户已被删）按 0 处理：不折扣但照常服务——
   * 宁可少收一次折扣差价，也不因读组失败把请求打死。
   */
  const groups =
    served.groupDiscount === false ? [] : await rt.auth.listUserGroups(key.userId).catch(() => []);
  const discountPercent = bestDiscountPercent(groups);

  /* ---------------------------- 限流与并发 ---------------------------- */
  const scheduler = new Scheduler(rt.state);
  const admission = {
    keyId: key.id,
    userId: key.userId,
    model,
    provider: null as string | null,
    keyRpm: key.rpmLimit,
    keyConcurrency: key.concurrencyLimit,
    userRpm: cfg.userRpm,
    modelRpm: cfg.modelRpm,
    providerRpm: cfg.providerRpm,
    globalConcurrency: cfg.globalConcurrency,
  };
  const rpm = await scheduler.checkRpm(admission);
  if (!rpm.ok) {
    throw new GatewayError(rpm.status, rpm.code, rpm.message, {
      retryAfterSeconds: rpm.retryAfterSeconds ?? null,
    });
  }
  /**
   * 长周期配额（P1）：每 N 小时 X 次 / Y token。与 RPM 分开检查——RPM 挡瞬时
   * 突发，配额管长期公平分配（「零元模型每 6 小时 100 次」）。
   *
   * 次数在准入时**原子占用**（`incr` 后超限则回滚），所以并发请求不会一起放行。
   * token 只能读到已用量：请求还没跑，真实 token 数不存在。
   */
  const quota = await checkQuota({
    rule: quotaRuleOf(key),
    keyId: key.id,
    userId: key.userId,
  });
  if (!quota.allowed) {
    const used = quota.used ?? 0;
    const limit = quota.limit ?? 0;
    const isRequests = (quota.rule?.maxRequests ?? 0) > 0 && limit === quota.rule?.maxRequests;
    throw new GatewayError(
      429,
      'quota_exceeded',
      isRequests
        ? `请求配额已用尽（${used}/${limit} 次每 ${quota.rule?.windowHours ?? 0} 小时）`
        : `Token 配额已用尽（${used}/${limit} 个每 ${quota.rule?.windowHours ?? 0} 小时）`,
      { retryAfterSeconds: quota.retryAfterSeconds ?? null },
    );
  }

  const concurrency = await scheduler.checkConcurrency(admission);
  if (!concurrency.ok) {
    await releaseQuotaRequest(quota);
    throw new GatewayError(concurrency.status, concurrency.code, concurrency.message, {
      retryAfterSeconds: concurrency.retryAfterSeconds ?? null,
    });
  }
  const keyLeases: StateLease[] = [...concurrency.leases];

  /**
   * 预算限额（B3）：在预授权之前判，避免为一个注定被拒的请求冻结资金。
   *
   * 日/月两档都要判——限额按周期分别配置，只判 `cfg.budgetPeriod` 会让
   * 「配了日限、默认周期是月」的组合形同虚设。计数器读失败时 fail-open
   * （限额是止损工具，不是资金安全边界）。
   */
  const budgetLimits = await listBudgetLimitsFor(key.userId).catch(() => []);
  const budgetChecks = await Promise.all(
    (['day', 'month'] as const).map((period) => checkBudget(budgetLimits, key.userId, period)),
  );
  const blocked = budgetChecks.find((check) => !check.allowed);
  if (blocked) {
    await releaseLeases(rt, keyLeases);
    throw new GatewayError(402, 'budget_exceeded', blocked.message ?? '额度已用尽');
  }

  /* ---------------------------- 预授权 ---------------------------- */
  const walletAccount = await rt.wallet.getAccount(key.userId).catch(() => null);
  const currency = walletAccount?.currency ?? 'CNY';

  const reserveAmount = estimateReserve({
    price: served,
    bodyText: requestBodyText,
    // 客户端没给输出上限时用模型自己声明的上限（A8），再没有才用全局默认。
    maxTokens: ir?.maxTokens ?? (reservedOutputTokens(served) || undefined),
    ...nonTokenEstimate(spec, bodyJson, requestBodyText),
  });

  /**
   * 套餐权益（B1）：有可用权益时，被覆盖的部分不冻结钱包——套餐用户没有
   * 钱包余额也应该能调用（这正是「买了套餐」的含义）。
   */
  const entitlement = await pickEntitlement(
    await listActiveEntitlements(key.userId).catch(() => []),
    model,
  );
  const coveredAmount = entitlement ? Math.min(reserveAmount, remainingOf(entitlement)) : 0;
  const walletNeed = reserveAmount - coveredAmount;
  if (walletNeed > 0 && (!walletAccount || walletAccount.balance <= 0)) {
    await releaseLeases(rt, keyLeases);
    throw new GatewayError(402, 'insufficient_balance', '余额不足，请先充值');
  }

  let billing: BillingContext;
  try {
    billing = await reserve({
      wallet: rt.wallet,
      logger: rt.logger,
      userId: key.userId,
      apiKeyId: key.id,
      accountId: null,
      model,
      currency,
      price: served,
      amount: reserveAmount,
      // 文案要写得能当**最终账单**看：内核 `settleHold` 不接受 note 参数，
      // 结算不会改写这条备注，所以用户钱包里看到的永远是这里写下的文字。
      // 之前写「预授权」，结算后账单上显示「mock-gpt-4 预授权 -1」，
      // 看起来像一笔冻结而不是一次消费。
      note: `${model || 'unknown'} 模型调用`,
      ttlMs: cfg.holdTtlMs,
      discountPercent,
      entitlementId: entitlement?.id ?? null,
      coveredAmount,
    });
  } catch (error) {
    await releaseLeases(rt, keyLeases);
    if (isWalletError(error) && error.code === 'wallet.insufficient_balance') {
      throw new GatewayError(402, 'insufficient_balance', '余额不足，请先充值');
    }
    rt.logger.error(
      `llm-gateway: reserve failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    throw new GatewayError(502, 'preauth_failed', '预授权失败');
  }

  /* ---------------------------- 选号 + 转发 ---------------------------- */
  let accountLease: StateLease | null = null;
  let billingDone = false;
  const affinity = firstHeader(req.headers['x-gateway-affinity']) ?? '';
  const query = new URLSearchParams(req.query);

  try {
    interface Selected {
      row: AccountRow;
      adaptor: ProviderAdaptor;
      /** 本次尝试使用的上游 key（账号多 Key，A1）。 */
      key: AccountKey;
      account: AdaptorAccount;
      lease: StateLease;
    }

    /** 本次请求中已经失败过（或 key 全部在冷却）的账号；跨重试累积。 */
    const excludedAccounts = new Set<string>();
    /** 当前账号里已经试过的 key id；换账号时重置。 */
    const triedKeyIds = new Set<string>();

    const selectAccount = async (): Promise<Selected | null> => {
      // 有界循环：每次跳过一个「没有可用 key / 凭证缺失」的账号，而不是
      // 当场 502（多 key 账号的价值就在这里）。
      for (let guard = 0; guard < 32; guard += 1) {
        const picked = await pickAccount({
          model,
          ingress: chatProtocol ?? 'openai-chat',
          affinity,
          upstreamModel,
          scheduler,
          excludeAccountIds: excludedAccounts,
        });
        if (!picked) return null;
        const adaptor = resolveAdaptor(picked.account.provider);
        if (!adaptor) {
          await scheduler.releaseAccountLease(picked.lease).catch(() => false);
          throw new GatewayError(
            502,
            'bad_upstream',
            `账号 provider 未注册：${redactSecrets(picked.account.provider)}`,
          );
        }
        if (spec.operation && !adaptor.capabilities.operations.includes(spec.operation)) {
          await scheduler.releaseAccountLease(picked.lease).catch(() => false);
          throw new GatewayError(
            502,
            'upstream_model_unsupported',
            `该上游账号不支持 ${spec.operation}`,
          );
        }
        // 账号内 key 选择（A1）：该账号的 key 全部在冷却时跳过该账号，继续找下一个。
        const key = await pickAccountKey(rt.state, picked.account, triedKeyIds);
        if (!key) {
          await scheduler.releaseAccountLease(picked.lease).catch(() => false);
          excludedAccounts.add(picked.account.id);
          void metrics.bump('account.key_exhausted').catch(() => null);
          continue;
        }
        const secret = await rt.secrets.get(key.apiKeyRef).catch(() => null);
        if (!secret) {
          await scheduler.releaseAccountLease(picked.lease).catch(() => false);
          excludedAccounts.add(picked.account.id);
          rt.logger.warn(
            `llm-gateway: account ${picked.account.id} key ${key.id} 凭证缺失，已跳过`,
          );
          continue;
        }
        triedKeyIds.add(key.id);
        return {
          row: picked.account,
          adaptor,
          key,
          account: toAdaptorAccount(picked.account, secret),
          lease: picked.lease,
        };
      }
      return null;
    };

    // C4 改写痕迹在一次请求内累计（跨重试 / 换 key / 换号），最后随流水落库。
    const rewriteTraces: string[] = [];

    const buildCall = async (selected: Selected): Promise<UpstreamCall> => {
      const prepared = await prepareCall(
        selected.adaptor,
        selected.account,
        buildUpstreamCall({
          account: selected.account,
          adaptor: selected.adaptor,
          spec,
          params,
          query,
          ir,
          bodyJson,
          rawBody,
          contentType: passThroughContentType,
          ingressProtocol: chatProtocol ?? 'openai-chat',
          upstreamModel,
          stream: wantsStream,
          chat,
        }),
      );
      const rewritten = applyRewrites(prepared, selected.row, rewriteTraces);
      billing.rewrites = traceOf(rewriteTraces);
      return rewritten;
    };

    let selected = await selectAccount();
    if (!selected) throw new GatewayError(502, 'no_upstream', '暂无可用上游账号');
    accountLease = selected.lease;
    obs.accountId = selected.row.id;
    // 台账在选号**之前**建立（顺序纪律），因此这里必须把真实账号回填进计费
    // 上下文，否则 settle 写出的 usage log 永远 accountId=null，丢失按账号归因。
    billing.accountId = selected.row.id;
    billing.upstreamKeyId = selected.key.id;
    billing.upstreamModel = upstreamModel;

    let call = await buildCall(selected);
    if (!isAllowedUpstreamUrl(call.url)) {
      throw new GatewayError(400, 'invalid_upstream', '上游地址必须为公网地址');
    }

    // 429 时按 provider 维度记账（provider 从首个账号解析出来后才有值）。
    admission.provider = selected.row.provider;
    // provider / 账号级 RPM 只能在这里查：选号之前不知道 provider，也不知道
    // 选中了哪个账号。超限则拒绝并释放预留/租约（由 finally 统一归还）。
    const providerRpm = await scheduler.checkProviderRpm(selected.row.provider, cfg.providerRpm);
    if (!providerRpm.ok) {
      throw new GatewayError(providerRpm.status, providerRpm.code, providerRpm.message, {
        retryAfterSeconds: providerRpm.retryAfterSeconds ?? null,
      });
    }
    const accountRpm = await scheduler.checkAccountRpm(selected.row.id, selected.row.rpmLimit);
    if (!accountRpm.ok) {
      throw new GatewayError(accountRpm.status, accountRpm.code, accountRpm.message, {
        retryAfterSeconds: accountRpm.retryAfterSeconds ?? null,
      });
    }

    const rotate = async (): Promise<boolean> => {
      // 1) 同账号换 key（A1）：比换号便宜，也保留亲和/优先级选择结果。
      const current = selected;
      if (current) {
        const nextKey = await pickAccountKey(rt.state, current.row, triedKeyIds);
        if (nextKey) {
          const secret = await rt.secrets.get(nextKey.apiKeyRef).catch(() => null);
          if (secret) {
            triedKeyIds.add(nextKey.id);
            selected = {
              ...current,
              key: nextKey,
              account: toAdaptorAccount(current.row, secret),
            };
            billing.upstreamKeyId = nextKey.id;
            call = await buildCall(selected);
            void metrics.bump('upstream.key_rotate').catch(() => null);
            return isAllowedUpstreamUrl(call.url);
          }
        }
      }
      // 2) 换账号：把刚才失败的账号排到本次请求之外，避免立刻重选到同一个。
      if (current) excludedAccounts.add(current.row.id);
      if (accountLease) {
        await scheduler.releaseAccountLease(accountLease).catch(() => false);
        accountLease = null;
      }
      const next = await selectAccount();
      if (!next) return false;
      triedKeyIds.clear();
      triedKeyIds.add(next.key.id);
      accountLease = next.lease;
      selected = next;
      obs.accountId = next.row.id;
      billing.accountId = next.row.id;
      billing.upstreamKeyId = next.key.id;
      call = await buildCall(next);
      // 记账一次账号切换，供管理端看板观察池内降级频率。
      void metrics.bump('account.failover').catch(() => null);
      return isAllowedUpstreamUrl(call.url);
    };

    const maxAttempts = Math.max(1, cfg.retryAttempts);
    let response: Response | null = null;
    /** 对客户端/分类使用的状态码（应用 C4 映射后）。 */
    let httpStatus = 0;
    let upstreamError: { status: number; error: GatewayError } | null = null;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const fetched = await fetchUpstream(call, {
          clientSignal: signal.signal,
          timeouts: { connectMs: DEFAULT_CONNECT_TIMEOUT_MS },
        });
        response = fetched.response;
        // 先落真实上游状态码，再做映射。漏掉这一步会让 `mapStatus` 拿到初始值 0，
        // 于是所有成功请求的用量流水 httpStatus 都是 0（对账时无法区分 200/201）。
        httpStatus = response.status;
        /**
         * 上游状态码映射（C4）：有的厂商用 529/499 之类自定义码，有的用 200 包
         * 错误体。映射后的状态码参与分类、自动摘号、重试与对客户端返回，全程一致。
         */
        const mappedStatus = mapStatus(httpStatus, rewriteConfigOf(selected.row.rewrites));
        httpStatus = mappedStatus ? mappedStatus.status : httpStatus;
        if (mappedStatus) {
          rewriteTraces.push(mappedStatus.trace);
          billing.rewrites = traceOf(rewriteTraces);
          void metrics.bump('upstream.status_mapped').catch(() => null);
        }
      } catch (error) {
        const failure =
          error instanceof UpstreamFailure ? error : new UpstreamFailure('network', String(error));
        if (failure.kind === 'client_aborted' || signal.aborted) {
          obs.clientAborted = true;
          throw new GatewayError(499, 'invalid_request', '客户端已断开');
        }
        await scheduler.recordFailure(selected.row.id, failure.message, {
          retryable: isRetryableFailure(failure.kind, failure.status),
          retryAfterSeconds: failure.retryAfterSeconds,
        });
        // key 级冷却（A1）：网络/超时先把这把 key 歇一会，下一次尝试优先后其它 key。
        await coolAccountKey(
          rt.state,
          selected.row.id,
          selected.key.id,
          cooldownMsOf(failure.retryAfterSeconds),
          failure.message,
        );
        obs.retries += 1;
        if (attempt >= maxAttempts || !isRetryableFailure(failure.kind, failure.status)) {
          if (failure.kind === 'timeout') {
            void metrics.bump('upstream.timeout').catch(() => null);
            throw new GatewayError(504, 'upstream_timeout', '上游超时', {
              retryable: true,
            });
          }
          throw new GatewayError(502, 'upstream_error', '上游请求失败', {
            retryable: true,
          });
        }
        await sleep(retryDelayMs(attempt, undefined, failure.retryAfterSeconds), signal.signal);
        if (!(await rotate())) {
          throw new GatewayError(502, 'no_upstream', '暂无可用上游账号');
        }
        continue;
      }

      if (httpStatus >= 400) {
        const bodyBytes = await readResponseBody(response, ERROR_BODY_LIMIT).catch(
          () => new Uint8Array(0),
        );
        const bodyText = Buffer.from(bodyBytes).toString('utf8');
        const classified = selected.adaptor.classifyError({
          status: httpStatus,
          bodyText,
          headers: response.headers,
        });
        const retryable = selected.adaptor.isRetryable(classified, httpStatus);
        // 关键词/状态码自动摘号（A7）：命中说明重试这个账号毫无意义，冷却整号。
        const disabledBy = autoDisableHit(cfg, httpStatus, bodyText);
        // 仅对 429/408 施加账号级冷却：5xx 在请求内重试即可，避免瞬时 5xx 把整个账号池冷却。
        const penalize = retryable && (httpStatus === 429 || httpStatus === 408);
        const disableCooldownSeconds = Math.max(1, Math.ceil(cfg.autoDisableCooldownMs / 1000));
        await scheduler.recordFailure(selected.row.id, classified.message, {
          retryable: penalize || disabledBy !== null,
          retryAfterSeconds:
            disabledBy !== null ? disableCooldownSeconds : classified.retryAfterSeconds,
        });
        if (disabledBy !== null) {
          void metrics.bump('account.auto_disabled').catch(() => null);
          await updateAccount(selected.row.id, {
            lastError: `${httpStatus} ${disabledBy}`.slice(0, 200),
            lastErrorAt: new Date().toISOString(),
          }).catch(() => undefined);
        }
        // key 级冷却：限流/封禁类先把这把 key 歇掉，重试时优先后同账号其它 key。
        if (penalize || disabledBy !== null) {
          await coolAccountKey(
            rt.state,
            selected.row.id,
            selected.key.id,
            disabledBy !== null
              ? Math.max(1000, cfg.autoDisableCooldownMs)
              : cooldownMsOf(classified.retryAfterSeconds),
            classified.message,
          );
        }
        if (retryable && attempt < maxAttempts) {
          obs.retries += 1;
          await sleep(
            retryDelayMs(attempt, undefined, classified.retryAfterSeconds),
            signal.signal,
          );
          if (!(await rotate())) {
            upstreamError = { status: httpStatus, error: classified };
            break;
          }
          continue;
        }
        upstreamError = { status: httpStatus, error: classified };
        break;
      }

      await scheduler.recordSuccess(selected.row.id).catch(() => undefined);
      await clearAccountKeyCooldown(rt.state, selected.row.id, selected.key.id).catch(
        () => undefined,
      );
      break;
    }

    if (!response) {
      throw new GatewayError(502, 'upstream_error', '上游请求失败');
    }

    // 上游 429/5xx 走尽重试后仍失败：按分类错误返回（保留上游状态码）。
    if (upstreamError && httpStatus >= 400) {
      const result = await settleFailure(rt, metrics, billing, {
        protocol: logProtocol,
        endpoint: spec.id,
        status: 'ERROR',
        httpStatus: upstreamError.status,
        latencyMs: Date.now() - startedAt,
        clientIp: req.ip,
        error: upstreamError.error.message,
      });
      billingDone = true;
      await afterSettle(rt, key, result, selected.row.id);
      obs.status = upstreamError.status;
      obs.settled = result.settled;
      sendUpstreamError(reply, upstreamError.status, upstreamError.error);
      return;
    }

    /* ---------------------------- 成功：流式或缓冲 ---------------------------- */
    const upstreamContentType = response.headers.get('content-type') ?? '';
    const isEventStream = upstreamContentType.includes('text/event-stream');

    if (isEventStream) {
      const relayed = await relayStream({
        rt,
        metrics,
        reply,
        response,
        adaptor: selected.adaptor,
        ingressCodec: chat && chatProtocol ? codecFor(chatProtocol) : null,
        passthrough: !chat || selected.adaptor.protocol === chatProtocol,
        model,
        startedAt,
        accountLease,
        keyLeases,
        signal,
      });
      obs.firstTokenMs = relayed.firstTokenMs;
      obs.clientAborted = relayed.clientAborted;
      const { usage, estimated } = resolveStreamUsage(
        relayed.usage,
        relayed.outputText,
        requestBodyText,
      );
      const result = await settleUsage(rt, metrics, billing, {
        usage,
        estimated,
        protocol: logProtocol,
        endpoint: spec.id,
        status: relayed.clientAborted ? 'CANCELLED' : 'SUCCESS',
        httpStatus: httpStatus,
        latencyMs: Date.now() - startedAt,
        stream: true,
        firstTokenMs: relayed.firstTokenMs,
        clientIp: req.ip,
        outputText: relayed.outputText,
        aborted: relayed.clientAborted,
      });
      relayed.finish();
      billingDone = true;
      await afterSettle(rt, key, result, selected.row.id);
      obs.settled = result.settled;
      obs.status = 200;
      return;
    }

    if (spec.responseKind === 'binary' || (!isJsonContentType(upstreamContentType) && !chat)) {
      const relayed = await relayBinary(reply, response, signal);
      obs.clientAborted = relayed.clientAborted;
      const result = await settleUsage(rt, metrics, billing, {
        usage: operationUsage(spec, bodyJson, '', requestBodyText, null).usage,
        estimated: true,
        protocol: logProtocol,
        endpoint: spec.id,
        status: relayed.clientAborted ? 'CANCELLED' : 'SUCCESS',
        httpStatus: httpStatus,
        latencyMs: Date.now() - startedAt,
        clientIp: req.ip,
        aborted: relayed.clientAborted,
      });
      relayed.finish();
      billingDone = true;
      await afterSettle(rt, key, result, selected.row.id);
      obs.settled = result.settled;
      obs.status = 200;
      return;
    }

    const bodyBytes = await readResponseBody(response, cfg.maxResponseBytes).catch(
      (error: unknown) => {
        // 超限 / 读取中断属于**上游**问题，必须归到稳定 502，而不是让
        // `toGatewayError` 兜成 500 internal_error（那会误导客户端重试策略）。
        throw new GatewayError(
          502,
          'upstream_error',
          error instanceof Error
            ? `上游响应读取失败：${redactSecrets(error.message)}`
            : '上游响应读取失败',
          { retryable: true },
        );
      },
    );
    const rawText = Buffer.from(bodyBytes).toString('utf8');

    if (chat && chatProtocol) {
      const rendered = await relayChatBuffered({
        reply,
        response,
        rawText,
        ingressProtocol: chatProtocol,
        ingressCodec: codecFor(chatProtocol),
        upstreamCodec: codecFor(selected.adaptor.protocol),
        passthrough: selected.adaptor.protocol === chatProtocol,
        model,
      });
      const usage = chatUsage(selected.adaptor, rawText, requestBodyText);
      const result = await settleUsage(rt, metrics, billing, {
        usage: usage.usage,
        estimated: usage.estimated,
        protocol: logProtocol,
        endpoint: spec.id,
        status: 'SUCCESS',
        httpStatus: httpStatus,
        latencyMs: Date.now() - startedAt,
        stream: false,
        clientIp: req.ip,
      });
      billingDone = true;
      await afterSettle(rt, key, result, selected.row.id);
      obs.settled = result.settled;
      obs.status = 200;
      reply.header('x-stackpanel-charge-minor', String(result.amount));
      reply.end(rendered);
      return;
    }

    // operation 非流式：原样透传 + 计量。
    const usage = operationUsage(spec, bodyJson, rawText, requestBodyText, selected.adaptor);
    const result = await settleUsage(rt, metrics, billing, {
      usage: usage.usage,
      estimated: usage.estimated,
      protocol: logProtocol,
      endpoint: spec.id,
      status: 'SUCCESS',
      httpStatus: httpStatus,
      latencyMs: Date.now() - startedAt,
      stream: false,
      clientIp: req.ip,
    });
    billingDone = true;
    await afterSettle(rt, key, result, selected.row.id);
    obs.settled = result.settled;
    obs.status = 200;
    reply.status(httpStatus);
    forwardResponseHeaders(response, reply);
    if (!upstreamContentType) reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(rawText);
  } finally {
    if (accountLease) await rt.state.releaseLease(accountLease).catch(() => false);
    await releaseLeases(rt, keyLeases);
    if (!billingDone) {
      // 请求没走到结算：把准入时占用的配额次数退还。免费额度的语义是「成功
      // 用到的次数」，让上游故障吃掉用户额度会引发成片投诉。
      await releaseQuotaRequest(quota).catch(() => undefined);
      await release(rt.wallet, rt.logger, billing).catch((error: unknown) => {
        rt.logger.warn(
          `llm-gateway: release after failure failed: ${redactSecrets(String(error))}`,
        );
      });
    }
  }
}

async function loadConfig(): Promise<GatewayConfig> {
  // 单一默认值源：只写在 `runtime.DEFAULT_CONFIG`，避免两处漂移
  //（每加一个配置项都踩过一次「这里忘了补」）。
  const config = await getConfig().catch(() => null);
  return config ?? { ...DEFAULT_CONFIG };
}

/* ------------------------------ 上游调用构造 ------------------------------ */

interface BuildCallInput {
  account: AdaptorAccount;
  adaptor: ProviderAdaptor;
  spec: EndpointSpec;
  params: Record<string, string>;
  query: URLSearchParams;
  ir: IRRequest | null;
  bodyJson: unknown;
  rawBody: Uint8Array;
  contentType: string;
  ingressProtocol: Protocol;
  upstreamModel: string;
  stream: boolean;
  chat: boolean;
}

function buildUpstreamCall(input: BuildCallInput): UpstreamCall {
  const { account, adaptor, spec, params, query, ir, bodyJson, rawBody, contentType } = input;

  if (input.chat) {
    const upstreamCodec = codecFor(adaptor.protocol);
    const passthrough = adaptor.protocol === input.ingressProtocol;
    const workingIr: IRRequest = ir ?? emptyIr(input.upstreamModel, bodyJson);
    workingIr.model = input.upstreamModel;

    let body: unknown;
    if (passthrough && isRecord(bodyJson)) {
      const clone: Record<string, unknown> = { ...bodyJson };
      if (input.upstreamModel && adaptor.protocol !== 'gemini') {
        clone['model'] = input.upstreamModel;
      }
      // Mistral 等对未知 stream_options 报 400：只有声明支持该能力的协议才注入。
      if (
        adaptor.capabilities.streamUsage &&
        input.stream &&
        clone['stream_options'] === undefined
      ) {
        clone['stream_options'] = { include_usage: true };
      }
      body = clone;
    } else {
      body = upstreamCodec.encodeRequest(workingIr);
    }
    const subPath = upstreamCodec.requestPath(workingIr, input.stream);
    return adaptor.buildRequest({
      account,
      body,
      subPath,
      query,
      stream: input.stream,
      ir: workingIr,
    });
  }

  // operation（非对话）：原样透传，仅做端点/鉴权/路径/方法构造。
  const subPath = buildSubPath(spec, params, input.upstreamModel);
  const bodyKind = spec.bodyKind;
  const base = adaptor.buildRequest({
    account,
    body: bodyKind === 'json' ? bodyJson : '',
    subPath,
    query,
    stream: false,
    ir: emptyIr(input.upstreamModel, bodyJson),
  });
  const result: UpstreamCall = { ...base, method: spec.method };
  if (bodyKind === 'none') {
    delete result.body;
    const headers = { ...result.headers };
    delete headers['content-type'];
    result.headers = headers;
  } else if (bodyKind !== 'json') {
    result.body = rawBody;
    result.headers = {
      ...result.headers,
      'content-type': contentType || 'application/octet-stream',
    };
  }
  return result;
}

/** 对有自定义签名（Bedrock SigV4）的 adaptor 在发起前补签名头。 */
export async function prepareCall(
  adaptor: ProviderAdaptor,
  account: AdaptorAccount,
  call: UpstreamCall,
): Promise<UpstreamCall> {
  if (!adaptor.capabilities.customSigning) return call;
  const headers = await signBedrockCall(account, call);
  return { ...call, headers: { ...call.headers, ...headers } };
}

/**
 * 敏感词命中的审计（D2）。
 *
 * 记**命中的词**（管理员自己配的，不是用户内容）与规模，不记请求正文：
 * 审计日志不是内容存档，存全文既无必要也多一处泄露面。
 */
async function auditSensitiveHit(
  rt: GatewayRuntime,
  input: {
    apiKeyId: string;
    userId: string;
    hits: string[];
    action: string;
    model: string;
    endpoint: string;
    clientIp: string | null;
    scannedChars: number;
  },
): Promise<void> {
  await rt.auth
    .audit({
      action: 'llm-gateway.sensitive_content',
      resource: 'gateway-request',
      resourceId: input.apiKeyId,
      actorId: input.userId,
      ...(input.clientIp ? { ip: input.clientIp } : {}),
      meta: {
        hits: input.hits.slice(0, 20),
        hitCount: input.hits.length,
        decision: input.action,
        model: input.model,
        endpoint: input.endpoint,
        scannedChars: input.scannedChars,
      },
    })
    .catch(() => undefined);
}

/**
 * 账号级参数/头改写（C4）。**默认关闭**：账号没开 `rewrites.enabled` 时原样返回。
 *
 * 之所以在这一层做：`buildUpstreamCall` 之后、`fetchUpstream` 之前是唯一
 * 「已经知道打给哪个账号、请求体已经定型、但还没发出去」的时刻。放在更前面
 * 会被 adaptor 覆盖，放在更后面就来不及了。
 *
 * 请求体只在 `content-type: json` 时解析改写——multipart/二进制（音频、文件上传）
 * 必须原样透传，解析一次就等于把它们弄坏。
 */
function applyRewrites(call: UpstreamCall, row: AccountRow, traces: string[]): UpstreamCall {
  const config = rewriteConfigOf(row.rewrites);
  if (!config) return call;

  const headers = applyHeaderRewrites(call.headers, config);
  const applied = [...headers.applied];
  let body = call.body;
  const contentType = headers.value['content-type'] ?? '';
  if (typeof body === 'string' && body.length > 0 && isJsonContentType(contentType)) {
    try {
      const parsed: unknown = JSON.parse(body);
      const rewritten = applyBodyRewrites(parsed, config);
      if (rewritten.applied.length > 0) {
        body = JSON.stringify(rewritten.value);
        applied.push(...rewritten.applied);
      }
    } catch {
      // 声明 JSON 但解析不了：不改写，交给上游按原样拒绝（错误信息更真实）。
    }
  }

  if (applied.length === 0) return call;
  for (const trace of applied) traces.push(trace);
  return { ...call, headers: headers.value, ...(body === undefined ? {} : { body }) };
}

/* ------------------------------ 流式转发 ------------------------------ */

interface StreamContext {
  rt: GatewayRuntime;
  metrics: Metrics;
  reply: RawHttpReply;
  response: Response;
  adaptor: ProviderAdaptor;
  ingressCodec: ProtocolCodec | null;
  passthrough: boolean;
  model: string;
  startedAt: number;
  accountLease: StateLease | null;
  keyLeases: StateLease[];
  signal: ClientSignal;
}

interface StreamedResult {
  usage: IRUsage | null;
  outputText: string;
  firstTokenMs: number | null;
  clientAborted: boolean;
  /** 流结束后才调用：把响应 `end()`（计费已落库后再收尾）。 */
  finish: () => void;
}

async function relayStream(ctx: StreamContext): Promise<StreamedResult> {
  const { response, reply, adaptor, ingressCodec, passthrough, metrics } = ctx;
  const upstreamCodec = codecFor(adaptor.protocol);
  const decoder: StreamDecoder =
    adaptor.createStreamDecoder?.() ?? upstreamCodec.createStreamDecoder();
  const encoder: StreamEncoder | null =
    passthrough || !ingressCodec ? null : ingressCodec.createStreamEncoder(ctx.model);
  const reader = response.body?.getReader();
  const writer = new BackpressureWriter(reply);

  // 长流：用 LeaseKeeper 续期，避免 10 分钟以上的流中途丢掉并发位。
  const leases = ctx.accountLease ? [ctx.accountLease, ...ctx.keyLeases] : [...ctx.keyLeases];
  const keeper = new LeaseKeeper(rt_state(ctx), leases, DEFAULT_LEASE_TTL_MS, () => {
    void metrics.bump('stream.lease_lost').catch(() => null);
  });

  reply.status(response.status);
  forwardResponseHeaders(response, reply);
  if (encoder && ingressCodec) reply.header('content-type', ingressCodec.streamContentType);

  const textDecoder = new TextDecoder();
  const acc = new OutputAccumulator();
  let usage: IRUsage | null = null;
  let firstTokenMs: number | null = null;
  let clientAborted = false;

  if (reader) {
    // 只在真正有 body 要读时启动续租：否则定时器会因为没有 stop 而泄漏。
    keeper.start();
    reply.onClientClose(() => {
      clientAborted = true;
      void reader.cancel().catch(() => undefined);
    });
    try {
      for (;;) {
        let done = false;
        let value: Uint8Array | undefined;
        try {
          const chunk = await reader.read();
          done = chunk.done;
          value = chunk.value;
        } catch {
          clientAborted = true;
          break;
        }
        if (done) break;
        if (!value) continue;
        if (firstTokenMs === null) firstTokenMs = Date.now() - ctx.startedAt;

        const text = textDecoder.decode(value, { stream: true });
        acc.push(text);

        if (passthrough) {
          if (!(await writer.write(value))) {
            clientAborted = true;
            break;
          }
        }
        for (const event of decoder.push(text)) {
          if (event.type === 'usage') usage = event.usage;
          if (encoder) {
            const encoded = encoder.encode(event);
            if (encoded && !(await writer.write(encoded))) {
              clientAborted = true;
              break;
            }
          }
        }
        if (clientAborted) break;
      }
      if (!clientAborted) {
        for (const event of decoder.end()) {
          if (event.type === 'usage') usage = event.usage;
          if (encoder) {
            const encoded = encoder.encode(event);
            if (encoded) await writer.write(encoded);
          }
        }
        if (encoder) {
          const tail = encoder.end();
          if (tail) await writer.write(tail);
        }
      }
    } finally {
      await keeper.stop();
    }
  }
  return {
    usage,
    outputText: acc.value,
    firstTokenMs,
    clientAborted,
    finish: () => {
      if (!clientAborted && !writer.isClosed) {
        try {
          reply.end();
        } catch {
          /* 客户端可能已断开；计费已落库，忽略。 */
        }
      } else if (clientAborted) {
        writer.markClosed();
      }
    },
  };
}

/** 取 state 服务（LeaseKeeper 需要）。 */
function rt_state(ctx: StreamContext): GatewayRuntime['state'] {
  return ctx.rt.state;
}

/* ------------------------------ 缓冲转发 ------------------------------ */

interface ChatBufferedContext {
  reply: RawHttpReply;
  response: Response;
  rawText: string;
  ingressProtocol: Protocol;
  ingressCodec: ProtocolCodec;
  upstreamCodec: ProtocolCodec;
  passthrough: boolean;
  model: string;
}

async function relayChatBuffered(ctx: ChatBufferedContext): Promise<string> {
  const { reply, rawText, ingressCodec, upstreamCodec, passthrough } = ctx;

  if (passthrough) {
    reply.status(ctx.response.status);
    forwardResponseHeaders(ctx.response, reply);
    reply.header('content-type', 'application/json; charset=utf-8');
    return rawText;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    throw new GatewayError(502, 'bad_upstream', '上游响应不是合法 JSON');
  }
  const ir = upstreamCodec.decodeResponse(parsed);
  const encoded = ingressCodec.encodeResponse(ir, ctx.model);
  reply.status(ctx.response.status);
  reply.header('content-type', 'application/json; charset=utf-8');
  return JSON.stringify(encoded);
}

async function relayBinary(
  reply: RawHttpReply,
  response: Response,
  signal: ClientSignal,
): Promise<{ clientAborted: boolean; finish: () => void }> {
  const writer = new BackpressureWriter(reply);
  reply.status(response.status);
  forwardResponseHeaders(response, reply);
  const reader = response.body?.getReader();
  let clientAborted = false;
  if (reader) {
    reply.onClientClose(() => {
      clientAborted = true;
      void reader.cancel().catch(() => undefined);
    });
    for (;;) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const chunk = await reader.read();
        done = chunk.done;
        value = chunk.value;
      } catch {
        clientAborted = true;
        break;
      }
      if (done) break;
      if (!value) continue;
      if (!(await writer.write(value))) {
        clientAborted = true;
        break;
      }
    }
  }
  return {
    clientAborted,
    finish: () => {
      if (!clientAborted && !signal.aborted && !writer.isClosed) {
        try {
          reply.end();
        } catch {
          /* 客户端可能已断开；计费已落库，忽略。 */
        }
      } else if (clientAborted) {
        writer.markClosed();
      }
    },
  };
}

/* ------------------------------ 计量与结算 ------------------------------ */

function chatUsage(
  adaptor: ProviderAdaptor,
  rawText: string,
  requestBodyText: string,
): { usage: ReturnType<typeof estimateUsage>; estimated: boolean } {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const extracted = adaptor.extractUsage(parsed);
    if (
      extracted &&
      (extracted.totalTokens > 0 || extracted.inputTokens > 0 || extracted.outputTokens > 0)
    ) {
      return {
        usage: toTokenUsage(extracted),
        estimated: extracted.estimated === true,
      };
    }
  } catch {
    // 落到估算。
  }
  return { usage: estimateUsage(rawText, requestBodyText), estimated: true };
}

function operationUsage(
  spec: EndpointSpec,
  bodyJson: unknown,
  rawText: string,
  requestBodyText: string,
  adaptor: ProviderAdaptor | null,
): { usage: ReturnType<typeof estimateUsage>; estimated: boolean } {
  let base = estimateUsage(rawText, requestBodyText);
  let estimated = true;
  if (adaptor && rawText) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      const extracted = adaptor.extractUsage(parsed);
      if (
        extracted &&
        (extracted.totalTokens > 0 || extracted.inputTokens > 0 || extracted.outputTokens > 0)
      ) {
        base = toTokenUsage(extracted);
        estimated = extracted.estimated === true;
      }
    } catch {
      // 保留估算。
    }
  }
  const extra = nonTokenEstimate(spec, bodyJson, requestBodyText);
  return { usage: { ...base, ...extra }, estimated };
}

/** 图片/音频等非 token 计价单位的估算（进预留与结算）。 */
function nonTokenEstimate(
  spec: EndpointSpec,
  bodyJson: unknown,
  requestBodyText: string,
): { imageCount?: number; audioSeconds?: number } {
  const out: { imageCount?: number; audioSeconds?: number } = {};
  if (spec.operation === 'images.generations' || spec.operation === 'images.edits') {
    const n = isRecord(bodyJson) ? asNumber(bodyJson['n']) : undefined;
    out.imageCount = n && n > 0 ? Math.floor(n) : 1;
  }
  if (spec.operation === 'audio.speech') {
    const input = isRecord(bodyJson) ? bodyJson['input'] : undefined;
    const chars = typeof input === 'string' ? input.length : requestBodyText.length;
    out.audioSeconds = Math.max(1, Math.ceil(chars / 15));
  }
  return out;
}

function operationModel(
  spec: EndpointSpec,
  params: Record<string, string>,
  bodyJson: unknown,
): string {
  void spec;
  if (typeof params['model'] === 'string' && params['model'].length > 0) return params['model'];
  if (isRecord(bodyJson)) {
    const model = bodyJson['model'];
    if (typeof model === 'string') return model;
  }
  return '';
}

interface SettleFields {
  protocol: string;
  endpoint: string;
  status: 'SUCCESS' | 'ERROR' | 'CANCELLED' | 'TIMEOUT';
  httpStatus: number;
  latencyMs: number;
  /** 实际响应是否为 SSE 流式转发。 */
  stream?: boolean;
  firstTokenMs?: number | null;
  clientIp?: string | undefined;
  error?: string | undefined;
  outputText?: string | undefined;
  /** 客户端中断（A8）：账单按「已发生用量」结算并标记，供人工复核。 */
  aborted?: boolean | undefined;
}

/** 失败结算：按 0 用量释放预留（若上游未消耗）或记录错误。 */
async function settleFailure(
  rt: GatewayRuntime,
  metrics: Metrics,
  billing: BillingContext,
  input: SettleFields,
): Promise<SettleResult> {
  return settleUsage(rt, metrics, billing, {
    ...input,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    estimated: false,
  });
}

interface SettleUsageInput extends SettleFields {
  usage: ReturnType<typeof estimateUsage>;
  estimated: boolean;
}

async function settleUsage(
  rt: GatewayRuntime,
  metrics: Metrics,
  billing: BillingContext,
  input: SettleUsageInput,
): Promise<SettleResult> {
  const result = await settle({
    wallet: rt.wallet,
    logger: rt.logger,
    context: billing,
    usage: input.usage,
    estimated: input.estimated,
    protocol: input.protocol,
    endpoint: input.endpoint,
    status: input.status,
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    stream: input.stream ?? false,
    firstTokenMs: input.firstTokenMs ?? null,
    clientIp: input.clientIp ?? null,
    error: input.error ?? null,
    aborted: input.aborted ?? false,
    ...(input.outputText !== undefined ? { outputText: input.outputText } : {}),
  });
  if (!result.settled) {
    await metrics.bump('billing.settle_failed').catch(() => null);
  }
  return result;
}

/** 结算成功后累加 key 用量（addPolicyUsage / addLegacyUsage 是唯一入口）。 */
async function afterSettle(
  rt: GatewayRuntime,
  key: {
    id: string;
    userId: string;
    source: 'token' | 'legacy';
    quotaWindowHours?: number;
    quotaMaxRequests?: number;
    quotaMaxTokens?: number;
  },
  result: SettleResult,
  accountId: string | null,
): Promise<void> {
  if (!result.settled) return;
  if (result.amount > 0) {
    if (key.source === 'token') {
      await addPolicyUsage(key.id, result.amount).catch(() => undefined);
    } else {
      await addLegacyUsage(key.id, result.amount, new Date()).catch(() => undefined);
    }
  }
  if (accountId) await markAccountUsed(rt, accountId);
  if (result.amount > 0) {
    await recordBudget(rt, key.userId, result.amount).catch(() => undefined);
  }
  // 长周期 token 配额按真实用量累加。放在结算之后：token 数是上游算完才有的，
  // 无法在准入时预估。失败不影响计费（recordQuotaTokens 内部吞错）。
  const tokens = (result.log.promptTokens ?? 0) + (result.log.completionTokens ?? 0);
  if (tokens > 0) {
    await recordQuotaTokens({
      rule: quotaRuleOf(key),
      keyId: key.id,
      userId: key.userId,
      tokens,
    }).catch(() => undefined);
  }
}

/** 从 key 记录里取出长周期配额规则；未配置时返回 null（不检查）。 */
export function quotaRuleOf(key: {
  quotaWindowHours?: number;
  quotaMaxRequests?: number;
  quotaMaxTokens?: number;
}): QuotaRule | null {
  const windowHours = key.quotaWindowHours ?? 0;
  const maxRequests = key.quotaMaxRequests ?? 0;
  const maxTokens = key.quotaMaxTokens ?? 0;
  if (windowHours <= 0) return null;
  if (maxRequests <= 0 && maxTokens <= 0) return null;
  return {
    scope: 'key',
    windowHours,
    maxRequests,
    maxTokens,
    enabled: true,
  };
}

/**
 * 结算后累加预算计数器并做阈值提醒（B3）。
 *
 * 计数必须按「本周期已花 + 本笔」判断阈值，所以重新读一次限额配置；
 * `budget-limit` 模型有 30s 缓存，这一步不会真的每次打库。
 */
async function recordBudget(rt: GatewayRuntime, userId: string, amount: number): Promise<void> {
  await recordSpend(userId, amount);
  const limits = await listBudgetLimitsFor(userId).catch(() => []);
  for (const period of ['day', 'month'] as const) {
    const limit =
      limits.find((row) => row.userId === userId && row.period === period) ??
      limits.find((row) => row.userId === '' && row.period === period);
    if (!limit) continue;
    const raw = await rt.state.get(spendKey(period, userId)).catch(() => null);
    const spent = raw ? Number(raw) : 0;
    await maybeWarnBudget({
      userId,
      limit,
      spent: (Number.isFinite(spent) ? spent : 0) + amount,
      period,
    });
  }
}

async function releaseLeases(rt: GatewayRuntime, leases: StateLease[]): Promise<void> {
  for (const lease of leases) {
    await rt.state.releaseLease(lease).catch(() => false);
  }
  leases.length = 0;
}

/* ------------------------------ 模型发现 ------------------------------ */

async function handleMetaEndpoint(
  key: { models: string[] },
  spec: EndpointSpec,
  params: Record<string, string>,
  reply: RawHttpReply,
): Promise<void> {
  const [accounts, prices] = await Promise.all([
    listActiveAccounts().catch(() => []),
    listEnabledPrices().catch(() => []),
  ]);
  // 对外可售模型 = 启用定价行（去掉兜底 `*`）；未配置定价时退回账号模型名。
  const ids = new Set<string>();
  for (const price of prices) if (price.model !== '*') ids.add(price.model);
  if (ids.size === 0) {
    for (const account of accounts) {
      for (const model of toStringArray(account.models)) ids.add(model);
    }
  }
  const allowed =
    key.models.length > 0 ? [...ids].filter((id) => key.models.includes(id)) : [...ids];
  allowed.sort();

  if (spec.id === 'models.get') {
    const model = params['model'] ?? '';
    if (!allowed.includes(model)) {
      throw new GatewayError(404, 'model_not_found', `模型 ${model} 不存在`);
    }
    reply.status(200);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(
      JSON.stringify({
        id: model,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'stackpanel',
      }),
    );
    return;
  }

  const created = Math.floor(Date.now() / 1000);
  reply.status(200);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(
    JSON.stringify({
      object: 'list',
      data: allowed.map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: 'stackpanel',
      })),
    }),
  );
}

/** 供测试断言：注册表条目集合（防止文档与代码漂移）。 */
export const RELAY_ENDPOINT_IDS: readonly string[] = ENDPOINTS.map((spec) => spec.id);
