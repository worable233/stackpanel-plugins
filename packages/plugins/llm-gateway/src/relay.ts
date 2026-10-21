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
import { codecFor } from './codecs/index.js';
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from './codecs/types.js';
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
import { resolveServedPrice } from './pricing.js';
import { OutputAccumulator, estimateUsage, resolveStreamUsage, toTokenUsage } from './metering.js';
import { Metrics, type RequestObservation } from './observability.js';
import { asNumber, isRecord, type IRRequest, type IRUsage, type Protocol } from './protocol.js';
import {
  addLegacyUsage,
  addPolicyUsage,
  getConfig,
  getSetting,
  listActiveAccounts,
  listEnabledPrices,
  listPricesForModel,
  updateAccount,
  type AccountRow,
} from './repository.js';
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

async function readStream(stream: Readable, limit: number): Promise<Uint8Array> {
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

function toAdaptorAccount(row: AccountRow, apiKey: string): AdaptorAccount {
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

  const allowedModels = key.models;
  if (model && allowedModels.length > 0 && !allowedModels.includes(model)) {
    throw new GatewayError(403, 'model_not_allowed', `模型 ${model} 不在该 key 的允许范围内`);
  }

  const served = resolveServedPrice(await listPricesForModel(model), model);
  const upstreamModel = model ? served.upstreamModel : model;

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
  const concurrency = await scheduler.checkConcurrency(admission);
  if (!concurrency.ok) {
    throw new GatewayError(concurrency.status, concurrency.code, concurrency.message, {
      retryAfterSeconds: concurrency.retryAfterSeconds ?? null,
    });
  }
  const keyLeases: StateLease[] = [...concurrency.leases];

  /* ---------------------------- 预授权 ---------------------------- */
  const walletAccount = await rt.wallet.getAccount(key.userId).catch(() => null);
  const currency = walletAccount?.currency ?? 'CNY';

  const reserveAmount = estimateReserve({
    price: served,
    bodyText: requestBodyText,
    maxTokens: ir?.maxTokens,
    ...nonTokenEstimate(spec, bodyJson, requestBodyText),
  });

  if (reserveAmount > 0 && (!walletAccount || walletAccount.balance <= 0)) {
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
      note: `${model || 'unknown'} 预授权`,
      ttlMs: cfg.holdTtlMs,
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
      account: AdaptorAccount;
      lease: StateLease;
    }

    const selectAccount = async (): Promise<Selected | null> => {
      const picked = await pickAccount({
        model,
        ingress: chatProtocol ?? 'openai-chat',
        affinity,
        upstreamModel,
        scheduler,
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
      const secret = await rt.secrets.get(picked.account.apiKeyRef).catch(() => null);
      if (!secret) {
        await scheduler.releaseAccountLease(picked.lease).catch(() => false);
        throw new GatewayError(502, 'upstream_credential_missing', '上游账号凭证缺失');
      }
      return {
        row: picked.account,
        adaptor,
        account: toAdaptorAccount(picked.account, secret),
        lease: picked.lease,
      };
    };

    const buildCall = (selected: Selected): Promise<UpstreamCall> =>
      prepareCall(
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

    let selected = await selectAccount();
    if (!selected) throw new GatewayError(502, 'no_upstream', '暂无可用上游账号');
    accountLease = selected.lease;
    obs.accountId = selected.row.id;
    // 台账在选号**之前**建立（顺序纪律），因此这里必须把真实账号回填进计费
    // 上下文，否则 settle 写出的 usage log 永远 accountId=null，丢失按账号归因。
    billing.accountId = selected.row.id;

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
      if (accountLease) {
        await scheduler.releaseAccountLease(accountLease).catch(() => false);
        accountLease = null;
      }
      const next = await selectAccount();
      if (!next) return false;
      accountLease = next.lease;
      selected = next;
      obs.accountId = next.row.id;
      billing.accountId = next.row.id;
      call = await buildCall(next);
      // 记账一次账号切换，供管理端看板观察池内降级频率。
      void metrics.bump('account.failover').catch(() => null);
      return isAllowedUpstreamUrl(call.url);
    };

    const maxAttempts = Math.max(1, cfg.retryAttempts);
    let response: Response | null = null;
    let upstreamError: { status: number; error: GatewayError } | null = null;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const fetched = await fetchUpstream(call, {
          clientSignal: signal.signal,
          timeouts: { connectMs: DEFAULT_CONNECT_TIMEOUT_MS },
        });
        response = fetched.response;
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

      if (response.status >= 400) {
        const bodyBytes = await readResponseBody(response, ERROR_BODY_LIMIT).catch(
          () => new Uint8Array(0),
        );
        const bodyText = Buffer.from(bodyBytes).toString('utf8');
        const classified = selected.adaptor.classifyError({
          status: response.status,
          bodyText,
          headers: response.headers,
        });
        const retryable = selected.adaptor.isRetryable(classified, response.status);
        // 仅对 429/408 施加冷却：5xx 在请求内重试即可，避免瞬时 5xx 把整个账号池冷却。
        const penalize = retryable && (response.status === 429 || response.status === 408);
        await scheduler.recordFailure(selected.row.id, classified.message, {
          retryable: penalize,
          retryAfterSeconds: classified.retryAfterSeconds,
        });
        if (retryable && attempt < maxAttempts) {
          obs.retries += 1;
          await sleep(
            retryDelayMs(attempt, undefined, classified.retryAfterSeconds),
            signal.signal,
          );
          if (!(await rotate())) {
            upstreamError = { status: response.status, error: classified };
            break;
          }
          continue;
        }
        upstreamError = { status: response.status, error: classified };
        break;
      }

      await scheduler.recordSuccess(selected.row.id).catch(() => undefined);
      break;
    }

    if (!response) {
      throw new GatewayError(502, 'upstream_error', '上游请求失败');
    }

    // 上游 429/5xx 走尽重试后仍失败：按分类错误返回（保留上游状态码）。
    if (upstreamError && response.status >= 400) {
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
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        firstTokenMs: relayed.firstTokenMs,
        clientIp: req.ip,
        outputText: relayed.outputText,
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
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        clientIp: req.ip,
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
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
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
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      clientIp: req.ip,
    });
    billingDone = true;
    await afterSettle(rt, key, result, selected.row.id);
    obs.settled = result.settled;
    obs.status = 200;
    reply.status(response.status);
    forwardResponseHeaders(response, reply);
    if (!upstreamContentType) reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(rawText);
  } finally {
    if (accountLease) await rt.state.releaseLease(accountLease).catch(() => false);
    await releaseLeases(rt, keyLeases);
    if (!billingDone) {
      await release(rt.wallet, rt.logger, billing).catch((error: unknown) => {
        rt.logger.warn(
          `llm-gateway: release after failure failed: ${redactSecrets(String(error))}`,
        );
      });
    }
  }
}

async function loadConfig(): Promise<GatewayConfig> {
  const config = await getConfig().catch(() => null);
  return (
    config ?? {
      globalConcurrency: 0,
      userRpm: 0,
      modelRpm: 0,
      providerRpm: 0,
      retryAttempts: 3,
      maxResponseBytes: 32 * 1024 * 1024,
      holdTtlMs: 15 * 60 * 1000,
    }
  );
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
async function prepareCall(
  adaptor: ProviderAdaptor,
  account: AdaptorAccount,
  call: UpstreamCall,
): Promise<UpstreamCall> {
  if (!adaptor.capabilities.customSigning) return call;
  const headers = await signBedrockCall(account, call);
  return { ...call, headers: { ...call.headers, ...headers } };
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
  firstTokenMs?: number | null;
  clientIp?: string | undefined;
  error?: string | undefined;
  outputText?: string | undefined;
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
    firstTokenMs: input.firstTokenMs ?? null,
    clientIp: input.clientIp ?? null,
    error: input.error ?? null,
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
  key: { id: string; source: 'token' | 'legacy' },
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
