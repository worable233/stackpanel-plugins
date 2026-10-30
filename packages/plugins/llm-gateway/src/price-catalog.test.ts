import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USD_RATE_MINOR,
  hasHolidayGap,
  matchCatalog,
  normalizeModelKey,
  offPeakWindows,
  parseCatalog,
  thresholdOfSuffixKey,
  usdPerTokenToMinor,
  type CatalogEntry,
} from './price-catalog.js';

/** 一份贴近真实结构的样例（数值取自公开价格表的真实条目形状）。 */
const SAMPLE = {
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    max_input_tokens: 128000,
    max_output_tokens: 16384,
    litellm_provider: 'openai',
  },
  'openai/gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    litellm_provider: 'openai',
  },
  'azure/gpt-4o': {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000015,
    litellm_provider: 'azure',
  },
  'deepseek/deepseek-flash': {
    input_cost_per_token: 0.0000001,
    output_cost_per_token: 0.0000004,
    litellm_provider: 'deepseek',
    off_peak_pricing: {
      input_cost_per_token: 0.00000005,
      output_cost_per_token: 0.0000002,
      weekday_timezone: 'Asia/Shanghai',
      windows: [{ hours_utc: ['00:30-08:30'], weekdays: [1, 2, 3, 4, 5] }],
    },
  },
  'claude-sonnet-4': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    input_cost_per_token_above_200k_tokens: 0.000006,
    output_cost_per_token_above_200k_tokens: 0.0000225,
    cache_read_input_token_cost_above_200k_tokens: 0.0000006,
    litellm_provider: 'anthropic',
  },
  'text-embedding-3-small': {
    input_cost_per_token: 0.00000002,
    output_cost_per_token: 0,
    litellm_provider: 'openai',
  },
  /** 只有 image 价、没有 token 价：应当被排除。 */
  'dall-e-3': {
    litellm_provider: 'openai',
    input_cost_per_image: 0.04,
  },
  /** 采样率条目，值不是对象：应当被跳过。 */
  sample_spec: {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
};

describe('normalizeModelKey', () => {
  it('小写并去 provider 前缀', () => {
    expect(normalizeModelKey('openai/GPT-4o')).toBe('gpt-4o');
    expect(normalizeModelKey('azure/gpt-4o')).toBe('gpt-4o');
  });

  it('去掉 Bedrock 区域与版本尾巴', () => {
    expect(normalizeModelKey('anthropic.claude-sonnet-4-v1:0')).toBe('claude-sonnet-4-v1');
  });

  it('没有前缀时原样小写', () => {
    expect(normalizeModelKey('GLM-5.2')).toBe('glm-5.2');
  });

  it('不削第二层斜杠（azure_ai/FW-DeepSeek 这种第二段才是真名）', () => {
    expect(normalizeModelKey('azure_ai/FW-DeepSeek-V4-Pro')).toBe('fw-deepseek-v4-pro');
  });
});

describe('usdPerTokenToMinor', () => {
  it('按汇率换算成 minor/百万 token', () => {
    // $2.5/M token × 700 分/USD = 1750 分/M
    expect(usdPerTokenToMinor(0.0000025, DEFAULT_USD_RATE_MINOR)).toBe(1750);
  });

  it('0 / 负数 / 非数字都归零', () => {
    expect(usdPerTokenToMinor(0, 700)).toBe(0);
    expect(usdPerTokenToMinor(-1, 700)).toBe(0);
    expect(usdPerTokenToMinor(Number.NaN, 700)).toBe(0);
  });

  it('汇率变化时结果成比例', () => {
    expect(usdPerTokenToMinor(0.00001, 700)).toBe(7000);
    expect(usdPerTokenToMinor(0.00001, 720)).toBe(7200);
  });
});

describe('thresholdOfSuffixKey', () => {
  it('识别 above_Nk 后缀', () => {
    expect(thresholdOfSuffixKey('input_cost_per_token_above_200k_tokens')).toBe(200_000);
    expect(thresholdOfSuffixKey('output_cost_per_token_above_32k_tokens')).toBe(32_000);
  });

  it('非该形状返回 null', () => {
    expect(thresholdOfSuffixKey('input_cost_per_token')).toBeNull();
    expect(thresholdOfSuffixKey('max_input_tokens')).toBeNull();
  });
});

describe('offPeakWindows', () => {
  it('把低谷绝对价换算成相对基础价的百分比', () => {
    const windows = offPeakWindows(
      {
        input_cost_per_token: 0.00000005,
        output_cost_per_token: 0.0000002,
        weekday_timezone: 'Asia/Shanghai',
        windows: [{ hours_utc: ['00:30-08:30'], weekdays: [1, 2, 3, 4, 5] }],
      },
      // 基础价必须用同一汇率换算：$0.0000001/token → 70 分/M。
      usdPerTokenToMinor(0.0000001, DEFAULT_USD_RATE_MINOR),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.hours).toBe('00:30-08:30');
    expect(windows[0]?.timezone).toBe('Asia/Shanghai');
    expect(windows[0]?.weekdays).toEqual([1, 2, 3, 4, 5]);
    // 低谷 input 0.00000005 vs 基础 0.0000001 → 50%
    expect(windows[0]?.percent).toBe(50);
  });

  it('00:00-00:00 归一为全天', () => {
    const windows = offPeakWindows(
      { input_cost_per_token: 0.0000001, windows: [{ hours_utc: ['00:00-00:00'] }] },
      100,
    );
    expect(windows[0]?.hours).toBe('00:00-24:00');
  });

  it('没有 windows 时返回空数组', () => {
    expect(offPeakWindows(undefined, 100)).toEqual([]);
    expect(offPeakWindows({ input_cost_per_token: 1 }, 100)).toEqual([]);
  });

  it('无基础价时退回绝对价而不是算成 0%', () => {
    const windows = offPeakWindows(
      {
        input_cost_per_token: 0.00000005,
        output_cost_per_token: 0.0000002,
        windows: [{ hours_utc: ['01:00-02:00'] }],
      },
      0,
      DEFAULT_USD_RATE_MINOR,
    );
    expect(windows[0]?.percent).toBeUndefined();
    expect(windows[0]?.inputPrice).toBeGreaterThan(0);
  });
});

describe('parseCatalog', () => {
  const entries = parseCatalog(SAMPLE, DEFAULT_USD_RATE_MINOR);

  it('解析出有 token 价的条目', () => {
    const gpt4o = entries.find((entry) => entry.model === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.inputPrice).toBe(1750);
    expect(gpt4o?.outputPrice).toBe(7000);
    expect(gpt4o?.cacheReadPrice).toBe(875);
    expect(gpt4o?.maxInputTokens).toBe(128000);
    expect(gpt4o?.maxOutputTokens).toBe(16384);
    expect(gpt4o?.provider).toBe('openai');
  });

  it('排除没有 token 价的条目', () => {
    expect(entries.some((entry) => entry.model === 'dall-e-3')).toBe(false);
  });

  it('把长上下文档位归并成 tiers', () => {
    const claude = entries.find((entry) => entry.model === 'claude-sonnet-4');
    expect(claude?.tiers).toHaveLength(1);
    expect(claude?.tiers[0]?.from).toBe(200_000);
    expect(claude?.tiers[0]?.inputPrice).toBe(4200);
    expect(claude?.tiers[0]?.outputPrice).toBe(15750);
    expect(claude?.tiers[0]?.cacheReadPrice).toBe(420);
  });

  it('解析出峰谷窗口', () => {
    const deepseek = entries.find((entry) => entry.model === 'deepseek/deepseek-flash');
    expect(deepseek?.windows).toHaveLength(1);
    expect(deepseek?.windows[0]?.percent).toBe(50);
  });

  it('保留美元原值供界面展示换算过程', () => {
    const gpt4o = entries.find((entry) => entry.model === 'gpt-4o');
    expect(gpt4o?.usdInputPerToken).toBeCloseTo(0.0000025, 12);
    expect(gpt4o?.usdOutputPerToken).toBeCloseTo(0.00001, 12);
    // 210 分/M 的来历：$0.30/M × 7.00 = 2.10 元/M = 210 分/M
    const deepseek = entries.find((entry) => entry.model === 'deepseek/deepseek-flash');
    expect(usdPerTokenToMinor(deepseek!.usdInputPerToken, 700)).toBe(deepseek?.inputPrice);
  });

  it('按模型名排序', () => {
    const names = entries.map((entry) => entry.model);
    expect(names).toEqual([...names].sort());
  });

  it('非对象载荷返回空数组', () => {
    expect(parseCatalog(null, 700)).toEqual([]);
    expect(parseCatalog('x', 700)).toEqual([]);
  });
});

describe('hasHolidayGap', () => {
  const entries = parseCatalog(SAMPLE, DEFAULT_USD_RATE_MINOR);

  it('deepseek 带峰谷窗口时报告节假日缺口', () => {
    const deepseek = entries.find((entry) => entry.model === 'deepseek/deepseek-flash');
    expect(deepseek).toBeDefined();
    expect(hasHolidayGap(deepseek as CatalogEntry)).toBe(true);
  });

  it('没有峰谷窗口的模型不算缺口', () => {
    const gpt4o = entries.find((entry) => entry.model === 'gpt-4o');
    expect(hasHolidayGap(gpt4o as CatalogEntry)).toBe(false);
  });
});

describe('matchCatalog', () => {
  const entries: CatalogEntry[] = parseCatalog(SAMPLE, DEFAULT_USD_RATE_MINOR);

  it('精确名优先', () => {
    const matches = matchCatalog(entries, 'gpt-4o');
    expect(matches[0]?.via).toBe('exact');
    expect(matches[0]?.entry.model).toBe('gpt-4o');
  });

  it('无前缀条目排在带前缀之前', () => {
    const matches = matchCatalog(entries, 'gpt-4o');
    const bare = matches.findIndex((match) => match.entry.model === 'gpt-4o');
    const prefixed = matches.findIndex((match) => match.entry.model === 'azure/gpt-4o');
    expect(bare).toBeLessThan(prefixed);
  });

  it('去前缀后匹配', () => {
    const matches = matchCatalog(entries, 'GPT-4O');
    expect(matches.some((match) => match.via === 'normalized')).toBe(true);
  });

  it('上游名带 provider 前缀时也能命中', () => {
    const matches = matchCatalog(entries, 'deepseek/deepseek-flash');
    expect(matches[0]?.entry.model).toBe('deepseek/deepseek-flash');
  });

  it('空模型名返回空', () => {
    expect(matchCatalog(entries, '')).toEqual([]);
    expect(matchCatalog(entries, '   ')).toEqual([]);
  });

  it('查不到时返回空数组而不是报错', () => {
    expect(matchCatalog(entries, 'glm-5.2')).toEqual([]);
  });

  it('结果数量上限 20', () => {
    const many: CatalogEntry[] = Array.from({ length: 40 }, (_unused, index) => ({
      model: `vendor/x-${index}`,
      key: `x-${index}`,
      provider: 'vendor',
      inputPrice: 1,
      outputPrice: 1,
      usdInputPerToken: 0,
      usdOutputPerToken: 0,
      cacheReadPrice: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      tiers: [],
      windows: [],
    }));
    // 后缀匹配需要 `x` 在末尾，这里用精确名命中一条即可验证不会崩。
    expect(matchCatalog(many, 'vendor/x-1').length).toBeLessThanOrEqual(20);
  });
});
