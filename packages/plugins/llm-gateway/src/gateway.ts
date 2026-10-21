import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type {
  AuthService,
  PluginLogger,
  PluginSecrets,
  RawHttpReply,
  RawHttpRequest,
  RawRouteHandler,
  StateLease,
  StateService,
  WalletHold,
  WalletService,
} from '@stackpanel/sdk';
import { isAllowedUpstreamUrl } from './guard.js';
import { extractApiKey, GATEWAY_SCOPE, hashKey, toStringArray } from './keys.js';
import { computeAmount, estimateTokens, resolveServedPrice, type PricedRow, type ServedPrice, type TokenUsage } from './pricing.js';
import { isProtocol, type IRUsage, type Protocol } from './protocol.js';
import { codecFor, matchIngress } from './codecs/index.js';
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from './codecs/types.js';
import {
  addLegacyUsage,
  addPolicyUsage,
  createUsageLog,
  getLegacyByHash,
  getPolicy,
  getSetting,
  listActiveAccounts,
  listPricesForModel,
  setUsageLogError,
  updateAccount,
  type AccountRow as StoredAccountRow,
} from './repository.js';

/** 运行时依赖，由 index.ts 在 onActivate 时注入。 */
export interface GatewayRuntime {
  wallet: WalletService;
  auth: AuthService;
  state: StateService;
  secrets: PluginSecrets;
  logger: PluginLogger;
}

/** 落库的账号行。 */
type AccountRow = StoredAccountRow;

/**
 * 归一化后的网关凭证：内核 `ApiToken` + 插件策略 `GatewayKeyPolicy`，
 * 或历史 `GatewayApiKey`（P0.6 双读兜底）。
 */
interface GatewayKey {
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

const KEY_INFLIGHT_TTL = 10 * 60 * 1000;

/**
 * `lastUsedAt` is operator-facing statistics, not accounting. Refresh it at
 * most once per window per account so a busy account does not turn every
 * request into a full-row config rewrite (which would also invalidate any
 * account-pool cache on each settle).
 */
const LAST_USED_THROTTLE_MS = 30_000;

async function markAccountUsed(rt: GatewayRuntime, accountId: string): Promise<void> {
  const marker = `gw:acct:${accountId}:used`;
  const recorded = await rt.state.acquire(marker, LAST_USED_THROTTLE_MS).catch(() => null);
  if (!recorded) return;
  await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }).catch(() => null);
}

/** 把任意 model 字段规整为 string[]。 */
function asStringArray(value: unknown): string[] {
  return toStringArray(value);
}

/** 读取整个请求体（原始流）为 Buffer。 */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** 拼接上游 URL。 */
function joinUrl(baseUrl: string, subPath: string, query: URLSearchParams): string {
  const base = baseUrl.replace(/\/+$/, '');
  let rest = subPath.replace(/^\/+/, '');
  // baseUrl 可能已带版本段（…/v1、…/v1beta）。此时去掉 subPath 里重复的版本前缀。
  const version = /\/v\d+[a-z]*$/.exec(base);
  if (version) {
    const seg = version[0].slice(1);
    if (rest === seg) rest = '';
    else if (rest.startsWith(`${seg}/`)) rest = rest.slice(seg.length + 1);
  }
  const path = rest ? `${base}/${rest}` : base;
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/** 账号的协议（非法值回退到 openai-chat）。 */
function accountProtocol(account: AccountRow): Protocol {
  return isProtocol(account.provider) ? account.provider : 'openai-chat';
}

function sendJson(reply: RawHttpReply, status: number, message: string, code: string): void {
  reply.status(status);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(JSON.stringify({ error: { message, type: 'gateway_error', code } }));
}

/**
 * 挑选一个可用上游账号：优先同协议（避免转换），再按 priority 降序、同优先级内按 weight 加权随机。
 *
 * 并发位通过内核的原子准入能力一次拿完（`state.acquireLease`）：候选按优先级从高到低
 * 整批发过去，内核在**一次 Redis 往返**里挑出第一个仍有空位的账号，满载的账号池
 * 不会被触碰（无需先 `incr` 再回滚）。此前逐个 `incr`/`decr` 探测的写法在全部账号
 * 满载时，往返次数随候选账号数线性增长。
 *
 * 返回的 `lease` 必须由调用方在 `finally` 中 `releaseLease`，租约带唯一 token，
 * 因此超时或重试的请求不可能释放掉别的请求占用的位子。
 */
async function pickAccount(
  rt: GatewayRuntime,
  model: string,
  ingress: Protocol,
): Promise<{ account: AccountRow; lease: StateLease } | null> {
  const accounts = await listActiveAccounts();
  const eligible = accounts.filter((account) => {
    const models = asStringArray(account.models);
    return models.length === 0 || model === '' || models.includes(model);
  });
  if (eligible.length === 0) return null;

  // 先在同协议账号里挑；没有再放宽到全部（走协议转换）。
  const sameProtocol = eligible.filter((account) => accountProtocol(account) === ingress);
  const pool = sameProtocol.length > 0 ? sameProtocol : eligible;

  const byPriority = new Map<number, AccountRow[]>();
  for (const account of pool) {
    const list = byPriority.get(account.priority) ?? [];
    list.push(account);
    byPriority.set(account.priority, list);
  }
  const priorities = [...byPriority.keys()].sort((a, b) => b - a);

  // 优先级从高到低、同优先级内加权随机，展开成一个有序候选列表；内核按序取第一个有空位的池。
  const ordered: AccountRow[] = [];
  for (const priority of priorities) {
    ordered.push(...weightedOrder(byPriority.get(priority) ?? []));
  }
  if (ordered.length === 0) return null;

  const lease = await rt.state.acquireLease(
    ordered.map((account) => ({
      key: `gw:acct:${account.id}:inflight`,
      limit: account.maxConcurrency,
    })),
    KEY_INFLIGHT_TTL,
  );
  if (!lease) return null;

  // 租约只回传 key，按 key 反查回候选账号。
  const account = ordered.find((candidate) => `gw:acct:${candidate.id}:inflight` === lease.key);
  if (!account) {
    await rt.state.releaseLease(lease).catch(() => false);
    return null;
  }
  return { account, lease };
}

/** 按 weight 做加权随机排序。 */
function weightedOrder(accounts: AccountRow[]): AccountRow[] {
  const pool = accounts.map((account) => ({
    account,
    key: Math.random() / Math.max(1, account.weight),
  }));
  pool.sort((a, b) => a.key - b.key);
  return pool.map((item) => item.account);
}

/**
 * 解析某次请求可能用到的定价行：**只取精确模型名与 `*` 兜底两行**。
 *
 * 以前这里读全部启用定价再在内存里挑，代价随定价表行数线性增长（行数越多，
 * 每次请求经 IPC 搬运的字节也越多）。`resolveServedPrice` 只可能命中这两行，
 * 其余读了立刻丢弃，所以直接按 `model: { in: [model, '*'] }` 精确取。
 * 请求开始时解析一次，供选号/转发/计费共用，避免同一请求重复查库。
 */
async function loadPricing(model: string): Promise<Array<{ model: string } & PricedRow>> {
  const rows = await listPricesForModel(model);
  return rows.map((row) => ({
    model: row.model,
    upstreamModel: row.upstreamModel,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    cacheReadPrice: row.cacheReadPrice,
    cacheWritePrice: row.cacheWritePrice,
    multiplier: row.multiplier,
  }));
}

function toTokenUsage(usage: IRUsage): TokenUsage {
  const total = usage.totalTokens || usage.inputTokens + usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: total,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

/**
 * 解析网关凭证。
 *
 * 主路径读内核平台凭证 `ApiToken`（经 `ctx.auth` 检视），校验状态/有效期/IP 白名单，
 * 并按硬不变式求「token scope ∩ 持有者当前权限」；业务策略读插件 key-policy。
 * 历史 `legacy-key` 作双读兜底，保证归并过渡期不中断。
 */
async function resolveGatewayKey(
  rt: GatewayRuntime,
  plaintext: string,
  clientIp: string | undefined,
): Promise<
  | { ok: true; key: GatewayKey }
  | { ok: false; status: number; message: string; code: string }
> {
  const deny = (status: number, message: string, code: string) =>
    ({ ok: false as const, status, message, code });

  const inspection = await rt.auth
    .inspectPlatformToken(plaintext, clientIp)
    .catch(() => null);
  if (inspection) {
    const token = inspection.token;
    if (!inspection.active) return deny(401, 'API key 无效或已停用', 'invalid_api_key');
    if (inspection.expired) return deny(403, 'API key 已过期', 'key_expired');
    if (!token.scopes.includes(GATEWAY_SCOPE)) {
      return deny(403, '该密钥未授予 模型服务权限', 'insufficient_scope');
    }
    if (!inspection.ipAllowed) {
      return deny(403, '请求来源 IP 不在白名单内', 'ip_not_allowed');
    }
    if (!(await rt.auth.hasPermission(token.userId, GATEWAY_SCOPE).catch(() => false))) {
      return deny(403, '当前账号已无权使用 模型服务', 'permission_revoked');
    }
    const policy = await getPolicy(token.id).catch(() => null);
    return {
      ok: true,
      key: {
        id: token.id,
        userId: token.userId,
        name: token.name,
        status: token.status,
        models: toStringArray(policy?.models),
        rpmLimit: policy?.rpmLimit ?? 0,
        concurrencyLimit: policy?.concurrencyLimit ?? 0,
        quotaLimit: policy?.quotaLimit ?? null,
        quotaUsed: policy?.quotaUsed ?? 0,
        expiresAt: token.expiresAt,
        source: 'token',
      },
    };
  }

  // 双读兜底：P0.6 迁移前的历史密钥。
  const legacy = await getLegacyByHash(hashKey(plaintext)).catch(() => null);
  if (!legacy) return deny(401, 'API key 无效或已停用', 'invalid_api_key');
  if (legacy.status !== 'ACTIVE') return deny(401, 'API key 无效或已停用', 'invalid_api_key');
  if (legacy.expiresAt && new Date(legacy.expiresAt).getTime() <= Date.now()) {
    return deny(403, 'API key 已过期', 'key_expired');
  }
  if (!(await rt.auth.hasPermission(legacy.userId, GATEWAY_SCOPE).catch(() => false))) {
    return deny(403, '当前账号已无权使用 模型服务', 'permission_revoked');
  }
  return {
    ok: true,
    key: {
      id: legacy.id,
      userId: legacy.userId,
      name: legacy.name,
      status: legacy.status,
      models: toStringArray(legacy.models),
      rpmLimit: legacy.rpmLimit,
      concurrencyLimit: legacy.concurrencyLimit,
      quotaLimit: legacy.quotaLimit ?? null,
      quotaUsed: legacy.quotaUsed,
      expiresAt: legacy.expiresAt ?? null,
      source: 'legacy',
    },
  };
}

/**
 * 构造 relay 原始路由处理器。key 认证、协议识别、账号选择、协议转换、按 token 后付费都在这里。
 */
export function createRelayHandler(getRuntime: () => GatewayRuntime): RawRouteHandler {
  return async (req: RawHttpRequest, reply: RawHttpReply): Promise<void> => {
    const startedAt = Date.now();
    let rt: GatewayRuntime;
    try {
      rt = getRuntime();
    } catch {
      sendJson(reply, 503, '网关未就绪', 'gateway_unavailable');
      return;
    }

    const plaintext = extractApiKey(req.headers) ?? req.query.get('key')?.trim() ?? null;
    if (!plaintext) {
      sendJson(reply, 401, '缺少 API key', 'missing_api_key');
      return;
    }
    // 查询串里的 key 只用于网关鉴权，转发上游前删掉，避免泄露。
    req.query.delete('key');
    const resolved = await resolveGatewayKey(rt, plaintext, req.ip);
    if (!resolved.ok) {
      sendJson(reply, resolved.status, resolved.message, resolved.code);
      return;
    }
    const key = resolved.key;
    if (key.quotaLimit !== null && key.quotaUsed >= key.quotaLimit) {
      sendJson(reply, 402, '额度已用尽', 'quota_exceeded');
      return;
    }

    // API 计费开关（用户级）：未开启则完全禁用网关。
    const setting = await getSetting(key.userId).catch(() => null);
    if (!setting?.billingEnabled) {
      sendJson(reply, 403, 'API 计费未开启，请先在账户中心开启', 'billing_disabled');
      return;
    }

    const walletAccount = await rt.wallet.getAccount(key.userId).catch(() => null);
    const currency = walletAccount?.currency ?? 'CNY';
    if (!walletAccount || walletAccount.balance <= 0) {
      sendJson(reply, 402, '余额不足，请先充值', 'insufficient_balance');
      return;
    }

    const rest = req.params['*'] ?? '';
    const ingress = matchIngress(rest, req.query);
    const ingressProtocol: Protocol = ingress?.protocol ?? 'openai-chat';

    // 读请求体（GET/HEAD 无体），解析以便选路与计量。
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const bodyBuffer = hasBody ? await readAll(req.body).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    let bodyJson: unknown = null;
    if (bodyBuffer.length > 0) {
      try {
        bodyJson = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
      } catch {
        bodyJson = null;
      }
    }

    const ingressCodec = codecFor(ingressProtocol);
    let ir;
    try {
      ir = ingressCodec.decodeRequest(bodyJson);
    } catch {
      sendJson(reply, 400, '请求体无法解析', 'invalid_request');
      return;
    }
    // GET 请求（如 /v1/models）走直通；Gemini 从路径解析模型名。
    if (!ir.model && ingress?.geminiModel) ir.model = ingress.geminiModel;
    // Gemini 的流式由路径 action 决定（body 里没有 stream 字段）。
    if (ingress?.streaming) ir.stream = true;
    const model = ir.model;
    const wantsStream = ir.stream;

    const allowedModels = asStringArray(key.models);
    if (model && allowedModels.length > 0 && !allowedModels.includes(model)) {
      sendJson(reply, 403, `模型 ${model} 不在该 key 的允许范围内`, 'model_not_allowed');
      return;
    }

    // 限速：每 key 每分钟请求数。
    if (key.rpmLimit > 0) {
      const hits = await rt.state.incr(`gw:rpm:${key.id}`, 60_000);
      if (hits > key.rpmLimit) {
        reply.header('retry-after', '60');
        sendJson(reply, 429, '请求过于频繁', 'rate_limited');
        return;
      }
    }
    // 并发：每 key 在途请求数。与账号池同样走内核的原子准入能力，
    // 一次往返即可拿到具名租约，超时/重试的请求不会误释放别人的位子。
    let keyLease: StateLease | null = null;
    if (key.concurrencyLimit > 0) {
      keyLease = await rt.state.acquireLease(
        [{ key: `gw:key:${key.id}:inflight`, limit: key.concurrencyLimit }],
        KEY_INFLIGHT_TTL,
      );
      if (!keyLease) {
        sendJson(reply, 429, '并发超出限制', 'concurrency_limited');
        return;
      }
    }

    // 解析定价与上游绑定（对外模型名 → 实际转发模型名）。整个请求只查一次。
    const served = resolveServedPrice(await loadPricing(model), model);
    const upstreamModel = model ? served.upstreamModel : model;

    // 预授权状态（ADR-0022 P16）：结算或释放必须恰好发生一次。
    const preauth: Preauth = { hold: null, settled: false };

    let account: AccountRow | null = null;
    let accountLease: StateLease | null = null;
    try {
      const picked = await pickAccount(rt, upstreamModel, ingressProtocol);
      if (!picked) {
        sendJson(reply, 502, '暂无可用上游账号', 'no_upstream');
        return;
      }
      account = picked.account;
      accountLease = picked.lease;

      const upstreamKey = await rt.secrets.get(account.apiKeyRef).catch(() => null);
      if (!upstreamKey) {
        sendJson(reply, 502, '上游账号凭证缺失', 'upstream_credential_missing');
        return;
      }

      const upstreamProtocol = accountProtocol(account);
      const upstreamCodec = codecFor(upstreamProtocol);
      const passthrough = upstreamProtocol === ingressProtocol;

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        if (Array.isArray(value)) headers[name] = value.join(', ');
        else if (typeof value === 'string') headers[name] = value;
      }
      Object.assign(headers, upstreamCodec.authHeaders(upstreamKey));

      // 构造上游请求体与路径。
      let forwardBody: string;
      let forwardPath: string;
      if (passthrough && bodyBuffer.length > 0) {
        // 同协议直通：保留未知字段。对外模型名与上游模型名不同时，仅重写模型字段
        // （JSON 协议在 body.model；Gemini 在路径里）。
        if (
          model &&
          upstreamModel !== model &&
          upstreamProtocol !== 'gemini' &&
          bodyJson &&
          typeof bodyJson === 'object' &&
          !Array.isArray(bodyJson)
        ) {
          (bodyJson as Record<string, unknown>)['model'] = upstreamModel;
        }
        // 需要时注入 stream_options。
        if (
          upstreamProtocol === 'openai-chat' &&
          wantsStream &&
          bodyJson &&
          typeof bodyJson === 'object' &&
          !Array.isArray(bodyJson) &&
          (bodyJson as Record<string, unknown>)['stream_options'] === undefined
        ) {
          (bodyJson as Record<string, unknown>)['stream_options'] = { include_usage: true };
        }
        forwardBody = bodyJson !== null ? JSON.stringify(bodyJson) : bodyBuffer.toString('utf8');
        if (model && upstreamModel !== model && upstreamProtocol === 'gemini') {
          ir.model = upstreamModel;
          forwardPath = upstreamCodec.requestPath(ir, wantsStream);
        } else {
          forwardPath = ingress?.subPath ?? rest.replace(/^\/+/, '');
        }
      } else {
        if (model) ir.model = upstreamModel;
        const encoded = upstreamCodec.encodeRequest(ir);
        forwardBody = JSON.stringify(encoded);
        forwardPath = upstreamCodec.requestPath(ir, wantsStream);
      }
      headers['content-type'] = 'application/json';

      const query = new URLSearchParams(ingress?.query ?? req.query);
      if (upstreamProtocol === 'gemini' && wantsStream) {
        query.set('alt', 'sse');
      }
      const upstreamUrl = joinUrl(account.baseUrl, forwardPath, query);
      if (!isAllowedUpstreamUrl(upstreamUrl)) {
        sendJson(reply, 400, '上游地址必须为公网地址', 'invalid_upstream');
        return;
      }
      // 预授权（ADR-0022 P16）：占用上游之前先把预估费用从余额划走。
      // 「先查余额、用完再扣」下并发请求共享同一余额快照，扣费失败的请求会变成坏账；
      // 冻结后后到的请求看到的是已扣减的余额，会在**消耗上游之前**被拒。
      // 预估按 prompt + max_tokens（缺省 4096）算上限，结算时按实际用量多退。
      const holdAmount = estimateHoldAmount(served, bodyBuffer, ir.maxTokens);
      if (holdAmount > 0) {
        try {
          preauth.hold = await rt.wallet.hold(
            key.userId,
            holdAmount,
            currency,
            {
              type: 'llm_gateway_usage',
              referenceType: 'gateway_hold',
              referenceId: randomUUID(),
            },
            { note: `${model || 'unknown'} 预授权` },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : '预授权失败';
          if (message.includes('余额不足')) {
            sendJson(reply, 402, '余额不足，请先充值', 'insufficient_balance');
          } else {
            rt.logger.error(`llm-gateway: hold failed: ${message}`);
            sendJson(reply, 502, '预授权失败', 'preauth_failed');
          }
          return;
        }
      }

      const upstream = await fetch(upstreamUrl, {
        method: req.method === 'GET' ? 'GET' : 'POST',
        headers,
        ...(req.method === 'GET' ? {} : { body: forwardBody }),
      });

      const contentType = upstream.headers.get('content-type') ?? '';
      const isEventStream = contentType.includes('text/event-stream');

      if (isEventStream) {
        await relayStream({
          rt,
          key,
          account,
          model: model || 'unknown',
          price: served,
          currency,
          ingressCodec,
          upstreamCodec,
          passthrough,
          upstream,
          reply,
          startedAt,
          preauth,
          clientIp: req.ip,
        });
      } else {
        await relayBuffered({
          rt,
          key,
          account,
          model: model || 'unknown',
          price: served,
          currency,
          ingressCodec,
          upstreamCodec,
          passthrough,
          upstream,
          reply,
          startedAt,
          preauth,
          bodyBuffer,
          clientIp: req.ip,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '网关错误';
      rt.logger.error(`llm-gateway: relay failed: ${message}`);
      if (!(reply.raw as { headersSent?: boolean }).headersSent) {
        sendJson(reply, 502, '上游请求失败', 'upstream_error');
      } else {
        reply.end();
      }
    } finally {
      // 租约带唯一 token：只释放本请求自己占的位子，且重复释放是安全的 no-op。
      if (accountLease) await rt.state.releaseLease(accountLease).catch(() => false);
      if (keyLease) await rt.state.releaseLease(keyLease).catch(() => false);
      // 预授权兜底：请求在任何结算之前就失败了（无可用账号、凭证缺失、上游不可达…），
      // 把冻结金额全额退回。已经结算过的会置 settled，这里就不再动。
      if (preauth.hold && !preauth.settled) {
        preauth.settled = true;
        await rt.wallet.releaseHold(preauth.hold.id).catch((error: unknown) => {
          rt.logger.warn(`llm-gateway: release hold failed: ${String(error)}`);
        });
      }
    }
  };
}

/**
 * 预授权状态（ADR-0022 P16）。`settled` 在结算**尝试之前**置位：结算失败时宁可
 * 让冻结金额留在账上由内核的过期清扫（15 分钟）归还，也不在 finally 里重复退还 ——
 * 后者会在「用量已落流水、扣费却失败」时把金额白送出去。
 */
interface Preauth {
  hold: WalletHold | null;
  settled: boolean;
}

/** 未声明 max_tokens 时，按这个上限做预授权估算。 */
const DEFAULT_HOLD_MAX_TOKENS = 4_096;

/**
 * 预授权金额：按请求体估算的 prompt token + 请求声明的 `max_tokens`（缺省
 * {@link DEFAULT_HOLD_MAX_TOKENS}）算出**本次最多可能消耗**的费用。结算时按实际用量
 * 多退（`wallet.settleHold` 会把差额退回余额）。
 *
 * 刻意按上限估算：预估偏小就重新打开了「并发共享余额快照」的坏账窗口；偏大只是让
 * 小额余额用户在预估上被拒（可通过充值或调小 max_tokens 解决）。
 */
function estimateHoldAmount(price: ServedPrice, bodyBuffer: Buffer, maxTokens?: number): number {
  const promptTokens = estimateTokens(bodyBuffer.toString('utf8'));
  const completionTokens =
    maxTokens && Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : DEFAULT_HOLD_MAX_TOKENS;
  return computeAmount(price, {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
}

/** 转发上游响应头（过滤 hop-by-hop）。 */
function forwardHeaders(upstream: Response, reply: RawHttpReply): void {
  const setCookies =
    typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  upstream.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name.toLowerCase())) return;
    if (name.toLowerCase() === 'set-cookie') return;
    if (name.toLowerCase() === 'content-length') return;
    reply.header(name, value);
  });
  if (setCookies.length > 0) reply.header('set-cookie', setCookies);
}

interface RelayContext {
  rt: GatewayRuntime;
  key: GatewayKey;
  account: AccountRow;
  model: string;
  price: ServedPrice;
  currency: string;
  ingressCodec: ProtocolCodec;
  upstreamCodec: ProtocolCodec;
  passthrough: boolean;
  upstream: Response;
  reply: RawHttpReply;
  startedAt: number;
  /** 预授权句柄：每个请求恰好结算一次，失败则留给内核过期清扫。 */
  preauth: Preauth;
  clientIp?: string | undefined;
}

/** 流式：逐块透传 / 转换，同时累计用量。 */
async function relayStream(ctx: RelayContext): Promise<void> {
  const { rt, upstream, reply, ingressCodec, upstreamCodec, passthrough } = ctx;
  const decoder: StreamDecoder = upstreamCodec.createStreamDecoder();
  const encoder: StreamEncoder | null = passthrough ? null : ingressCodec.createStreamEncoder(ctx.model);
  const reader = upstream.body?.getReader();

  reply.status(upstream.status);
  forwardHeaders(upstream, reply);
  if (encoder) reply.header('content-type', ingressCodec.streamContentType);

  let usage: IRUsage | null = null;
  const textDecoder = new TextDecoder();
  let outputText = '';

  if (reader) {
    reply.onClientClose(() => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = textDecoder.decode(value, { stream: true });
      if (passthrough) {
        reply.write(value);
      }
      // 无论直通还是转换都要解码，才能拿到上游的 usage。
      for (const event of decoder.push(chunk)) {
        if (event.type === 'usage') usage = event.usage;
        if (encoder) {
          const text = encoder.encode(event);
          if (text) reply.write(text);
        }
      }
      outputText += chunk;
      if (outputText.length > 262_144) outputText = outputText.slice(-131_072);
    }
    for (const event of decoder.end()) {
      if (event.type === 'usage') usage = event.usage;
      if (encoder) {
        const text = encoder.encode(event);
        if (text) reply.write(text);
      }
    }
    if (encoder) {
      const tail = encoder.end();
      if (tail) reply.write(tail);
    }
  }

  const finalUsage = resolveUsage(usage, outputText);
  await settleUsage({
    rt,
    key: ctx.key,
    account: ctx.account,
    model: ctx.model,
    price: ctx.price,
    preauth: ctx.preauth,
    usage: finalUsage,
    currency: ctx.currency,
    status: upstream.status < 400 ? 'SUCCESS' : 'ERROR',
    httpStatus: upstream.status,
    latencyMs: Date.now() - ctx.startedAt,
    clientIp: ctx.clientIp,
    ...(upstream.status >= 400 ? { error: `上游返回 ${upstream.status}` } : {}),
  });
  reply.end();
}

/** 非流式：读全量，转换后写出，并计费。 */
async function relayBuffered(
  ctx: RelayContext & { bodyBuffer: Buffer },
): Promise<void> {
  const { upstream, reply, ingressCodec, upstreamCodec, passthrough, bodyBuffer } = ctx;
  const rawText = await upstream.text();

  // 先把计费跑完，再结束响应，保证调用方拿到响应时扣费已落库。
  if (passthrough) {
    if (upstream.status < 400) {
      await meterBuffered(ctx, rawText, bodyBuffer);
    } else {
      await settleUsage({
        ...balanceArgs(ctx),
        status: 'ERROR',
        httpStatus: upstream.status,
        error: `上游返回 ${upstream.status}`,
      });
    }
    reply.status(upstream.status);
    forwardHeaders(upstream, reply);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(rawText);
    return;
  }

  if (upstream.status >= 400) {
    await settleUsage({
      ...balanceArgs(ctx),
      status: 'ERROR',
      httpStatus: upstream.status,
      error: `上游返回 ${upstream.status}`,
    });
    reply.status(upstream.status);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(rawText);
    return;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    await settleUsage({
      ...balanceArgs(ctx),
      status: 'ERROR',
      httpStatus: 502,
      error: '上游响应解析失败',
    });
    reply.status(502);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(
      JSON.stringify({
        error: { message: '上游响应不是合法 JSON', type: 'gateway_error', code: 'bad_upstream' },
      }),
    );
    return;
  }

  const ir = upstreamCodec.decodeResponse(parsed);
  const encoded = ingressCodec.encodeResponse(ir, ctx.model);
  const usage = toTokenUsage(ir.usage);
  await settleUsage({
    ...balanceArgs(ctx),
    usage: (usage.totalTokens ?? 0) > 0 ? usage : estimateFrom(rawText, bodyBuffer),
    status: 'SUCCESS',
    httpStatus: 200,
  });
  reply.status(200);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(JSON.stringify(encoded));
}

/** 同协议直通时从响应体提取 usage（无则估算）。 */
async function meterBuffered(
  ctx: RelayContext & { bodyBuffer: Buffer },
  rawText: string,
  bodyBuffer: Buffer,
): Promise<void> {
  let usage: TokenUsage | null = null;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const extracted = ctx.upstreamCodec.extractUsage(parsed);
    if (extracted) usage = toTokenUsage(extracted);
  } catch {
    usage = null;
  }
  await settleUsage({
    ...balanceArgs(ctx),
    usage: usage ?? estimateFrom(rawText, bodyBuffer),
    status: 'SUCCESS',
    httpStatus: 200,
  });
}

function balanceArgs(ctx: RelayContext): {
  rt: GatewayRuntime;
  key: GatewayKey;
  account: AccountRow;
  model: string;
  price: ServedPrice;
  usage: TokenUsage;
  currency: string;
  httpStatus: number;
  latencyMs: number;
  preauth: Preauth;
  clientIp?: string | undefined;
} {
  return {
    rt: ctx.rt,
    key: ctx.key,
    account: ctx.account,
    model: ctx.model,
    price: ctx.price,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    currency: ctx.currency,
    httpStatus: ctx.upstream.status,
    latencyMs: Date.now() - ctx.startedAt,
    preauth: ctx.preauth,
    ...(ctx.clientIp !== undefined ? { clientIp: ctx.clientIp } : {}),
  };
}

/** 流式用量兜底：无 usage 时按字符估算。 */
function resolveUsage(usage: IRUsage | null, outputText: string): TokenUsage {
  if (usage && usage.totalTokens > 0) return toTokenUsage(usage);
  return estimateFrom(outputText, Buffer.alloc(0));
}

/** 无 usage 时的估算兜底（prompt 用请求体，completion 用响应文本）。 */
function estimateFrom(outputText: string, bodyBuffer: Buffer): TokenUsage {
  const prompt = estimateTokens(bodyBuffer.toString('utf8'));
  // 流式时 outputText 是原始 SSE，含协议开销，粗估即可。
  const completion = estimateTokens(stripSse(outputText));
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

/** 从 SSE 文本里剥离 `data:` 前缀，粗略还原输出文本以估算 token。 */
function stripSse(text: string): string {
  if (!text.includes('data:')) return text;
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
}

interface SettleInput {
  rt: GatewayRuntime;
  key: GatewayKey;
  account: AccountRow | null;
  model: string;
  /** 已解析的定价；缺省时按 `model` 现算（兼容直接调用）。 */
  price?: ServedPrice;
  usage: TokenUsage;
  currency: string;
  status: 'SUCCESS' | 'ERROR';
  httpStatus: number;
  latencyMs: number;
  /** 预授权句柄；缺失时回落到后付费 `wallet.debit`。 */
  preauth?: Preauth | undefined;
  clientIp?: string | undefined;
  error?: string | undefined;
}

/** 写用量流水 → 后付费扣钱包（幂等引用 = 流水 id）→ 累加 key 已用额度。 */
async function settleUsage(input: SettleInput): Promise<void> {
  const { rt, key, account, usage, preauth } = input;
  let amount = 0;
  if (input.status === 'SUCCESS') {
    const price = input.price ?? resolveServedPrice(await loadPricing(input.model), input.model);
    amount = computeAmount(price, usage);
  }

  const log = await createUsageLog({
    apiKeyId: key.id,
    userId: key.userId,
    accountId: account?.id ?? null,
    model: input.model,
    protocol: 'openai-chat',
    endpoint: 'chat.completions',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    imageCount: usage.imageCount ?? 0,
    audioSeconds: usage.audioSeconds ?? 0,
    totalTokens: usage.totalTokens || usage.promptTokens + usage.completionTokens,
    amount,
    currency: input.currency,
    status: input.status,
    estimated: false,
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    clientIp: input.clientIp ?? null,
    error: input.error ?? null,
  });

  if (key.source === 'token') {
    // 策略行可能尚未创建（token 在别处签发），用 upsert 保证累加不丢。
    await addPolicyUsage(key.id, amount);
  } else {
    await addLegacyUsage(key.id, amount, new Date());
  }
  if (account) {
    // Non-accounting bookkeeping: `updateAccount` rewrites the whole row, so
    // doing it on every settle turns pure statistics into a per-request write.
    // Throttle to one write per window per account.
    await markAccountUsed(rt, account.id);
  }

  if (amount > 0 && preauth?.hold && !preauth.settled) {
    // 结算尝试之前就置位：失败时宁可让冻结金额留给内核的过期清扫归位，
    // 也不在 finally 里退还 —— 用量已落流水，退还等于白送。
    preauth.settled = true;
    try {
      await rt.wallet.settleHold(preauth.hold.id, amount, {
        type: 'llm_gateway_usage',
        referenceType: 'gateway_usage_log',
        referenceId: log.id,
        note: `${input.model} · ${usage.totalTokens || usage.promptTokens + usage.completionTokens} tokens`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '扣费失败';
      rt.logger.warn(`llm-gateway: settle failed for log ${log.id}: ${message}`);
      await setUsageLogError(log.id, `扣费失败：${message}`).catch(() => null);
    }
  } else if (amount > 0 && !preauth?.hold) {
    // 无预授权时回落到后付费路径（兼容直接调用与 hold 金额为 0 的情况）。
    try {
      await rt.wallet.debit(key.userId, amount, input.currency, {
        type: 'llm_gateway_usage',
        referenceType: 'gateway_usage_log',
        referenceId: log.id,
        note: `${input.model} · ${usage.totalTokens || usage.promptTokens + usage.completionTokens} tokens`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '扣费失败';
      rt.logger.warn(`llm-gateway: debit failed for log ${log.id}: ${message}`);
      await setUsageLogError(log.id, `扣费失败：${message}`).catch(() => null);
    }
  } else if (preauth?.hold && !preauth.settled) {
    // 用量为 0（或未计费）：释放冻结。
    preauth.settled = true;
    await rt.wallet.releaseHold(preauth.hold.id).catch(() => null);
  }
}
