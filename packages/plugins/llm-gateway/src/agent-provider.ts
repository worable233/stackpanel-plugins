import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { defineModel, LlmProviderError, PluginError } from '@stackpanel/sdk';
import type { LlmProvider, LlmCompletionResult, LlmCompletionRequest, RawHttpReply, HttpRequest } from '@stackpanel/sdk';
import { z } from 'zod';
import { extensions, secrets, auth } from './context.js';
import { listEnabledPrices } from './repository.js';
import { createRelayHandler } from './relay.js';
import type { GatewayRuntime } from './runtime.js';
import { GATEWAY_SCOPE } from './keys.js';

const SPONSOR = 'agent.sponsor';
export const gatewayAgentCallModel = defineModel({ kind: 'llm-gateway/agent-call', label: 'Agent 推理幂等记录',
  schema: z.object({ hash: z.string(), status: z.enum(['STARTED', 'DONE']), result: z.unknown().optional() }) });
type CallRow = { hash: string; status: 'STARTED' | 'DONE'; result?: unknown };
export async function agentProviderConfig(): Promise<{ configured: boolean }> { return { configured: Boolean(await secrets().get(SPONSOR)) }; }
export async function configureAgentProvider(request: HttpRequest): Promise<{ configured: boolean }> {
  const input = z.object({ token: z.string().min(1).max(8192) }).strict().parse(request.body);
  const inspection = await auth().inspectPlatformToken(input.token, request.ip);
  if (!request.user || !inspection || inspection.token.userId !== request.user.id || !inspection.active || inspection.expired || !inspection.ipAllowed ||
    !inspection.token.scopes.includes(GATEWAY_SCOPE) || !(await auth().hasPermission(request.user.id, GATEWAY_SCOPE))) {
    throw new PluginError('llm_gateway.agent_sponsor_invalid', 403, '请提供本人有效、已授权模型服务的专用平台 Key');
  }
  await secrets().set(SPONSOR, JSON.stringify({ token: input.token, ip: request.ip ?? '127.0.0.1' }));
  return { configured: true };
}
export async function clearAgentProvider(): Promise<{ configured: boolean }> { await secrets().remove(SPONSOR); return { configured: false }; }

function openAiBody(request: LlmCompletionRequest): Record<string, unknown> {
  const messages: unknown[] = request.system ? [{ role: 'system', content: request.system }] : [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId,
        content: message.parts.map((part) => part.type === 'tool-result' ? part.content : part.type === 'text' ? part.text : '').join('\n') });
    } else {
      const calls = message.parts.filter((part) => part.type === 'tool-call');
      messages.push({ role: message.role, content: message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || null,
        ...(calls.length ? { tool_calls: calls.map((part) => ({ id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments } })) } : {}) });
    }
  }
  return { model: request.model, messages, stream: false, max_tokens: request.maxTokens ?? 4096,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: request.toolChoice ?? 'auto' } : {}) };
}

/** Site-funded inference still enters the gateway's ordinary auth, quota, pool and billing relay. */
export function createAgentProvider(getRuntime: () => GatewayRuntime | null): LlmProvider & { available(): Promise<boolean> } {
  return {
    id: 'llm-gateway', name: '模型服务网关', available: async () => Boolean(await secrets().get(SPONSOR)),
    listModels: async () => (await listEnabledPrices()).filter((row) => row.model !== '*').map((row) => ({
      id: row.model, label: row.model, supportsTools: true,
      inputPriceMinorPerMillion: Math.max(row.inputPrice, row.cacheReadPrice ?? 0, row.cacheWritePrice ?? 0) * row.multiplier / 100,
      outputPriceMinorPerMillion: Math.max(row.outputPrice, row.reasoningPrice ?? 0) * row.multiplier / 100,
    })),
    complete: async (request, options) => {
      const stored = await secrets().get(SPONSOR);
      if (!stored) throw new LlmProviderError('provider_unavailable', '尚未配置站点 Agent 模型付款凭证', false);
      const sponsor = z.object({ token: z.string(), ip: z.string() }).parse(JSON.parse(stored));
      const name = createHash('sha256').update(`${options.actorId}:${options.callId}`).digest('hex');
      const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const existing = await extensions().get<CallRow>(gatewayAgentCallModel, name);
      if (existing) {
        if (existing.spec.hash !== hash) throw new LlmProviderError('invalid_request', '同一推理幂等键的参数不一致', false);
        if (existing.spec.status === 'DONE') return existing.spec.result as LlmCompletionResult;
        throw new LlmProviderError('upstream_error', '此前调用结果不明，已阻止重复计费，请核对台账', false);
      }
      await extensions().create(gatewayAgentCallModel, { hash, status: 'STARTED' }, { name });
      const payload = JSON.stringify(openAiBody(request));
      const chunks: Buffer[] = []; const headers = new Map<string, string>();
      let status = 200, bytes = 0, closed: (() => void) | undefined;
      const native = { headersSent: false };
      const reply: RawHttpReply = {
        raw: native, status(code) { status = code; return this; },
        header(key, value) { headers.set(key.toLowerCase(), Array.isArray(value) ? value.join(',') : value); return this; },
        write(chunk) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 1024 * 1024) throw new Error('Agent 模型响应过大'); chunks.push(data); return true; },
        drain: async () => {}, end(body) { if (body) this.write(body); native.headersSent = true; },
        hijack() {}, onClientClose(fn) { closed = fn; },
      };
      const deadline = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const signal = options.signal && typeof options.signal.addEventListener === 'function' ? AbortSignal.any([options.signal, deadline]) : deadline;
      const onAbort = () => closed?.(); signal.addEventListener('abort', onAbort, { once: true });
      try {
        await createRelayHandler(getRuntime)({ method: 'POST', url: '/llm-gateway/v1/chat/completions', params: { '*': 'v1/chat/completions' }, query: new URLSearchParams(),
          headers: { authorization: `Bearer ${sponsor.token}`, 'content-type': 'application/json', 'idempotency-key': name }, body: Readable.from([payload]), ip: sponsor.ip, raw: {} }, reply);
      } finally { signal.removeEventListener('abort', onAbort); }
      if (status >= 400) throw new LlmProviderError(status === 429 ? 'rate_limited' : 'upstream_error', `模型网关拒绝推理（${status}）`, false);
      const parsed = z.object({ model: z.string(), choices: z.array(z.object({ finish_reason: z.string().nullable(), message: z.object({ content: z.string().nullable().optional(),
        tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }) })),
        usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }) }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const choice = parsed.choices[0];
      if (!choice) throw new LlmProviderError('upstream_error', '模型未返回有效回答', false);
      const charged = headers.get('x-stackpanel-charge-minor');
      const costMinor = charged === undefined ? NaN : Number(charged);
      if (!Number.isSafeInteger(costMinor) || costMinor < 0) throw new LlmProviderError('upstream_error', '模型账单金额不可确认', false);
      const result: LlmCompletionResult = { model: parsed.model,
        parts: [...(choice.message.content ? [{ type: 'text' as const, text: choice.message.content }] : []),
          ...(choice.message.tool_calls ?? []).map((call) => ({ type: 'tool-call' as const, id: call.id, name: call.function.name, arguments: call.function.arguments }))],
        stopReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : 'error',
        usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens, totalTokens: parsed.usage.total_tokens }, costMinor };
      await extensions().update(gatewayAgentCallModel, name, { hash, status: 'DONE', result });
      return result;
    },
  };
}
