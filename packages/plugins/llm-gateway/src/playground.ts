/**
 * 管理端 Playground（D1）：运营/客服「现在拿这个模型问一句」的入口。
 *
 * 与对手（new-api）的差别，是刻意的：**Playground 不扣用户钱包、不写用量流水**。
 * 它是运营工具，用来回答「这个账号这个模型现在通不通、返回什么样、多快」——把它
 * 做成计费路径会带来两个坏结果：客服替用户排查问题要花用户的钱；以及测试流量混进
 * 对账数据。代价是运营自己可能刷上游额度，所以它只对 `llm-gateway.admin`
 * 开放，并且强制占用账号并发位（与真实流量同一条闸，不会绕过限流把账号压垮）。
 *
 * 也不走 relay 的改写/映射：Playground 要看到的是**上游原始行为**。如果管理员配了
 * 参数改写，经改写后的结果反而无法用来排查「上游到底返回了什么」。
 */
import { codecFor } from '@stackpanel/llm-protocol';

import { resolveAdaptor } from './adaptors/index.js';
import { pickAccountKey } from './account-keys.js';
import { GatewayError } from './errors.js';
import { resolveServedPrice } from './pricing.js';
import { applyWindow } from './pricing-window.js';
import { listPricesForModel } from './repository.js';
import { prepareCall, toAdaptorAccount } from './relay.js';
import { pickAccount } from './routing.js';
import type { GatewayRuntime } from './runtime.js';
import { Scheduler } from './scheduler.js';
import { fetchUpstream } from './upstream.js';

export interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlaygroundInput {
  model: string;
  messages: PlaygroundMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export interface PlaygroundResult {
  /** 上游返回的文本（可能为空：模型只给了工具调用）。 */
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** 端到端耗时（含选号与建连）。 */
  latencyMs: number;
  stopReason: string;
  /** 实际命中的账号，便于运营判断「是不是这个号的问题」。 */
  account: { id: string; name: string; provider: string };
  /** 实际发给上游的模型名（可能与入参不同：定价行/映射表会改写）。 */
  upstreamModel: string;
}

/** 上游返回体在日志/错误里的最大展示长度：够定位问题，不至于把响应全文搬进日志。 */
const UPSTREAM_SNIPPET = 400;

export async function runPlayground(
  rt: GatewayRuntime,
  input: PlaygroundInput,
): Promise<PlaygroundResult> {
  const startedAt = Date.now();
  const served = applyWindow(
    resolveServedPrice(await listPricesForModel(input.model), input.model),
    new Date(),
  );
  const upstreamModel = served.upstreamModel || input.model;

  const scheduler = new Scheduler(rt.state);
  const picked = await pickAccount({
    model: input.model,
    ingress: 'openai-chat',
    affinity: '',
    upstreamModel,
    scheduler,
  });
  if (!picked) {
    throw new GatewayError(503, 'no_account_available', '没有可用的上游账号');
  }

  try {
    const account = toAdaptorAccount(picked.account, await apiKeyOf(rt, picked.account.id));
    const adaptor = resolveAdaptor(picked.account.provider);
    if (!adaptor) {
      throw new GatewayError(503, 'provider_not_supported', '该账号的厂商没有适配器');
    }

    // 入口一律按 OpenAI Chat 的 IR 构造，再由上游协议编码——Playground 只支持对话。
    const ir = codecFor('openai-chat').decodeRequest({
      model: upstreamModel,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
    });
    ir.model = upstreamModel;

    const upstreamCodec = codecFor(adaptor.protocol);
    const call = await prepareCall(
      adaptor,
      account,
      adaptor.buildRequest({
        account,
        body: upstreamCodec.encodeRequest(ir),
        subPath: upstreamCodec.requestPath(ir, false),
        query: new URLSearchParams(),
        stream: false,
        ir,
      }),
    );

    let fetched: Awaited<ReturnType<typeof fetchUpstream>>;
    try {
      fetched = await fetchUpstream(call, {
        timeouts: { connectMs: 20_000, deadlineMs: 120_000 },
      });
    } catch (error) {
      rt.logger.warn(
        `llm-gateway: playground 上游失败 ${picked.account.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new GatewayError(502, 'upstream_unavailable', '上游暂时不可用');
    }

    const bodyText = await fetched.response.text();
    if (!fetched.response.ok) {
      // 用 adaptor 的分类器把厂商特有错误（额度不足/内容审核/上下文超长）翻成稳定码。
      const classified = adaptor.classifyError({
        status: fetched.response.status,
        bodyText: bodyText.slice(0, 8000),
        headers: fetched.response.headers,
      });
      rt.logger.warn(
        `llm-gateway: playground 上游 ${fetched.response.status}: ${bodyText.slice(0, UPSTREAM_SNIPPET)}`,
      );
      throw classified;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new GatewayError(502, 'invalid_upstream_response', '上游返回的不是合法 JSON');
    }

    const response = upstreamCodec.decodeResponse(parsed);
    const usage = upstreamCodec.extractUsage(parsed) ?? response.usage;
    return {
      text: response.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      latencyMs: Date.now() - startedAt,
      stopReason: response.stopReason,
      account: {
        id: picked.account.id,
        name: picked.account.name,
        provider: picked.account.provider,
      },
      upstreamModel,
    };
  } finally {
    // 占位必须归还：Playground 是「临时试一次」，泄漏一个并发位会让真流量少一条通道。
    await rt.state.releaseLease(picked.lease).catch(() => false);
  }
}

async function apiKeyOf(rt: GatewayRuntime, accountId: string): Promise<string> {
  const { listAllAccounts } = await import('./repository.js');
  const accounts = await listAllAccounts().catch(() => []);
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) throw new GatewayError(404, 'account_not_found', '账号不存在');
  const key = await pickAccountKey(rt.state, account).catch(() => null);
  if (!key) throw new GatewayError(503, 'account_key_unavailable', '账号没有可用密钥');
  const secret = await rt.secrets.get(key.apiKeyRef).catch(() => null);
  if (!secret) throw new GatewayError(503, 'account_key_unavailable', '账号密钥不可用');
  return secret;
}
