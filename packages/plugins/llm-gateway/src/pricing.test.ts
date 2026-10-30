/**
 * 计价与计量契约测试（目标五 计价 + 目标四 11/12）。
 *
 * 锁死两条会直接算错钱的行为：
 * - `computeAmount` 的五段计价（普通输入 / 缓存读 / 缓存写 / 输出含推理 / 非 token
 *   图片·音频），且缓存 token 必须夹在 prompt 内，不能因上游脏数据超额计费；
 * - 无 usage 时的估算**必须计入 prompt**（旧实现把 prompt 记成 0 是白送输入量）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyDiscount,
  bestDiscountPercent,
  computeAmount,
  computeCostAmount,
  estimateTokens,
  extractUsage,
  priceForUsage,
  reservedOutputTokens,
  type ModelPrice,
} from './pricing.js';
import {
  OutputAccumulator,
  estimateUsage,
  resolveStreamUsage,
  stripSse,
  toTokenUsage,
} from './metering.js';

const price: ModelPrice = {
  inputPrice: 1_000, // minor / 百万 token
  outputPrice: 2_000,
  multiplier: 100,
};

describe('computeAmount', () => {
  it('charges plain input and output', () => {
    // 1M 输入 + 0.5M 输出 = 1000 + 1000 = 2000 分。
    const amount = computeAmount(price, { promptTokens: 1_000_000, completionTokens: 500_000 });
    expect(amount).toBe(2_000);
  });

  it('never returns zero for a non-zero usage', () => {
    expect(computeAmount(price, { promptTokens: 1, completionTokens: 0 })).toBe(1);
    expect(computeAmount(price, { promptTokens: 0, completionTokens: 1 })).toBe(1);
  });

  it('applies the multiplier as a percentage', () => {
    const double: ModelPrice = { ...price, multiplier: 200 };
    const base = computeAmount(price, { promptTokens: 1_000_000, completionTokens: 0 });
    const doubled = computeAmount(double, { promptTokens: 1_000_000, completionTokens: 0 });
    expect(doubled).toBe(base * 2);
  });

  it('separates cache-read and cache-write, treating them as a subset of prompt', () => {
    const cached: ModelPrice = {
      inputPrice: 1_000,
      outputPrice: 0,
      multiplier: 100,
      cacheReadPrice: 100, // 便宜 10 倍
      cacheWritePrice: 2_000,
    };
    // prompt 1M，其中 0.5M 读缓存、0.25M 写缓存，余 0.25M 普通。
    // 0.25*1000 + 0.5*100 + 0.25*2000 = 250 + 50 + 500 = 800 分。
    const amount = computeAmount(cached, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 250_000,
    });
    expect(amount).toBe(800);
  });

  it('clamps cache tokens to the prompt so bad upstream data cannot overcharge', () => {
    const cached: ModelPrice = {
      inputPrice: 0,
      outputPrice: 0,
      multiplier: 100,
      cacheReadPrice: 1_000,
      cacheWritePrice: 1_000,
    };
    // 上游谎报 5M 缓存读，但 prompt 只有 1M：最多只能按 1M 计。
    const amount = computeAmount(cached, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 5_000_000,
      cacheWriteTokens: 5_000_000,
    });
    expect(amount).toBe(1_000);
  });

  it('charges reasoning tokens at the higher rate when configured', () => {
    const reasoning: ModelPrice = {
      inputPrice: 0,
      outputPrice: 1_000,
      reasoningPrice: 3_000,
      multiplier: 100,
    };
    // 1M 输出全是推理：1M*3000/1e6 = 3000 分。
    const amount = computeAmount(reasoning, {
      promptTokens: 0,
      completionTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    });
    expect(amount).toBe(3_000);
  });

  it('folds image count and audio seconds into the amount (W3 non-token fix)', () => {
    const media: ModelPrice = {
      inputPrice: 0,
      outputPrice: 0,
      multiplier: 100,
      imagePrice: 500,
      audioPrice: 50,
    };
    // 2 张图 * 500 + 30 秒 * 50 = 1000 + 1500 = 2500 分。
    const amount = computeAmount(media, {
      promptTokens: 0,
      completionTokens: 0,
      imageCount: 2,
      audioSeconds: 30,
    });
    expect(amount).toBe(2_500);
  });

  it('ignores non-token units when they are not priced', () => {
    // imagePrice 未配置（默认 0）：图片不收费，但 token 部分仍要计。
    const amount = computeAmount(price, {
      promptTokens: 0,
      completionTokens: 0,
      imageCount: 3,
    });
    expect(amount).toBe(0);
  });
});

describe('estimateTokens', () => {
  it('counts CJK characters ~1:1 and non-CJK ~4 chars/token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('extractUsage', () => {
  it('reads the last usage object from a body with several', () => {
    const text =
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n' +
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":50,"total_tokens":60}}\n';
    expect(extractUsage(text)).toEqual({
      promptTokens: 10,
      completionTokens: 50,
      totalTokens: 60,
    });
  });

  it('returns null when there is no usage', () => {
    expect(extractUsage('{"choices":[]}')).toBeNull();
  });
});

describe('metering fallbacks', () => {
  it('toTokenUsage keeps cache / reasoning sub-fields only when non-zero', () => {
    expect(toTokenUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(
      toTokenUsage({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 4,
        reasoningTokens: 3,
      }),
    ).toMatchObject({ cacheReadTokens: 4, reasoningTokens: 3 });
  });

  it('estimates usage including the prompt (never zero prompt)', () => {
    const usage = estimateUsage(
      'data: {"choices":[{"delta":{"content":"hello world"}}]}',
      'tell me a story',
    );
    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.completionTokens).toBeGreaterThan(0);
  });

  it('resolveStreamUsage prefers a reported usage and flags estimates', () => {
    const reported = resolveStreamUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      '',
      'irrelevant',
    );
    expect(reported.estimated).toBe(false);
    expect(reported.usage.promptTokens).toBe(10);

    const fallback = resolveStreamUsage(null, 'data: {"choices":[]}', 'hello');
    expect(fallback.estimated).toBe(true);
    expect(fallback.usage.promptTokens).toBeGreaterThan(0);
  });

  it('stripSse keeps only data: payloads', () => {
    const text = 'event: message\ndata: {"a":1}\ndata: {"b":2}\n';
    expect(stripSse(text)).toBe('{"a":1}{"b":2}');
  });

  it('OutputAccumulator keeps only the tail beyond its cap', () => {
    const acc = new OutputAccumulator();
    acc.push('a'.repeat(300_000));
    expect(acc.value.length).toBe(131_072);
  });
});

describe('阶梯价与权限组折扣（A4）', () => {
  const tiered: ModelPrice = {
    inputPrice: 1_000,
    outputPrice: 2_000,
    multiplier: 100,
    tiers: [
      { from: 0, inputPrice: 1_000 },
      { from: 100_000, inputPrice: 2_000, outputPrice: 3_000 },
    ],
  };

  it('selects the highest threshold not above the prompt size', () => {
    expect(priceForUsage(tiered, 99_999).inputPrice).toBe(1_000);
    expect(priceForUsage(tiered, 100_000).inputPrice).toBe(2_000);
    expect(priceForUsage(tiered, 500_000).outputPrice).toBe(3_000);
  });

  it('inherits base price for fields the tier does not override', () => {
    const plateau: ModelPrice = { ...tiered, tiers: [{ from: 10, outputPrice: 9_000 }] };
    expect(priceForUsage(plateau, 20).inputPrice).toBe(1_000);
    expect(priceForUsage(plateau, 20).outputPrice).toBe(9_000);
  });

  it('charges the tier price through computeAmount', () => {
    // 1M 输入落到第二阶（2_000 minor/百万）= 2000 分。
    expect(computeAmount(tiered, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(2_000);
  });

  it('applies the permission-group discount to the final amount', () => {
    const base = computeAmount(price, { promptTokens: 1_000_000, completionTokens: 0 });
    const discounted = computeAmount(
      price,
      { promptTokens: 1_000_000, completionTokens: 0 },
      { discountPercent: 20 },
    );
    expect(discounted).toBe(Math.round(base * 0.8));
  });

  it('never discounts below one minor unit and caps the percentage', () => {
    expect(applyDiscount(1, 90)).toBe(1);
    expect(applyDiscount(1_000, 500)).toBe(applyDiscount(1_000, 99));
  });

  it('takes the best discount across groups and ignores missing ones', () => {
    expect(bestDiscountPercent([{ discount: 5 }, { discount: null }, { discount: 15 }])).toBe(15);
    expect(bestDiscountPercent([{}, { discount: -3 }])).toBe(0);
    expect(bestDiscountPercent([{ discount: 200 }])).toBe(99);
  });
});

describe('成本价与预留上限（A3/A8）', () => {
  it('returns zero cost when no cost price is configured', () => {
    expect(computeCostAmount(price, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(0);
  });

  it('computes cost without multiplier and without discount', () => {
    const priced: ModelPrice = {
      inputPrice: 4_000,
      outputPrice: 8_000,
      multiplier: 200,
      costInputPrice: 1_000,
      costOutputPrice: 2_000,
    };
    const usage = { promptTokens: 1_000_000, completionTokens: 500_000 };
    // 成本：1000 + 1000 = 2000，与售价倍率/折扣无关。
    expect(computeCostAmount(priced, usage)).toBe(2_000);
    expect(computeCostAmount(priced, usage)).toBeLessThan(computeAmount(priced, usage));
  });

  it('exposes the per-model output cap for reserve estimation', () => {
    expect(reservedOutputTokens(price)).toBe(0);
    expect(reservedOutputTokens({ ...price, maxOutputTokens: 16_384 })).toBe(16_384);
    expect(reservedOutputTokens({ ...price, maxOutputTokens: -1 })).toBe(0);
  });
});
