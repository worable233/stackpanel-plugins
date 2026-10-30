/**
 * 异步任务框架（C1）：数据驱动的提交 / 轮询 / 结算（**不做 JS 沙箱**）。
 *
 * 对手（new-api）的任务插件是一个单文件 ESM：`buildSubmitRequest` /
 * `parseSubmitResponse` / `parseTaskResult`。它灵活，但把「任意代码执行」引进了
 * 计费链路——一次插件升级就可能让账单算错。我们刻意不抄这一点：
 *
 *   任务描述 = 纯数据（路径模板 + 点路径 + 状态词表），由本模块解释执行。
 *
 * 这个取舍换来三件事：
 *
 * 1. **可审计**：描述是 JSON 化的，运维能在管理端看清「这个任务会打哪个路径、
 *    拿哪个字段当状态、按什么计费」，不需要读代码。
 * 2. **可测试**：解释器与描述分离，新增一个厂商只是加一条数据 + 一个 fixture。
 * 3. **计费可复算**：任务提交时用 `reserve` 冻价快照，完成时用**同一个**快照
 *    结算，绝不会因为中途改了价格而算出第二笔账。
 *
 * 状态机：
 *
 *   QUEUED ──提交成功──▶ RUNNING ──轮询到完成──▶ SUCCEEDED（结算）
 *      │                    │
 *      │                    ├──轮询到失败──▶ FAILED（release 全额释放）
 *      │                    ├──客户端取消──▶ CANCELLED（release）
 *      └──提交失败──▶ 不建任务（直接 release + 抛错）
 *
 * 所有终态都会把 `billingRef` 指向的台账关账，不存在「任务结束了钱还冻着」。
 * 冻结 TTL 由描述里的 `ttlMs` 决定，且**必须**覆盖最长轮询窗口：TTL 短于任务
 * 生命周期的后果是内核自动归还冻结、结算时 hold 已不存在。
 */

import { randomUUID } from 'node:crypto';

import { resolveAdaptor, registerBuiltinAdaptors } from './adaptors/index.js';
import type { AdaptorAccount, ProviderAdaptor } from './adaptors/types.js';
import { getBillingByReference, release, reserve, settle } from './billing.js';
import type { BillingContext } from './billing.js';
import { GatewayError } from './errors.js';
import { isAllowedUpstreamUrl } from './guard.js';
import { pickAccountKey } from './account-keys.js';
import { pickAccount } from './routing.js';
import { Scheduler } from './scheduler.js';
import { computeAmount, resolveServedPrice } from './pricing.js';
import { applyWindow } from './pricing-window.js';
import type { ServedPrice, TokenUsage } from './pricing.js';
import { getSetting, listAllAccounts, listAllPrices } from './repository.js';
import type { AccountRow } from './repository.js';
import { createTask, getTask, listDueTasks, updateTask } from './repository.js';
import type { TaskRow } from './repository.js';
import { fetchUpstream, UpstreamFailure } from './upstream.js';
import type { GatewayRuntime } from './runtime.js';

/* ------------------------------ 任务描述 ------------------------------ */

/** 产物来源：公开 URL 直接用；端点模板要求网关带凭据代理（产物不暴露上游 key）。 */
/** 任务产物：公开 URL 直接给；`auth: true` 表示需网关带账号凭据代理下载。 */
export interface TaskArtifact {
  url: string;
  auth: boolean;
}

export interface TaskArtifactSpec {
  /** 轮询响应里可直接取到的产物 URL（点路径，支持数组下标）。 */
  urlPaths: readonly string[];
  /** 相对上游 baseUrl 的产物端点模板（`{upstreamId}` 会被替换），需代理下载。 */
  endpointTemplates: readonly string[];
}

export interface TaskPollSpec {
  /** 轮询路径模板（相对 baseUrl，支持 `{upstreamId}` / `{model}`）。 */
  path: string;
  method: 'GET' | 'POST';
  /** 状态字段点路径。 */
  statusPath: string;
  /** 视为成功的状态词（小写比较）。 */
  done: readonly string[];
  /** 视为失败的状态词（小写比较）。 */
  fail: readonly string[];
  /** 首次轮询延迟与轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 最多轮询次数；超出即判 EXPIRED 并全额释放。 */
  maxAttempts: number;
}

export interface TaskBillingSpec {
  /** 计费单位：按张（图片）、按秒（音视频时长）、按次（固定一次）。 */
  unit: 'image' | 'audio_second' | 'call';
  /** 从轮询响应取「数量」的点路径；缺省时按产物数量、再缺省按 1。 */
  countPath?: string | undefined;
}

export interface TaskDescriptor {
  id: string;
  label: string;
  /** 任务种类：images / video / audio / music。 */
  kind: string;
  /** 提交请求（相对账号 baseUrl）。 */
  submit: { path: string; body: Record<string, unknown> };
  /** 提交响应里的任务 id 点路径。 */
  idPath: string;
  poll: TaskPollSpec;
  artifacts: TaskArtifactSpec;
  billing: TaskBillingSpec;
  /** 允许客户端透传的参数字段（白名单；其余一律拒绝）。 */
  params: readonly string[];
  /** 冻结 TTL：必须覆盖最长轮询窗口。 */
  ttlMs: number;
}

/**
 * 内置任务描述。
 *
 * 只收录「上游确实是异步 submit + poll 语义」的厂商。同步接口（OpenAI
 * `/v1/images/generations`）不需要任务框架——那是普通透传 endpoint。
 */
export const BUILTIN_TASK_DESCRIPTORS: readonly TaskDescriptor[] = [
  {
    id: 'openai-video',
    label: 'OpenAI Videos（Sora）',
    kind: 'video',
    submit: {
      path: '/videos',
      body: {
        model: '{model}',
        prompt: '{prompt}',
        seconds: '{seconds}',
        size: '{size}',
        input_reference: '{input_reference}',
      },
    },
    idPath: 'id',
    poll: {
      path: '/videos/{upstreamId}',
      method: 'GET',
      statusPath: 'status',
      done: ['completed'],
      fail: ['failed', 'cancelled'],
      intervalMs: 5_000,
      maxAttempts: 240,
    },
    artifacts: {
      urlPaths: [],
      endpointTemplates: ['/videos/{upstreamId}/content'],
    },
    billing: { unit: 'image' },
    params: ['prompt', 'seconds', 'size', 'input_reference'],
    ttlMs: 30 * 60 * 1000,
  },
  {
    id: 'kling-video',
    label: '可灵 Kling（文生视频）',
    kind: 'video',
    submit: {
      path: '/v1/videos/text2video',
      body: {
        model_name: '{model}',
        prompt: '{prompt}',
        duration: '{duration}',
        aspect_ratio: '{aspectRatio}',
      },
    },
    idPath: 'data.task_id',
    poll: {
      path: '/v1/videos/text2video/{upstreamId}',
      method: 'GET',
      statusPath: 'data.task_status',
      done: ['succeed'],
      fail: ['failed'],
      intervalMs: 8_000,
      maxAttempts: 150,
    },
    artifacts: {
      urlPaths: ['data.task_result.videos.0.url'],
      endpointTemplates: [],
    },
    billing: { unit: 'call' },
    params: ['prompt', 'duration', 'aspectRatio'],
    ttlMs: 30 * 60 * 1000,
  },
];

const REGISTRY = new Map<string, TaskDescriptor>();

/** 注册（或覆盖）一个任务描述；扩展点用它注入自定义厂商。 */
export function registerTaskDescriptor(descriptor: TaskDescriptor): void {
  const invalid = validateTaskDescriptor(descriptor);
  if (invalid) throw new Error(`invalid task descriptor ${descriptor.id}: ${invalid}`);
  REGISTRY.set(descriptor.id, descriptor);
}

function registerBuiltinTaskDescriptors(): void {
  for (const descriptor of BUILTIN_TASK_DESCRIPTORS) {
    const invalid = validateTaskDescriptor(descriptor);
    // 内置描述写错属于编译期问题，启动时就该炸，而不是等用户点击提交。
    if (invalid) throw new Error(`invalid builtin task descriptor ${descriptor.id}: ${invalid}`);
    REGISTRY.set(descriptor.id, descriptor);
  }
}

// 模块加载即注册内置描述：描述是纯数据，注册无副作用，且让 `getTaskDescriptor`
// 在任何入口（HTTP 路由、管理端、测试）都能直接工作，不依赖「先调一次提交」。
registerBuiltinTaskDescriptors();

export function getTaskDescriptor(id: string): TaskDescriptor | null {
  return REGISTRY.get(id.trim()) ?? null;
}

export function listTaskDescriptors(): readonly TaskDescriptor[] {
  return [...REGISTRY.values()];
}

/** 描述的静态校验；返回中文原因或 null。 */
export function validateTaskDescriptor(descriptor: TaskDescriptor): string | null {
  if (!descriptor.id.trim()) return '任务描述缺少 id';
  if (!descriptor.submit.path.startsWith('/')) return '提交路径必须以 / 开头';
  if (!descriptor.poll.path.startsWith('/')) return '轮询路径必须以 / 开头';
  if (!descriptor.poll.statusPath.trim()) return '轮询缺少状态字段';
  if (descriptor.poll.done.length === 0) return '轮询缺少成功状态词';
  if (descriptor.poll.intervalMs <= 0) return '轮询间隔必须大于 0';
  if (descriptor.poll.maxAttempts <= 0) return '轮询次数必须大于 0';
  if (descriptor.ttlMs <= 0) return '冻结 TTL 必须大于 0';
  const windowMs = descriptor.poll.intervalMs * descriptor.poll.maxAttempts + 60_000;
  if (descriptor.ttlMs < windowMs) return '冻结 TTL 必须覆盖整个轮询窗口';
  if (
    descriptor.artifacts.urlPaths.length === 0 &&
    descriptor.artifacts.endpointTemplates.length === 0
  ) {
    return '必须至少声明一种产物来源';
  }
  return null;
}

/* ------------------------------ 模板与点路径 ------------------------------ */

/**
 * 把 `{name}` 占位替换成变量值。
 *
 * 未提供的变量**整段移除**（返回 undefined）而不是替换成 `{name}` 字符串：
 * 上游收到字面量 `{seconds}` 会直接 400，而漏传一个可选参数是合法情况。
 */
export function fillTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>>,
): string | null {
  let missing = false;
  const out = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null || value === '') {
      missing = true;
      return '';
    }
    return String(value);
  });
  return missing ? null : out;
}

/** 填充一个对象模板：值为模板字符串的字段逐个替换，缺变量则整键省略。 */
export function fillBody(
  template: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === 'string') {
      const filled = fillTemplate(value, variables);
      if (filled !== null) out[key] = filled;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 按点路径读值，支持数组下标（`data.videos.0.url`）。 */
export function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 状态归一：命中 done / fail 词表（大小写不敏感）。 */
export function classifyTaskStatus(
  raw: unknown,
  poll: Pick<TaskPollSpec, 'done' | 'fail'>,
): 'RUNNING' | 'SUCCEEDED' | 'FAILED' {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === '') return 'RUNNING';
  if (poll.done.some((word) => word.toLowerCase() === value)) return 'SUCCEEDED';
  if (poll.fail.some((word) => word.toLowerCase() === value)) return 'FAILED';
  return 'RUNNING';
}

/* ------------------------------ 计费上下文重建 ------------------------------ */

/**
 * 从台账快照重建计费上下文（任务完成时用）。
 *
 * 为什么必须走快照：任务可能跨小时完成，期间管理员完全可能改价。用现价结算
 * 会让同一个任务在「提交时看到的价格」和「扣款金额」上不一致——这是对手
 * (new-api) 被投诉最多的一类问题。
 */
function restoreContext(
  entry: NonNullable<Awaited<ReturnType<typeof getBillingByReference>>>,
): BillingContext {
  const snapshot = entry.priceSnapshot;
  const price: ServedPrice = {
    publicModel: String(snapshot.publicModel ?? entry.model),
    upstreamModel: String(snapshot.upstreamModel ?? entry.model),
    inputPrice: Number(snapshot.inputPrice ?? 0),
    outputPrice: Number(snapshot.outputPrice ?? 0),
    cacheReadPrice: Number(snapshot.cacheReadPrice ?? 0),
    cacheWritePrice: Number(snapshot.cacheWritePrice ?? 0),
    reasoningPrice: Number(snapshot.reasoningPrice ?? 0),
    imagePrice: Number(snapshot.imagePrice ?? 0),
    audioPrice: Number(snapshot.audioPrice ?? 0),
    costInputPrice: Number(snapshot.costInputPrice ?? 0),
    costOutputPrice: Number(snapshot.costOutputPrice ?? 0),
    costCacheReadPrice: Number(snapshot.costCacheReadPrice ?? 0),
    costCacheWritePrice: Number(snapshot.costCacheWritePrice ?? 0),
    costReasoningPrice: Number(snapshot.costReasoningPrice ?? 0),
    costImagePrice: Number(snapshot.costImagePrice ?? 0),
    costAudioPrice: Number(snapshot.costAudioPrice ?? 0),
    tiers: Array.isArray(snapshot.tiers)
      ? (snapshot.tiers as NonNullable<ServedPrice['tiers']>)
      : [],
    maxOutputTokens: Number(snapshot.maxOutputTokens ?? 0),
    groupDiscount: snapshot.groupDiscount === true,
    strategy: String(snapshot.strategy ?? ''),
    expr: String(snapshot.expr ?? ''),
    multiplier: Number(snapshot.multiplier ?? 100),
  };
  const holdId = entry.holdId ?? null;
  return {
    referenceId: entry.referenceId,
    userId: entry.userId,
    apiKeyId: entry.apiKeyId,
    accountId: entry.accountId ?? null,
    model: entry.model,
    currency: entry.currency,
    price,
    priceSnapshot: snapshot,
    discountPercent: Number(snapshot.discountPercent ?? 0),
    upstreamKeyId: '',
    entitlementId: entry.entitlementId ?? null,
    entitlementAmount: 0,
    // 只用到 `hold.id`（settleHold / releaseHold），其余字段在重建路径上无意义。
    hold: holdId ? ({ id: holdId } as BillingContext['hold']) : null,
    entryId: entry.id,
  };
}

/** 任务数量 → 计费用量。 */
function usageOf(descriptor: TaskDescriptor, count: number): TokenUsage {
  const amount = Math.max(0, Math.round(count));
  if (descriptor.billing.unit === 'image') {
    return { promptTokens: 0, completionTokens: 0, imageCount: amount };
  }
  if (descriptor.billing.unit === 'audio_second') {
    return { promptTokens: 0, completionTokens: 0, audioSeconds: amount };
  }
  return { promptTokens: 0, completionTokens: 0, imageCount: amount };
}

function estimateAmount(price: ServedPrice, descriptor: TaskDescriptor): number {
  return computeAmount(price, usageOf(descriptor, 1));
}

/* ------------------------------ 运行时辅助 ------------------------------ */

function schedulerOf(rt: GatewayRuntime): Scheduler {
  return new Scheduler(rt.state);
}

function toAdaptorAccount(
  row: { id: string; name: string; baseUrl: string; options?: unknown },
  apiKey: string,
): AdaptorAccount {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    apiKey,
    options: (row.options ?? {}) as Readonly<Record<string, unknown>>,
  };
}

/** 读取上游响应体，超过上限则截断（任务响应是 JSON，不需要流式）。 */
async function readJsonBody(response: Response, limit = 1_000_000): Promise<unknown> {
  const text = await response.text();
  const sliced = text.length > limit ? text.slice(0, limit) : text;
  try {
    return JSON.parse(sliced) as unknown;
  } catch {
    return null;
  }
}

function clientParamsOf(
  descriptor: TaskDescriptor,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!descriptor.params.includes(key)) {
      throw new GatewayError(400, 'invalid_task_param', `不支持的参数：${key}`);
    }
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  }
  const prompt = out.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new GatewayError(400, 'invalid_task_param', '任务参数缺少 prompt');
  }
  return out;
}

/* ------------------------------ 提交 ------------------------------ */

export interface SubmitTaskInput {
  userId: string;
  apiKeyId: string;
  descriptorId: string;
  model: string;
  params: Readonly<Record<string, unknown>>;
  currency: string;
  clientIp?: string | null | undefined;
}

/**
 * 提交一个异步任务。
 *
 * 顺序纪律与 relay 一致：**先预留再选号**（否则余额不足的请求会白占上游并发位）。
 * 提交失败则 `release` 全额归还，不写账单——请求根本没产生消耗。
 */
export async function submitTask(rt: GatewayRuntime, input: SubmitTaskInput): Promise<TaskRow> {
  registerBuiltinAdaptors();
  const descriptor = getTaskDescriptor(input.descriptorId);
  if (!descriptor) throw new GatewayError(404, 'unknown_task_descriptor', '未知的任务类型');
  const params = clientParamsOf(descriptor, input.params);

  // 与同步转发同一道闸：计费未开启的用户不该通过任务入口花掉钱包余额。
  const setting = await getSetting(input.userId).catch(() => null);
  if (!setting?.billingEnabled) {
    throw new GatewayError(403, 'billing_disabled', 'API 计费未开启，请先在账户中心开启');
  }

  const prices = await listAllPrices();
  // 时段价必须在**提交时刻**烘进快照：异步任务轮询可能跨过时段边界，
  // 若等到结算再算，一笔请求会按它没发生的时段计价。
  const price = applyWindow(resolveServedPrice(prices, input.model), new Date());
  const referenceId = randomUUID();
  const context = await reserve({
    wallet: rt.wallet,
    logger: rt.logger,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    accountId: null,
    model: input.model,
    currency: input.currency,
    price,
    amount: estimateAmount(price, descriptor),
    note: `异步任务 ${descriptor.id}`,
    ttlMs: descriptor.ttlMs,
    discountPercent: 0,
    upstreamKeyId: '',
  });

  const scheduler = schedulerOf(rt);
  const picked = await pickAccount({
    model: input.model,
    ingress: 'openai-chat',
    affinity: '',
    upstreamModel: price.upstreamModel,
    scheduler,
  });
  if (!picked) {
    await release(rt.wallet, rt.logger, context);
    throw new GatewayError(502, 'no_upstream', '暂无可用上游账号');
  }

  const key = await pickAccountKey(rt.state, picked.account);
  const secret = key ? await rt.secrets.get(key.apiKeyRef).catch(() => null) : null;
  if (!key || !secret) {
    await scheduler.releaseAccountLease(picked.lease).catch(() => false);
    await release(rt.wallet, rt.logger, context);
    throw new GatewayError(502, 'no_upstream_key', '上游账号凭证缺失');
  }

  let adaptor: ProviderAdaptor | null = null;
  try {
    adaptor = resolveAdaptor(picked.account.provider);
    if (!adaptor) throw new GatewayError(400, 'unknown_provider', '未知的上游 provider');
    const account = toAdaptorAccount(picked.account, secret);
    const variables: Record<string, unknown> = {
      ...params,
      model: price.upstreamModel || input.model,
    };
    const path = fillTemplate(descriptor.submit.path, variables);
    if (path === null) throw new GatewayError(400, 'invalid_task_param', '提交参数不完整');
    const url = `${account.baseUrl}${path}`;
    if (!isAllowedUpstreamUrl(url)) {
      throw new GatewayError(400, 'invalid_upstream', '上游地址必须为公网地址');
    }
    const body = fillBody(descriptor.submit.body, variables);
    const started = Date.now();
    const fetched = await fetchUpstream(
      {
        url,
        method: 'POST',
        headers: {
          ...adaptor.authHeaders(account),
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      },
      { timeouts: { connectMs: 30_000, deadlineMs: 60_000 } },
    );
    const payload = await readJsonBody(fetched.response);
    if (!fetched.response.ok) {
      await release(rt.wallet, rt.logger, context);
      rt.logger.warn(
        `llm-gateway: 任务提交失败 ${descriptor.id} status=${fetched.response.status} ` +
          `body=${JSON.stringify(payload ?? null).slice(0, 300)}`,
      );
      throw new GatewayError(
        fetched.response.status === 429 ? 429 : 502,
        'task_submit_failed',
        '上游拒绝了任务提交',
      );
    }
    const upstreamId = readPath(payload, descriptor.idPath);
    if (typeof upstreamId !== 'string' && typeof upstreamId !== 'number') {
      await release(rt.wallet, rt.logger, context);
      rt.logger.error(
        `llm-gateway: 任务提交响应缺少 id（${descriptor.idPath}）: ` +
          `${JSON.stringify(payload ?? null).slice(0, 300)}`,
      );
      throw new GatewayError(502, 'task_submit_failed', '上游未返回任务 id');
    }

    const task = await createTask({
      userId: input.userId,
      kind: descriptor.kind,
      endpoint: descriptor.id,
      upstreamId: String(upstreamId),
      model: input.model,
      status: 'QUEUED',
      upstreamStatus: 'submitted',
      billingRef: referenceId,
      error: null,
      accountId: picked.account.id,
      descriptorId: descriptor.id,
      apiKeyId: input.apiKeyId,
      currency: input.currency,
      requestSpec: JSON.stringify({
        params,
        upstreamModel: price.upstreamModel || input.model,
        latencyMs: Date.now() - started,
        clientIp: input.clientIp ?? null,
      }),
      attempts: 0,
      nextPollAt: Date.now() + descriptor.poll.intervalMs,
      expiresAt: Date.now() + descriptor.ttlMs - 60_000,
      artifacts: null,
      resultRef: null,
    });
    return task;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    await release(rt.wallet, rt.logger, context).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    rt.logger.warn(`llm-gateway: 任务提交异常 ${descriptor.id}: ${message}`);
    throw new GatewayError(502, 'task_submit_failed', '任务提交失败');
  } finally {
    await scheduler.releaseAccountLease(picked.lease).catch(() => false);
  }
}

/* ------------------------------ 轮询与结算 ------------------------------ */

export interface PollOutcome {
  task: TaskRow;
  /** 本次是否走到了终态。 */
  finished: boolean;
}

/** 终态收尾：成功结算、失败/取消/超时全额释放。 */
async function finishTask(
  rt: GatewayRuntime,
  task: TaskRow,
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED',
  detail: {
    usage?: TokenUsage | undefined;
    artifacts?: TaskArtifact[] | undefined;
    error?: string | null;
  },
): Promise<TaskRow> {
  const referenceId = task.billingRef ?? '';
  const entry = referenceId ? await getBillingByReference(referenceId).catch(() => null) : null;
  let settled = false;
  if (entry) {
    const context = restoreContext(entry);
    if (status === 'SUCCEEDED') {
      const usage = detail.usage ?? { promptTokens: 0, completionTokens: 0 };
      const result = await settle({
        wallet: rt.wallet,
        logger: rt.logger,
        context,
        usage,
        estimated: true,
        protocol: 'tasks',
        endpoint: task.endpoint,
        status: 'SUCCESS',
        httpStatus: 200,
        latencyMs: null,
      }).catch((error: unknown) => {
        rt.logger.error(
          `llm-gateway: 任务结算失败 ${task.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });
      settled = result !== null;
    } else {
      await release(rt.wallet, rt.logger, context).catch(() => undefined);
      settled = true;
    }
  }
  const updated = await updateTask(task.id, {
    status,
    upstreamStatus: task.upstreamStatus ?? null,
    resultRef: detail.artifacts?.[0]?.url ?? task.resultRef ?? null,
    artifacts: detail.artifacts ? JSON.stringify(detail.artifacts) : (task.artifacts ?? null),
    error: detail.error ?? (status === 'SUCCEEDED' ? null : '任务未完成'),
    attempts: task.attempts ?? 0,
    nextPollAt: settled ? null : Date.now() + 60_000,
  });
  return updated ?? task;
}

/**
 * 轮询一次任务。
 *
 * 只做一次上游请求：由 job 决定节奏，避免「一次调用里循环等待」把 worker 占死。
 * 失败（网络/5xx）不算任务失败——只增加 attempts 并推后下次轮询，**不**释放冻结：
 * 上游只是暂时联系不上，任务可能仍在跑。
 */
export async function pollTask(rt: GatewayRuntime, task: TaskRow): Promise<PollOutcome> {
  const descriptor = task.descriptorId ? getTaskDescriptor(task.descriptorId) : null;
  if (!descriptor) {
    const failed = await finishTask(rt, task, 'FAILED', { error: '任务描述已不存在' });
    return { task: failed, finished: true };
  }
  const attempts = (task.attempts ?? 0) + 1;
  const now = Date.now();
  if (attempts > descriptor.poll.maxAttempts || now > (task.expiresAt ?? Number.MAX_SAFE_INTEGER)) {
    const expired = await finishTask(rt, task, 'EXPIRED', { error: '任务超时' });
    return { task: { ...expired, attempts }, finished: true };
  }

  const accountId = task.accountId;
  if (!accountId) {
    const failed = await finishTask(rt, task, 'FAILED', { error: '任务缺少上游账号' });
    return { task: failed, finished: true };
  }

  const accounts = await listAllAccountsSafe();
  const row = accounts.find((entry) => entry.id === accountId) ?? null;
  if (!row) {
    const failed = await finishTask(rt, task, 'FAILED', { error: '上游账号已被删除' });
    return { task: failed, finished: true };
  }
  const adaptor = resolveAdaptor(row.provider);
  if (!adaptor) {
    const failed = await finishTask(rt, task, 'FAILED', { error: '未知的 provider' });
    return { task: failed, finished: true };
  }

  const spec = parseTaskSpec(task);
  const key = await pickAccountKey(rt.state, row);
  const secret = key ? await rt.secrets.get(key.apiKeyRef).catch(() => null) : null;
  if (!key || !secret) {
    // 凭证缺失是可恢复的：下一个 job 周期再来（多 key 账号可能正在轮换）。
    return {
      task:
        (await updateTask(task.id, {
          attempts,
          nextPollAt: now + descriptor.poll.intervalMs,
        })) ?? task,
      finished: false,
    };
  }
  const account = toAdaptorAccount(row, secret);
  const variables: Record<string, unknown> = {
    upstreamId: task.upstreamId ?? '',
    model: spec.upstreamModel,
  };
  const path = fillTemplate(descriptor.poll.path, variables);
  if (path === null) {
    const failed = await finishTask(rt, task, 'FAILED', { error: '轮询路径不完整' });
    return { task: failed, finished: true };
  }
  const url = `${account.baseUrl}${path}`;
  if (!isAllowedUpstreamUrl(url)) {
    const failed = await finishTask(rt, task, 'FAILED', { error: '上游地址非法' });
    return { task: failed, finished: true };
  }

  let payload: unknown = null;
  let httpStatus: number | null = null;
  try {
    const fetched = await fetchUpstream(
      {
        url,
        method: descriptor.poll.method,
        headers: adaptor.authHeaders(account),
      },
      { timeouts: { connectMs: 20_000, deadlineMs: 30_000 } },
    );
    httpStatus = fetched.response.status;
    payload = await readJsonBody(fetched.response);
  } catch (error) {
    const message = error instanceof UpstreamFailure ? error.message : String(error);
    rt.logger.warn(`llm-gateway: 任务轮询失败 ${task.id}: ${message}`);
    return {
      task:
        (await updateTask(task.id, {
          attempts,
          nextPollAt: now + descriptor.poll.intervalMs,
          error: `轮询失败：${message}`.slice(0, 300),
        })) ?? task,
      finished: false,
    };
  }

  const rawStatus = readPath(payload, descriptor.poll.statusPath);
  const upstreamStatus = String(rawStatus ?? '').slice(0, 64);
  const state = classifyTaskStatus(rawStatus, descriptor.poll);

  if (state === 'RUNNING') {
    const status = httpStatus !== null && httpStatus >= 400 ? task.status : 'RUNNING';
    return {
      task:
        (await updateTask(task.id, {
          status,
          upstreamStatus,
          attempts,
          nextPollAt: now + descriptor.poll.intervalMs,
        })) ?? task,
      finished: false,
    };
  }

  if (state === 'FAILED') {
    const finished = await finishTask(rt, task, 'FAILED', {
      error: `上游任务失败：${upstreamStatus || 'unknown'}`.slice(0, 300),
    });
    return { task: { ...finished, attempts, upstreamStatus }, finished: true };
  }

  const artifacts = collectArtifacts(descriptor, payload, task.upstreamId ?? '');
  const count = taskCount(descriptor, payload, artifacts.length);
  const finished = await finishTask(rt, task, 'SUCCEEDED', {
    usage: usageOf(descriptor, count),
    artifacts,
  });
  return { task: { ...finished, attempts, upstreamStatus }, finished: true };
}

/** 从轮询响应里收集产物（公开 URL 直接留；端点模板存相对路径，下载时再拼）。 */
export function collectArtifacts(
  descriptor: TaskDescriptor,
  payload: unknown,
  upstreamId: string,
): TaskArtifact[] {
  const out: TaskArtifact[] = [];
  for (const path of descriptor.artifacts.urlPaths) {
    const value = readPath(payload, path);
    if (typeof value === 'string' && value.trim() !== '') {
      out.push({ url: value.trim(), auth: false });
    }
  }
  for (const template of descriptor.artifacts.endpointTemplates) {
    // 端点模板是**相对路径**：绝对地址在下载时用账号 baseUrl 拼，权限用账号凭据，
    // 因此产物链接里永远不出现上游 key。
    const filled = template.replace('{upstreamId}', upstreamId);
    if (filled) out.push({ url: filled, auth: true });
  }
  return out;
}

function taskCount(descriptor: TaskDescriptor, payload: unknown, artifactCount: number): number {
  if (descriptor.billing.countPath) {
    const value = Number(readPath(payload, descriptor.billing.countPath));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return Math.max(1, artifactCount);
}

export interface TaskSpec {
  params: Record<string, unknown>;
  upstreamModel: string;
  latencyMs: number;
  clientIp: string | null;
}

function parseTaskSpec(task: TaskRow): TaskSpec {
  try {
    const parsed = JSON.parse(task.requestSpec ?? '{}') as Partial<TaskSpec>;
    return {
      params: (parsed.params ?? {}) as Record<string, unknown>,
      upstreamModel: String(parsed.upstreamModel ?? task.model ?? ''),
      latencyMs: Number(parsed.latencyMs ?? 0),
      clientIp: parsed.clientIp ?? null,
    };
  } catch {
    return { params: {}, upstreamModel: task.model ?? '', latencyMs: 0, clientIp: null };
  }
}

/** 账号列表（失败降级为空，避免一次 DB 抖动把任务判死）。 */
async function listAllAccountsSafe(): Promise<AccountRow[]> {
  return listAllAccounts().catch(() => []);
}

/* ------------------------------ 执行器 ------------------------------ */

export const TASK_POLL_INTERVAL_MS = 15_000;
const TASK_BATCH = 10;

/**
 * 执行器一轮：把到期的 QUEUED / RUNNING 任务推进一格。
 *
 * 顺序处理（不并行）：单个上游可能限流，一批任务同时打过去只会让它们一起失败。
 * 每轮上限 10 个，保证一个卡住的上游不会吃满 job 的时间片。
 */
export async function runTaskTick(rt: GatewayRuntime, now = Date.now()): Promise<number> {
  const due = await listDueTasks(now, TASK_BATCH).catch(() => []);
  let processed = 0;
  for (const task of due) {
    try {
      await pollTask(rt, task);
      processed += 1;
    } catch (error) {
      rt.logger.warn(
        `llm-gateway: 任务推进失败 ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return processed;
}

/** 用户取消：释放冻结并把任务标成 CANCELLED（上游是否真的停由厂商决定）。 */
export async function cancelTask(
  rt: GatewayRuntime,
  task: TaskRow,
  userId: string,
): Promise<TaskRow> {
  if (task.userId !== userId) throw new GatewayError(404, 'task_not_found', '任务不存在');
  if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(task.status)) {
    return task;
  }
  return finishTask(rt, task, 'CANCELLED', { error: '用户取消' });
}

/** 读任务并校验归属（用户端路由用；不存在与不属于本人一律 404，避免探测）。 */
export async function requireTask(taskId: string, userId: string): Promise<TaskRow> {
  const task = await getTask(taskId);
  if (!task || task.userId !== userId) {
    throw new GatewayError(404, 'task_not_found', '任务不存在');
  }
  return task;
}
