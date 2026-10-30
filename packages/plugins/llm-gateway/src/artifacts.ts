/**
 * 任务产物与签名 URL（C2）。
 *
 * 三个硬约束，缺一个就会变成安全事故：
 *
 * 1. **URL 里不出现上游凭据**。产物可能是「必须带 `Authorization` 才能下载」的
 *    端点（OpenAI Videos 的 `/videos/{id}/content`），所以对外只发**签名链接**，
 *    真正的凭据由网关在代理下载时注入。对手把上游 key 拼进 URL 的做法，
 *    等于把账号令牌写进了浏览器历史、CDN 日志和聊天记录。
 * 2. **链接必须过期**。签名 = HMAC(secret, taskId|index|expiresAt)，默认 10 分钟；
 *    过期即 410，且不因为是「老用户」而宽容。
 * 3. **代理下载必须过 SSRF 校验**。产物 URL 来自上游响应，等于不可信输入：
 *    一个被劫持的上游可以返回 `http://169.254.169.254/...` 让我们去读云元数据。
 *
 * 签名密钥存在插件 state 里（首次使用时生成），不落 DB、不进日志。
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RawHttpReply } from '@stackpanel/sdk';

import { resolveAdaptor } from './adaptors/index.js';
import { isAllowedUpstreamUrl } from './guard.js';
import { BackpressureWriter, fetchUpstream, UpstreamFailure } from './upstream.js';
import { getTask, listAllAccounts } from './repository.js';
import type { TaskRow } from './repository.js';
import type { GatewayRuntime } from './runtime.js';
import type { TaskArtifact } from './tasks.js';

/** 产物链接默认有效期：10 分钟（够一次播放/下载握手，不给自己留长期后门）。 */
export const ARTIFACT_TTL_MS = 10 * 60 * 1000;

const SECRET_KEY = 'llm:gw:artifact-secret';

/** 读取（或首次生成）签名密钥。并发首次调用会各自生成，最后一次生效——可接受。 */
export async function artifactSecret(rt: GatewayRuntime): Promise<string> {
  const existing = await rt.state.get(SECRET_KEY).catch(() => null);
  if (existing && existing.length >= 32) return existing;
  const created = `${randomUUID()}${randomUUID()}`;
  await rt.state.set(SECRET_KEY, created).catch(() => undefined);
  return (await rt.state.get(SECRET_KEY).catch(() => null)) ?? created;
}

function payloadOf(taskId: string, index: number, expiresAt: number): string {
  return `${taskId}|${index}|${expiresAt}`;
}

/** 生成签名。 */
export function signArtifact(
  secret: string,
  taskId: string,
  index: number,
  expiresAt: number,
): string {
  return createHmac('sha256', secret)
    .update(payloadOf(taskId, index, expiresAt))
    .digest('hex');
}

/** 校验签名（恒定时间比较 + 过期判定）。 */
export function verifyArtifact(
  secret: string,
  taskId: string,
  index: number,
  expiresAt: number,
  signature: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = signArtifact(secret, taskId, index, expiresAt);
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/** 解析任务行里的产物列表（损坏时返回空数组，绝不抛）。 */
export function readArtifacts(task: TaskRow): TaskArtifact[] {
  const raw = task.artifacts;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry === 'string') return [{ url: entry, auth: false }];
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const url = typeof record.url === 'string' ? record.url : '';
        if (!url) return [];
        return [{ url, auth: record.auth === true }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export interface ArtifactLink {
  index: number;
  url: string;
  expiresAt: number;
  signature: string;
}

/**
 * 为任务生成对外链接。
 *
 * 只对终态为 SUCCEEDED 的任务签发：`RUNNING` 时产物还不存在，签发等于给客户端
 * 一个必然 404 的地址。
 */
export async function buildArtifactLinks(
  rt: GatewayRuntime,
  task: TaskRow,
  ttlMs = ARTIFACT_TTL_MS,
): Promise<ArtifactLink[]> {
  const artifacts = readArtifacts(task);
  if (artifacts.length === 0) return [];
  const secret = await artifactSecret(rt);
  const expiresAt = Date.now() + ttlMs;
  return artifacts.map((_artifact, index) => ({
    index,
    url: `/llm-gateway/artifacts/${task.id}/${index}?expires=${expiresAt}&sig=${signArtifact(
      secret,
      task.id,
      index,
      expiresAt,
    )}`,
    expiresAt,
    signature: '',
  }));
}

export interface ServeArtifactInput {
  taskId: string;
  index: number;
  expiresAt: number;
  signature: string;
  /** 透传客户端的 Range（视频拖动进度需要）。 */
  range?: string | null | undefined;
}

/**
 * 代理下载产物。
 *
 * 失败一律用明确状态码收尾（400/403/404/410/502），且**不回传上游错误体**：
 * 产物端点可能把内部错误信息（含内部主机名）写进 body。
 */
export async function serveArtifact(
  rt: GatewayRuntime,
  reply: RawHttpReply,
  input: ServeArtifactInput,
): Promise<void> {
  const fail = (status: number, code: string, message: string): void => {
    reply.status(status);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(JSON.stringify({ error: { code, message } }));
  };

  const secret = await artifactSecret(rt);
  if (!verifyArtifact(secret, input.taskId, input.index, input.expiresAt, input.signature)) {
    fail(403, 'invalid_signature', '链接无效或已过期');
    return;
  }

  const task = await getTask(input.taskId).catch(() => null);
  if (!task) {
    fail(404, 'task_not_found', '任务不存在');
    return;
  }
  if (!readArtifacts(task)[input.index]) {
    fail(404, 'artifact_not_found', '产物不存在');
    return;
  }
  await streamArtifactBytes(rt, reply, { task, index: input.index, range: input.range });
}

export interface StreamArtifactInput {
  task: TaskRow;
  index: number;
  /** 透传客户端的 Range（视频拖动进度需要）。 */
  range?: string | null | undefined;
}

/**
 * 取产物字节并写进响应。
 *
 * **不做鉴权**：调用方必须先确认「这个人能看这个任务」（签名链接或网关 key 都行）。
 * 之所以把这一步拆出来，是因为 OpenAI 兼容面（`/v1/videos/:id/content`）用 key 鉴权，
 * 拿不到签名——两套入口共用同一段下载/背压/SSRF 逻辑，避免第二份实现慢慢漂移。
 */
export async function streamArtifactBytes(
  rt: GatewayRuntime,
  reply: RawHttpReply,
  input: StreamArtifactInput,
): Promise<void> {
  const fail = (status: number, code: string, message: string): void => {
    reply.status(status);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.end(JSON.stringify({ error: { code, message } }));
  };
  const task = input.task;
  const artifact = readArtifacts(task)[input.index];
  if (!artifact) {
    fail(404, 'artifact_not_found', '产物不存在');
    return;
  }
  // 绝对 URL 直接校验；相对路径要用账号 baseUrl 拼出来（凭据只在代理这一侧注入）。
  let account: {
    id: string;
    provider: string;
    baseUrl: string;
    name: string;
    options?: unknown;
  } | null = null;
  let url = artifact.url;
  if (artifact.auth || !/^https?:\/\//i.test(url)) {
    if (!task.accountId) {
      fail(502, 'artifact_unavailable', '产物暂时不可用');
      return;
    }
    const accounts = await listAllAccounts().catch(() => []);
    account = accounts.find((entry) => entry.id === task.accountId) ?? null;
    if (!account) {
      fail(502, 'artifact_unavailable', '产物暂时不可用');
      return;
    }
    url = /^https?:\/\//i.test(url)
      ? url
      : `${account.baseUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  if (!isAllowedUpstreamUrl(url)) {
    fail(400, 'invalid_artifact_url', '产物地址非法');
    return;
  }

  const headers: Record<string, string> = {};
  if (account) {
    const adaptor = resolveAdaptor(account.provider);
    if (adaptor) {
      const apiKey = task.accountId
        ? await secretOfAccount(rt, task.accountId).catch(() => null)
        : null;
      if (apiKey) {
        Object.assign(
          headers,
          adaptor.authHeaders({
            id: account.id,
            name: account.name,
            baseUrl: account.baseUrl,
            apiKey,
            options: (account.options ?? {}) as Readonly<Record<string, unknown>>,
          }),
        );
      }
    }
  }
  if (input.range) headers.range = input.range;

  let fetched: Awaited<ReturnType<typeof fetchUpstream>>;
  try {
    fetched = await fetchUpstream(
      { url, method: 'GET', headers },
      { timeouts: { connectMs: 20_000, deadlineMs: 10 * 60 * 1000 } },
    );
  } catch (error) {
    const message = error instanceof UpstreamFailure ? error.message : String(error);
    rt.logger.warn(`llm-gateway: 产物拉取失败 ${task.id}#${input.index}: ${message}`);
    fail(502, 'artifact_unavailable', '产物暂时不可用');
    return;
  }

  if (!fetched.response.ok) {
    rt.logger.warn(
      `llm-gateway: 产物上游返回 ${fetched.response.status}（${task.id}#${input.index}）`,
    );
    fail(502, 'artifact_unavailable', '产物暂时不可用');
    return;
  }

  reply.status(fetched.response.status === 206 ? 206 : 200);
  reply.header(
    'content-type',
    fetched.response.headers.get('content-type') ?? 'application/octet-stream',
  );
  const length = fetched.response.headers.get('content-length');
  if (length) reply.header('content-length', length);
  const contentRange = fetched.response.headers.get('content-range');
  if (contentRange) reply.header('content-range', contentRange);
  reply.header('accept-ranges', 'bytes');
  // 签名链接自带鉴权：允许浏览器缓存一小段时间，但**不允许**共享缓存。
  reply.header('cache-control', 'private, max-age=300');

  const body = fetched.response.body;
  if (!body) {
    reply.end();
    return;
  }
  const writer = new BackpressureWriter(reply);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const ok = await writer.write(value);
        if (!ok) break;
      }
    }
  } catch (error) {
    rt.logger.warn(
      `llm-gateway: 产物流出错 ${task.id}#${input.index}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reply.end();
  }
}
/** 从账号上取一个可用 key（产物下载用；多 key 账号任取一个）。 */
async function secretOfAccount(rt: GatewayRuntime, accountId: string): Promise<string | null> {
  const accounts = await listAllAccounts().catch(() => []);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) return null;
  const { pickAccountKey } = await import('./account-keys.js');
  const key = await pickAccountKey(rt.state, account).catch(() => null);
  if (!key) return null;
  return rt.secrets.get(key.apiKeyRef).catch(() => null);
}
