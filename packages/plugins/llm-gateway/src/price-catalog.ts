/**
 * 公开价格目录（按模型名自动填价）。
 *
 * 数据源是 LiteLLM 维护的公开价格表：4430+ 个模型，每条带
 * `input_cost_per_token` / `output_cost_per_token` / `cache_read_input_token_cost`
 * / `max_input_tokens` / `max_output_tokens`，以及部分模型的
 * `off_peak_pricing`（峰谷时段）与 `*_above_Nk_tokens`（长上下文档位）。
 *
 * 三条设计原则，都是为了让「自动填」不会变成「自动填错」：
 *
 * 1. **只填参考价，绝不填售价**。公开表是上游对外的美元标价，不是你的卖价。
 *    把它写进 `inputPrice` 会直接把定价权交给别人，而且一次错误的价格会被
 *    每笔请求放大。所以目录值只落在 `ref*` 字段，再由管理员确认后抄进售价。
 * 2. **命中要可解释**。`gpt-4o` 和 `openai/gpt-4o` 和 `azure/gpt-4o` 是三个
 *    不同的价，所以查询返回所有候选并标出匹配方式（精确/去前缀/后缀），
 *    让管理员看到「为什么是这一条」，而不是只给一个孤零零的数字。
 * 3. **网络失败不算业务失败**。目录拉不到时降级为「无建议」，定价页面照常可用。
 */

/** 目录里的一条模型价格（已换算成 minor / 百万 token）。 */
export interface CatalogEntry {
  /** 数据源里的原始模型名。 */
  model: string;
  /** 归一化后的可匹配名（小写、去掉 provider 前缀）。 */
  key: string;
  provider: string;
  /** minor / 百万 token（已按汇率换算）。 */
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  /**
   * 美元原值（每 token）。保留它是为了让界面能显示换算过程
   * `$0.30/M × 7.00 = 210 分/M`——只给一个「210」会让人以为是人民币标价。
   */
  usdInputPerToken: number;
  usdOutputPerToken: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** 长上下文档位价（来自 `*_above_Nk_tokens`），按阈值升序。 */
  tiers: CatalogTier[];
  /** 峰谷时段（来自 `off_peak_pricing`），已归一成插件的窗口结构。 */
  windows: CatalogWindow[];
}

/** 目录里的一个长上下文档位。 */
export interface CatalogTier {
  /** 输入 token 阈值。 */
  from: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
}

/** 目录里的一个峰谷窗口。 */
export interface CatalogWindow {
  timezone: string;
  weekdays: number[];
  hours: string;
  percent?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
}

/** 一次查询命中的候选。 */
export interface CatalogMatch {
  entry: CatalogEntry;
  /** 怎么命中的：`exact` 原名一致 / `normalized` 去前缀后一致 / `suffix` 后缀一致。 */
  via: 'exact' | 'normalized' | 'suffix';
}

/** 目录快照（带元信息，让前端能显示「这个数字多旧」）。 */
export interface CatalogSnapshot {
  source: string;
  fetchedAt: string;
  currency: string;
  /** 美元 → minor 的换算率（1 USD = ? 分）。 */
  rate: number;
  total: number;
  entries: CatalogEntry[];
}

export const CATALOG_SOURCE =
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json';

/** 默认汇率：1 美元 = 700 分（即 ¥7.00）。管理员可覆盖。 */
export const DEFAULT_USD_RATE_MINOR = 700;

/** 目录缓存时长：价格表一天最多变几次，没必要每次开页面都拉 3 MB。 */
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

/** 拉取超时。目录站慢的时候不该让定价页卡住。 */
const CATALOG_TIMEOUT_MS = 15_000;

/** 归一化模型名：小写、去掉常见 provider 前缀、去掉冒号后的版本后缀。 */
export function normalizeModelKey(model: string): string {
  let key = model.trim().toLowerCase();
  // 去掉 provider 前缀（`openai/gpt-4o` → `gpt-4o`）。只削一层，
  // 因为 `azure_ai/FW-DeepSeek-V4-Pro` 这种第二段才是真名。
  const slash = key.indexOf('/');
  if (slash > 0) key = key.slice(slash + 1);
  // Bedrock 的 `anthropic.claude-x-v1:0` 去掉区域与版本尾巴。
  const colon = key.indexOf(':');
  if (colon > 0) key = key.slice(0, colon);
  // Bedrock 的 `anthropic.claude-...` 前缀。
  const dot = key.indexOf('.');
  if (dot > 0 && !key.slice(0, dot).includes('-')) key = key.slice(dot + 1);
  return key.trim();
}

/** 美元/token → minor/百万 token。 */
export function usdPerTokenToMinor(usdPerToken: number, rateMinor: number): number {
  if (!Number.isFinite(usdPerToken) || usdPerToken <= 0) return 0;
  // 1e6 token × USD/token = USD/百万 token；再乘「1 USD 值多少分」。
  return Math.max(0, Math.round(usdPerToken * 1_000_000 * rateMinor));
}

/** 从 `*_above_200k_tokens` 这类键里取出阈值 token 数。 */
export function thresholdOfSuffixKey(key: string): number | null {
  const match = /_above_(\d+)k_tokens$/.exec(key);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

/** `off_peak_pricing.windows` 的宽松输入形状。 */
interface RawOffPeakWindow {
  hours_utc?: string | string[];
  weekdays?: number[];
}

interface RawOffPeak {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  weekday_timezone?: string;
  windows?: RawOffPeakWindow[];
}

/**
 * 已知的数据源缺口：DeepSeek 的峰谷价**不含中国法定节假日**（官方口径是
 * 「节假日全天按低谷价」），但 LiteLLM 的 `off_peak_pricing.windows` 只有
 * 时段与星期，没有节假日字段。
 *
 * 我们不去猜节假日表（每年变、也无法从数据源派生），但必须把这件事讲出来，
 * 否则管理员抄完峰谷窗口会在节假日当天按峰时价收费，多收用户的钱。
 */
export const HOLIDAY_GAP_PROVIDERS: readonly string[] = ['deepseek'];

/** 该条目的峰谷价是否存在「节假日未覆盖」的已知缺口。 */
export function hasHolidayGap(entry: CatalogEntry): boolean {
  if (entry.windows.length === 0) return false;
  return HOLIDAY_GAP_PROVIDERS.includes(entry.provider.toLowerCase());
}

/** 一条原始模型记录里我们关心的字段。 */
interface RawModelPrice {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  litellm_provider?: string;
  off_peak_pricing?: RawOffPeak;
  [key: string]: unknown;
}

/**
 * 把 `off_peak_pricing` 归一成插件的窗口结构。
 *
 * LiteLLM 用「低谷时段的绝对价格 + 生效窗口」表达峰谷；我们存的是
 * 「相对基础价的覆盖」。两者要能对上，就必须先算出基础价，再把低谷价
 * 换算成百分比——否则低谷价比基础价高时会算成负折扣。
 */
export function offPeakWindows(
  raw: RawOffPeak | undefined,
  baseMinor: number,
  rateMinor: number = DEFAULT_USD_RATE_MINOR,
): CatalogWindow[] {
  if (!raw || !Array.isArray(raw.windows) || raw.windows.length === 0) return [];
  // 比例必须在**同一汇率下**比较：先用目录汇率把低谷价换成 minor，再和基础价相除，
  // 这样汇率怎么变都不影响折扣百分比（比例是汇率无关量）。
  const offInput = usdPerTokenToMinor(raw.input_cost_per_token ?? 0, rateMinor);
  const offOutput = usdPerTokenToMinor(raw.output_cost_per_token ?? 0, rateMinor);
  const percent = baseMinor > 0 && offInput > 0 ? Math.round((offInput / baseMinor) * 100) : 0;
  const timezone = raw.weekday_timezone ?? 'UTC';
  const windows: CatalogWindow[] = [];
  for (const window of raw.windows) {
    const hours = Array.isArray(window.hours_utc) ? window.hours_utc : [window.hours_utc];
    const weekdays = Array.isArray(window.weekdays) ? window.weekdays : [];
    for (const span of hours) {
      if (typeof span !== 'string' || !span.includes('-')) continue;
      const [start, end] = span.split('-');
      // `00:00-00:00` 在 LiteLLM 里表示全天；插件侧用 `00:00-24:00` 表达，
      // 否则跨午夜语义会把它算成「一瞬」。
      const hoursValue = start === end ? '00:00-24:00' : `${start}-${end}`;
      windows.push({
        timezone,
        weekdays,
        hours: hoursValue,
        ...(percent > 0 ? { percent } : {}),
        ...(percent > 0 ? {} : { inputPrice: offInput, outputPrice: offOutput }),
      });
    }
  }
  return windows;
}

/**
 * 把原始价格表解析成目录。
 *
 * 只保留**有输入或输出价**的条目：LiteLLM 里有大量只有 embedding / 只有
 * image 的条目，它们没有 token 价，留在目录里只会污染「按名搜索」的结果。
 */
export function parseCatalog(payload: unknown, rateMinor: number): CatalogEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const entries: CatalogEntry[] = [];
  for (const [model, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as RawModelPrice;
    const usdInput = typeof raw.input_cost_per_token === 'number' ? raw.input_cost_per_token : 0;
    const usdOutput = typeof raw.output_cost_per_token === 'number' ? raw.output_cost_per_token : 0;
    const inputPrice = usdPerTokenToMinor(usdInput, rateMinor);
    const outputPrice = usdPerTokenToMinor(usdOutput, rateMinor);
    if (inputPrice === 0 && outputPrice === 0) continue;

    // 长上下文档位：`*_above_Nk_tokens` 成组出现，按阈值归并。
    const tiersByThreshold = new Map<number, CatalogTier>();
    for (const [field, fieldValue] of Object.entries(raw)) {
      const threshold = thresholdOfSuffixKey(field);
      if (threshold === null) continue;
      if (typeof fieldValue !== 'number') continue;
      const tier = tiersByThreshold.get(threshold) ?? { from: threshold };
      const minor = usdPerTokenToMinor(fieldValue, rateMinor);
      if (field.startsWith('input_cost_per_token_above_')) tier.inputPrice = minor;
      else if (field.startsWith('output_cost_per_token_above_')) tier.outputPrice = minor;
      else if (field.startsWith('cache_read_input_token_cost_above_')) tier.cacheReadPrice = minor;
      tiersByThreshold.set(threshold, tier);
    }

    entries.push({
      model,
      key: normalizeModelKey(model),
      provider: typeof raw.litellm_provider === 'string' ? raw.litellm_provider : '',
      inputPrice,
      outputPrice,
      usdInputPerToken: usdInput,
      usdOutputPerToken: usdOutput,
      cacheReadPrice: usdPerTokenToMinor(raw.cache_read_input_token_cost ?? 0, rateMinor),
      maxInputTokens: typeof raw.max_input_tokens === 'number' ? raw.max_input_tokens : 0,
      maxOutputTokens: typeof raw.max_output_tokens === 'number' ? raw.max_output_tokens : 0,
      tiers: [...tiersByThreshold.values()].sort((a, b) => a.from - b.from),
      windows: offPeakWindows(raw.off_peak_pricing, inputPrice, rateMinor),
    });
  }
  return entries.sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * 按模型名查候选。
 *
 * 三级匹配，越往后越松；同一级内优先「无 provider 前缀」的条目，
 * 因为官方口径价才是管理员真正想对照的那个数。
 */
export function matchCatalog(entries: readonly CatalogEntry[], model: string): CatalogMatch[] {
  const wanted = model.trim().toLowerCase();
  if (wanted === '') return [];
  const key = normalizeModelKey(wanted);
  const exact: CatalogMatch[] = [];
  const normalized: CatalogMatch[] = [];
  const suffix: CatalogMatch[] = [];
  for (const entry of entries) {
    if (entry.model.toLowerCase() === wanted) exact.push({ entry, via: 'exact' });
    else if (entry.key === key) normalized.push({ entry, via: 'normalized' });
    else if (entry.key.endsWith(`-${key}`) || entry.key.endsWith(`/${key}`)) {
      suffix.push({ entry, via: 'suffix' });
    }
  }
  const rank = (list: CatalogMatch[]): CatalogMatch[] =>
    [...list].sort((a, b) => {
      const aBare = a.entry.model.includes('/') ? 1 : 0;
      const bBare = b.entry.model.includes('/') ? 1 : 0;
      return aBare - bBare || a.entry.model.length - b.entry.model.length;
    });
  return [...rank(exact), ...rank(normalized), ...rank(suffix)].slice(0, 20);
}

/** 拉取并解析目录。任何失败都抛错，由调用方决定降级。 */
export async function fetchCatalog(
  rateMinor: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogSnapshot> {
  const response = await fetchImpl(CATALOG_SOURCE, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`公开价格表返回 ${response.status}`);
  const payload = (await response.json()) as unknown;
  const entries = parseCatalog(payload, rateMinor);
  if (entries.length === 0) throw new Error('公开价格表为空或格式已变');
  return {
    source: CATALOG_SOURCE,
    fetchedAt: new Date().toISOString(),
    currency: 'USD',
    rate: rateMinor,
    total: entries.length,
    entries,
  };
}
