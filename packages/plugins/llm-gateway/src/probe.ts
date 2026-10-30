/**
 * 上游探测（A2）：测活与余额查询。
 *
 * 两个动作都**只读**，不改变账号状态（余额快照写入由调用方负责）：
 *
 * 1. `probeAccount`：拉一次上游的模型清单。能拉到就说明「地址 + 凭证 + 网络」
 *    三者都通；顺带回答「这个账号到底有没有某个模型」。比发一次付费推理便宜，
 *    也是运维最常用的「这号还活着吗」。
 * 2. `fetchBalance`：按厂商适配余额接口。只支持确实有公开余额接口的少数几家；
 *    其余返回 `supported: false`（明确说「查不到」而不是伪造 0）。
 *
 * 纪律：URL 必须过 SSRF 校验（`guard.ts`），并且只允许 http(s)。
 */

import { isAllowedUpstreamUrl } from './guard.js';

export interface ProbeTarget {
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** 想确认是否存在的模型名（可空）。 */
  model?: string | undefined;
}

export interface ProbeResult {
  ok: boolean;
  /** 上游 HTTP 状态码；网络失败为 null。 */
  status: number | null;
  latencyMs: number;
  /** 上游返回的模型 id（最多 200 个，够看即可）。 */
  models: string[];
  /** 目标模型是否存在；未指定 model 时为 null。 */
  hasModel: boolean | null;
  message: string | null;
}

export interface BalanceResult {
  supported: boolean;
  /** 币种（USD/CNY/…）；未知为空串。 */
  currency: string;
  /** 余额（**主单位**，如美元元）；未知为 null。 */
  amount: number | null;
  message: string | null;
  checkedAt: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const MAX_MODELS = 200;

/** 上游模型清单请求（与 `admin/upstream-models` 同一口径）。 */
function modelsRequest(
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
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  return { url, headers: { authorization: `Bearer ${apiKey}` } };
}

/** 从模型清单响应里提取 id（OpenAI / Anthropic / Gemini 三种形态）。 */
function modelIds(payload: unknown): string[] {
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
      if (id) ids.add(id.replace(/^models\//, ''));
    }
  }
  return [...ids].sort();
}

/** 测活：拉模型清单。 */
export async function probeAccount(target: ProbeTarget): Promise<ProbeResult> {
  const request = modelsRequest(target.provider, target.baseUrl, target.apiKey);
  if (!isAllowedUpstreamUrl(request.url)) {
    return {
      ok: false,
      status: null,
      latencyMs: 0,
      models: [],
      hasModel: null,
      message: '上游地址必须为公网地址',
    };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(request.url, {
      headers: { ...request.headers, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const payload = (await response.json().catch(() => null)) as unknown;
    const models = modelIds(payload).slice(0, MAX_MODELS);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        models,
        hasModel: null,
        message: `上游返回 ${response.status}`,
      };
    }
    const wanted = target.model?.trim() ?? '';
    return {
      ok: true,
      status: response.status,
      latencyMs,
      models,
      hasModel: wanted.length > 0 ? models.includes(wanted) : null,
      message: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      models: [],
      hasModel: null,
      message: error instanceof Error ? error.message.slice(0, 200) : '上游不可达',
    };
  }
}

/** baseUrl 的 origin（去掉路径），用于拼厂商私有的余额接口。 */
function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 余额查询。支持：OpenRouter、DeepSeek、Moonshot、硅基流动。
 * 其它厂商返回 `supported: false`——OpenAI/Anthropic 没有公开余额接口。
 */
export async function fetchBalance(target: ProbeTarget): Promise<BalanceResult> {
  const checkedAt = new Date().toISOString();
  const base = target.baseUrl.replace(/\/+$/, '');
  const origin = originOf(target.baseUrl);
  const provider = target.provider;

  let url: string;
  let headers: Record<string, string> = { accept: 'application/json' };
  let extract: (payload: unknown) => { currency: string; amount: number | null };

  if (provider === 'openrouter') {
    url = `${origin}/api/v1/credits`;
    headers = { ...headers, authorization: `Bearer ${target.apiKey}` };
    extract = (payload) => {
      const data = (payload as { data?: Record<string, unknown> } | null)?.data ?? {};
      const total = readNumber(data['total_credits']);
      const used = readNumber(data['total_usage']);
      const remaining = total !== null && used !== null ? total - used : null;
      return { currency: 'USD', amount: remaining };
    };
  } else if (provider === 'deepseek') {
    url = `${base}/user/balance`;
    headers = { ...headers, authorization: `Bearer ${target.apiKey}` };
    extract = (payload) => {
      const infos = (payload as { balance_infos?: unknown } | null)?.balance_infos;
      const first = Array.isArray(infos)
        ? (infos[0] as Record<string, unknown> | undefined)
        : undefined;
      return {
        currency: readString(first?.['currency']) || 'CNY',
        amount: readNumber(first?.['total_balance']),
      };
    };
  } else if (provider === 'moonshot') {
    url = `${origin}/v1/users/me/balance`;
    headers = { ...headers, authorization: `Bearer ${target.apiKey}` };
    extract = (payload) => {
      const data = (payload as { data?: Record<string, unknown> } | null)?.data ?? {};
      return {
        currency: readString(data['currency']) || 'CNY',
        amount: readNumber(data['available_balance']),
      };
    };
  } else if (provider === 'siliconflow') {
    url = `${origin}/v1/user/info`;
    headers = { ...headers, authorization: `Bearer ${target.apiKey}` };
    extract = (payload) => {
      const data = (payload as { data?: Record<string, unknown> } | null)?.data ?? {};
      const amount = readNumber(data['chargeBalance']) ?? readNumber(data['balance']);
      return { currency: readString(data['currency']) || 'CNY', amount };
    };
  } else {
    return {
      supported: false,
      currency: '',
      amount: null,
      message: `${provider} 没有公开的余额查询接口`,
      checkedAt,
    };
  }

  if (!isAllowedUpstreamUrl(url)) {
    return {
      supported: false,
      currency: '',
      amount: null,
      message: '上游地址必须为公网地址',
      checkedAt,
    };
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        supported: true,
        currency: '',
        amount: null,
        message: `上游返回 ${response.status}`,
        checkedAt,
      };
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    const { currency, amount } = extract(payload);
    return {
      supported: true,
      currency,
      amount,
      message: amount === null ? '上游未返回可识别的余额字段' : null,
      checkedAt,
    };
  } catch (error) {
    return {
      supported: true,
      currency: '',
      amount: null,
      message: error instanceof Error ? error.message.slice(0, 200) : '上游不可达',
      checkedAt,
    };
  }
}
