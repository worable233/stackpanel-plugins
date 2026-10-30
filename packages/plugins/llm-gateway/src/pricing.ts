import { evaluateExpr, strategyOf } from './pricing-strategy.js';
import type { PriceWindow } from './pricing-window.js';

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
  /** 推理 token 单价（minor / 百万 token）；未配置时按 outputPrice 计。 */
  reasoningPrice?: number;
  /** 图片单价（minor / 张）；用于 images/* 与多模态图片计费。 */
  imagePrice?: number;
  /** 音频单价（minor / 秒）；用于 audio/* 计费。 */
  audioPrice?: number;
  /** 成本价（minor）：只用于毛利核算，不参与用户扣款。0 = 未知。 */
  costInputPrice?: number;
  costOutputPrice?: number;
  costCacheReadPrice?: number;
  costCacheWritePrice?: number;
  costReasoningPrice?: number;
  costImagePrice?: number;
  costAudioPrice?: number;
  /** 阶梯价：按本次输入 token 落到 `from` 最大且不超过用量的那一阶。 */
  tiers?: readonly PriceTier[];
  /**
   * 时段价（峰谷）：按请求到达时刻命中第一个窗口，用它的价格覆盖基础价。
   * 优先级：基础价 < 时段价 < 阶梯价。
   */
  windows?: readonly PriceWindow[];
  /** 该模型的输出上限（token）；0/未填 = 用全局默认。 */
  maxOutputTokens?: number;
  /** 是否叠加用户权限组折扣（内核 `PermissionGroup.discount`）。 */
  groupDiscount?: boolean;
  /**
   * 计费模式（B2）：`flat` / `tiered` / `expr`。未填时按是否配了
   * `tiers`/`expr` 推断，因此旧定价行无需迁移。
   */
  strategy?: string;
  /**
   * 受限算术表达式（B2）：结果即 minor 金额（不再乘 `multiplier`）。
   * 只支持 `+ - * /`、括号与白名单变量/函数，见 `pricing-strategy.ts`。
   */
  expr?: string;
}

/** 一条阶梯：只覆盖填写的字段，其余继承基础价。 */
export interface PriceTier {
  /** 输入 token 阈值（含）；0 表示默认阶。 */
  from: number;
  inputPrice?: number | undefined;
  outputPrice?: number | undefined;
  cacheReadPrice?: number | undefined;
  cacheWritePrice?: number | undefined;
  reasoningPrice?: number | undefined;
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
    ...(row?.reasoningPrice !== undefined ? { reasoningPrice: row.reasoningPrice } : {}),
    ...(row?.imagePrice !== undefined ? { imagePrice: row.imagePrice } : {}),
    ...(row?.audioPrice !== undefined ? { audioPrice: row.audioPrice } : {}),
    ...(row?.costInputPrice !== undefined ? { costInputPrice: row.costInputPrice } : {}),
    ...(row?.costOutputPrice !== undefined ? { costOutputPrice: row.costOutputPrice } : {}),
    ...(row?.costCacheReadPrice !== undefined
      ? { costCacheReadPrice: row.costCacheReadPrice }
      : {}),
    ...(row?.costCacheWritePrice !== undefined
      ? { costCacheWritePrice: row.costCacheWritePrice }
      : {}),
    ...(row?.costReasoningPrice !== undefined
      ? { costReasoningPrice: row.costReasoningPrice }
      : {}),
    ...(row?.costImagePrice !== undefined ? { costImagePrice: row.costImagePrice } : {}),
    ...(row?.costAudioPrice !== undefined ? { costAudioPrice: row.costAudioPrice } : {}),
    ...(row?.tiers !== undefined ? { tiers: row.tiers } : {}),
    ...(row?.windows !== undefined ? { windows: row.windows } : {}),
    ...(row?.maxOutputTokens !== undefined ? { maxOutputTokens: row.maxOutputTokens } : {}),
    ...(row?.groupDiscount !== undefined ? { groupDiscount: row.groupDiscount } : {}),
    ...(row?.strategy !== undefined ? { strategy: row.strategy } : {}),
    ...(row?.expr !== undefined ? { expr: row.expr } : {}),
    publicModel: model,
    upstreamModel: upstream && upstream.length > 0 ? upstream : model,
  };
}

/**
 * 把阶梯价落到本次用量上（纯函数）。
 *
 * 语义：取 `from <= promptTokens` 中 `from` 最大的一阶，未填写的字段继承基础价。
 * 没有命中任何阶梯时返回原价（含 `tiers` 为空的情形）。
 */
export function priceForUsage(price: ModelPrice, promptTokens: number): ModelPrice {
  const tiers = price.tiers ?? [];
  if (tiers.length === 0) return price;
  let best: PriceTier | null = null;
  for (const tier of tiers) {
    if (promptTokens >= tier.from && (best === null || tier.from > best.from)) best = tier;
  }
  if (best === null) return price;
  const matched: PriceTier = best;
  return {
    ...price,
    ...(matched.inputPrice !== undefined ? { inputPrice: matched.inputPrice } : {}),
    ...(matched.outputPrice !== undefined ? { outputPrice: matched.outputPrice } : {}),
    ...(matched.cacheReadPrice !== undefined ? { cacheReadPrice: matched.cacheReadPrice } : {}),
    ...(matched.cacheWritePrice !== undefined ? { cacheWritePrice: matched.cacheWritePrice } : {}),
    ...(matched.reasoningPrice !== undefined ? { reasoningPrice: matched.reasoningPrice } : {}),
  };
}

/**
 * 「最坏情况单价」：把基础价与所有阶梯价里**每一项单价的最大值**取出来。
 *
 * 存在的理由（真实漏损事故）：预留按基础价估算，而阶梯价可以比基础价高一个
 * 数量级。预留 82 分、实际 142 分，内核 `settleHold` 会按契约把结算额夹到
 * 冻结额上限（`Math.min(settledAmount, hold.amount)`，有测试固化），于是超出的
 * 60 分**静默蒸发**——不报错、不留痕。修复办法是让预留本身就用最坏情况的价：
 * 多冻的部分结算时原样退还，成本是短暂的余额占用；少冻的代价是永久漏损。
 *
 * 为什么按字段取 max 而不是挑「最贵的那一档」：不同阶梯可以各贵一项
 * （比如高档 input 更贵、低档 output 更贵），逐字段取最大值才是真正的上界。
 * 时段窗口价（`windows`）不参与：它在请求入口就折进 `priceSnapshot`，
 * `served` 已经是折后价。
 */
export function worstCasePrice(price: ModelPrice): ModelPrice {
  const tiers = price.tiers ?? [];
  if (tiers.length === 0) return price;
  const maxOf = (pick: (row: PriceTier) => number | undefined, fallback: number): number => {
    let max = fallback;
    for (const tier of tiers) {
      const value = pick(tier);
      if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value;
    }
    return max;
  };
  return {
    ...price,
    inputPrice: maxOf((t) => t.inputPrice, price.inputPrice),
    outputPrice: maxOf((t) => t.outputPrice, price.outputPrice),
    cacheReadPrice: maxOf((t) => t.cacheReadPrice, price.cacheReadPrice ?? 0),
    cacheWritePrice: maxOf((t) => t.cacheWritePrice, price.cacheWritePrice ?? 0),
    reasoningPrice: maxOf((t) => t.reasoningPrice, price.reasoningPrice ?? 0),
  };
}

/** 权限组折扣（% off，0–99）。与内核商店同一口径：取用户各组中的最大折扣。 */
export function bestDiscountPercent(groups: ReadonlyArray<{ discount?: number | null }>): number {
  let max = 0;
  for (const group of groups) {
    const discount = group.discount;
    if (typeof discount === 'number' && Number.isFinite(discount) && discount > max) {
      max = discount;
    }
  }
  return Math.min(99, Math.max(0, Math.trunc(max)));
}

/** 应用折扣（% off），结果向上取整到最小分。 */
export function applyDiscount(amount: number, percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return amount;
  const capped = Math.min(99, percent);
  return Math.max(1, Math.round((amount * (100 - capped)) / 100));
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 总 token；缺省时调用方应传 `promptTokens + completionTokens`。 */
  totalTokens?: number;
  /**
   * promptTokens 中命中缓存读的部分（**子集**）。`promptTokens` 仍是全部输入，
   * 含缓存部分；这两个字段只用于计费拆分。
   */
  cacheReadTokens?: number;
  /** promptTokens 中写入缓存的部分（子集）。 */
  cacheWriteTokens?: number;
  /** outputTokens 中的推理 token 数（子集）；未配置推理单价时按 outputPrice 计。 */
  reasoningTokens?: number;
  /** 图片张数（按张计费）。 */
  imageCount?: number;
  /** 音频秒数（按秒计费）。 */
  audioSeconds?: number;
}

/**
 * 计算本次应扣金额（minor 单位，向上取整到最小分）。
 *
 * 计价分五段：普通输入 / 缓存读 / 缓存写 / 输出（含推理）/ 非 token 单位
 * （图片张数、音频秒数）。所有 token 单价单位是 minor/百万 token。
 *
 * 纪律：`cacheRead`/`cacheWrite` 是 `promptTokens` 的子集，必须夹在
 * `[0, promptTokens]` 内，否则上游报错数据会让用户被超额计费。
 *
 * 阶梯价按 `usage.promptTokens` 选阶（A4）；`discountPercent` 是权限组折扣（A4），
 * 只作用于售价，不改变成本口径。
 */
export function computeAmount(
  price: ModelPrice,
  usage: TokenUsage,
  options: { discountPercent?: number } = {},
): number {
  // 输入侧按「缓存读 / 缓存写 / 普通输入」三段拆分，缓存 token 是 prompt 的子集。
  // 先夹一次：上游报错数据（cache > prompt）会让用户被超额计费。
  const cacheReadTokens = Math.min(usage.cacheReadTokens ?? 0, usage.promptTokens);
  const cacheWriteTokens = Math.min(
    usage.cacheWriteTokens ?? 0,
    usage.promptTokens - cacheReadTokens,
  );
  const reasoningTokens = Math.min(usage.reasoningTokens ?? 0, usage.completionTokens);

  // 表达式模式（B2）：结果本身就是应收金额，不再套阶梯/倍率。
  // 表达式写坏（编译失败）时回落到 flat/tiered，绝不让请求 500。
  if (strategyOf(price) === 'expr' && price.expr) {
    const exprAmount = evaluateExpr(price.expr, {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      reasoning_tokens: reasoningTokens,
      image_count: usage.imageCount ?? 0,
      audio_seconds: usage.audioSeconds ?? 0,
      multiplier: price.multiplier > 0 ? price.multiplier : 100,
    });
    if (exprAmount !== null) {
      if (exprAmount <= 0) return 0;
      return applyDiscount(Math.max(1, Math.round(exprAmount)), options.discountPercent ?? 0);
    }
  }

  const tiered = strategyOf(price) === 'expr' ? price : priceForUsage(price, usage.promptTokens);
  const output = (usage.completionTokens * tiered.outputPrice) / 1_000_000;

  // 输入侧按「缓存读 / 缓存写 / 普通输入」三段计价。
  const cacheRead = cacheReadTokens;
  const cacheWrite = cacheWriteTokens;
  const plainInput = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
  const input =
    (plainInput * tiered.inputPrice +
      cacheRead * (tiered.cacheReadPrice ?? tiered.inputPrice) +
      cacheWrite * (tiered.cacheWritePrice ?? tiered.inputPrice)) /
    1_000_000;

  // 推理 token 通常比普通输出贵；未配置推理单价时按 outputPrice 计（不退化为 0）。
  const reasoning = reasoningTokens;
  const reasoningExtra =
    reasoning > 0
      ? (reasoning * ((tiered.reasoningPrice ?? tiered.outputPrice) - tiered.outputPrice)) /
        1_000_000
      : 0;

  // 非 token 单位：图片按张、音频按秒。未定价则为 0（不收费，但依然记账）。
  const nonToken =
    (usage.imageCount ?? 0) * (tiered.imagePrice ?? 0) +
    (usage.audioSeconds ?? 0) * (tiered.audioPrice ?? 0);

  const multiplier = tiered.multiplier > 0 ? tiered.multiplier : 100;
  const raw = ((input + output + reasoningExtra) * multiplier) / 100 + nonToken;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // 任何非零用量至少计 1 分，避免四舍五入把小额抹成 0。
  const rounded = Math.max(1, Math.round(raw));
  return applyDiscount(rounded, options.discountPercent ?? 0);
}

/**
 * 本次请求的上游成本（minor）。口径与售价**刻意分开**：
 * - 不使用 `multiplier`（倍率是售价侧策略）；
 * - 不应用权限组折扣（折扣让利不影响成本）；
 * - 成本价全部未配置时返回 0（视为未知，不伪造成本）。
 */
export function computeCostAmount(price: ModelPrice, usage: TokenUsage): number {
  const hasCost =
    (price.costInputPrice ?? 0) > 0 ||
    (price.costOutputPrice ?? 0) > 0 ||
    (price.costImagePrice ?? 0) > 0 ||
    (price.costAudioPrice ?? 0) > 0;
  if (!hasCost) return 0;
  const costPrice: ModelPrice = {
    inputPrice: price.costInputPrice ?? 0,
    outputPrice: price.costOutputPrice ?? 0,
    cacheReadPrice: price.costCacheReadPrice ?? price.costInputPrice ?? 0,
    cacheWritePrice: price.costCacheWritePrice ?? price.costInputPrice ?? 0,
    reasoningPrice: price.costReasoningPrice ?? price.costOutputPrice ?? 0,
    imagePrice: price.costImagePrice ?? 0,
    audioPrice: price.costAudioPrice ?? 0,
    multiplier: 100,
  };
  return computeAmount(costPrice, usage);
}

/** 该模型用于预授权估算的输出上限（token）；0 = 调用方用全局默认。 */
export function reservedOutputTokens(price: ModelPrice): number {
  const configured = price.maxOutputTokens ?? 0;
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 0;
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
