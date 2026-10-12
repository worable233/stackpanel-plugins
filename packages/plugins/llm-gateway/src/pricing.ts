/** 一条模型定价（minor / 百万 token）。 */
export interface ModelPrice {
  inputPrice: number;
  outputPrice: number;
  /** 倍率，百分数；100 = 1x。 */
  multiplier: number;
  /** 缓存读单价（minor / 百万 token）；未配置时按 inputPrice 计。 */
  cacheReadPrice?: number;
  /** 缓存写单价（minor / 百万 token）；未配置时按 inputPrice 计。 */
  cacheWritePrice?: number;
}

/** 兜底定价行使用的特殊 model 名。 */
export const DEFAULT_PRICE_MODEL = '*';

/**
 * 按模型名取定价：先精确匹配，再退到 `*` 通配行，最后回退到全 0（不收费）。
 */
export function resolvePrice(
  prices: Array<{ model: string } & ModelPrice>,
  model: string,
): ModelPrice {
  const exact = prices.find((price) => price.model === model);
  if (exact) return exact;
  const fallback = prices.find((price) => price.model === DEFAULT_PRICE_MODEL);
  if (fallback) return fallback;
  return { inputPrice: 0, outputPrice: 0, multiplier: 100 };
}

/** 定价行（可能携带「绑定的上游模型名」）。 */
export interface PricedRow extends ModelPrice {
  /** 实际转发给上游的模型名；缺省/空串表示与对外模型名相同。 */
  upstreamModel?: string;
}

/** 一条定价的最终解析结果：计费参数 + 实际转发上游的模型名。 */
export interface ServedPrice extends ModelPrice {
  /** 对外（用户）模型名。 */
  publicModel: string;
  /** 实际转发上游的模型名；定价行未绑定前端时回退为对外模型名。 */
  upstreamModel: string;
}

/**
 * 按对外模型名解析定价与上游模型名。精确匹配优先，其次 `*` 兜底；
 * 都未命中时按全 0 计费，且上游模型名 = 对外模型名（同协议直通旧行为）。
 */
export function resolveServedPrice(
  prices: Array<{ model: string } & PricedRow>,
  model: string,
): ServedPrice {
  const exact = prices.find((price) => price.model === model);
  const fallback = prices.find((price) => price.model === DEFAULT_PRICE_MODEL);
  const row = exact ?? fallback;
  const upstream = row?.upstreamModel?.trim();
  return {
    inputPrice: row?.inputPrice ?? 0,
    outputPrice: row?.outputPrice ?? 0,
    multiplier: row?.multiplier ?? 100,
    ...(row?.cacheReadPrice !== undefined ? { cacheReadPrice: row.cacheReadPrice } : {}),
    ...(row?.cacheWritePrice !== undefined ? { cacheWritePrice: row.cacheWritePrice } : {}),
    publicModel: model,
    upstreamModel: upstream && upstream.length > 0 ? upstream : model,
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** promptTokens 中命中缓存读的部分（子集）。 */
  cacheReadTokens?: number;
  /** promptTokens 中写入缓存的部分（子集）。 */
  cacheWriteTokens?: number;
}

/** 计算本次应扣金额（minor 单位，向上取整到最小分）。 */
export function computeAmount(price: ModelPrice, usage: TokenUsage): number {
  const output = (usage.completionTokens * price.outputPrice) / 1_000_000;

  // 输入侧按「缓存读 / 缓存写 / 普通输入」三段计价，缓存 token 是 prompt 的子集。
  const cacheRead = Math.min(usage.cacheReadTokens ?? 0, usage.promptTokens);
  const cacheWrite = Math.min(usage.cacheWriteTokens ?? 0, usage.promptTokens - cacheRead);
  const plainInput = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
  const input =
    (plainInput * price.inputPrice +
      cacheRead * (price.cacheReadPrice ?? price.inputPrice) +
      cacheWrite * (price.cacheWritePrice ?? price.inputPrice)) /
    1_000_000;

  const multiplier = price.multiplier > 0 ? price.multiplier : 100;
  const raw = ((input + output) * multiplier) / 100;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // 任何非零用量至少计 1 分，避免四舍五入把小额抹成 0。
  return Math.max(1, Math.round(raw));
}

/**
 * 粗略 token 估算，作为上游未返回 `usage` 时的兜底（SSE 常见）。
 * CJK 字符约 1 token/字，其余按 4 字符/token 估。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(char)) cjk += 1;
  }
  const rest = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(rest / 4);
}

/** 从响应文本里提取最后一个 `usage` 对象（OpenAI / 兼容）。 */
export function extractUsage(text: string): TokenUsage | null {
  const re = /"usage"\s*:\s*\{([^}]*)\}/g;
  let last: string | null = null;
  for (const match of text.matchAll(re)) {
    if (match[1]) last = match[1];
  }
  if (!last) return null;
  const read = (key: string): number | null => {
    const match = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(last as string);
    return match ? Number(match[1]) : null;
  };
  const prompt = read('prompt_tokens') ?? read('input_tokens');
  const completion = read('completion_tokens') ?? read('output_tokens');
  const total = read('total_tokens');
  if (prompt === null && completion === null && total === null) return null;
  const promptTokens = prompt ?? Math.max(0, (total ?? 0) - (completion ?? 0));
  const completionTokens = completion ?? Math.max(0, (total ?? 0) - (prompt ?? 0));
  return {
    promptTokens,
    completionTokens,
    totalTokens: total ?? promptTokens + completionTokens,
  };
}
