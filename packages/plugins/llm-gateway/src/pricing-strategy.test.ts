/**
 * 表达式计费（B2）契约测试。
 *
 * 锁死四件事：
 * 1. 语法/词法白名单——写错的表达式必须在**写入时**被拒；
 * 2. 优先级与括号求值正确（算错钱是第一优先级问题）；
 * 3. 除以 0 不抛错、结果被夹在 `[0, MAX]`；
 * 4. 旧定价行（没有 strategy/expr）行为不变。
 */
import { describe, expect, it } from 'vitest';
import { compileExpr, evaluateExpr, EXPR_MAX_AMOUNT, strategyOf } from './pricing-strategy.js';
import { computeAmount, type ModelPrice } from './pricing.js';

describe('compileExpr', () => {
  it('accepts arithmetic with variables and functions', () => {
    const result = compileExpr('prompt_tokens * 0.002 + max(completion_tokens, 1) * 0.008');
    expect(result.ok).toBe(true);
  });

  it('rejects unknown variables', () => {
    const result = compileExpr('prompt_tokens * unknown_var');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未知变量');
  });

  it('rejects unknown functions', () => {
    const result = compileExpr('process.exit(1)');
    expect(result.ok).toBe(false);
  });

  it('rejects arbitrary characters', () => {
    const result = compileExpr('prompt_tokens[0]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不允许的字符');
  });

  it('rejects dangling operators and unbalanced parens', () => {
    expect(compileExpr('1 +').ok).toBe(false);
    expect(compileExpr('(1 + 2').ok).toBe(false);
    expect(compileExpr('').ok).toBe(false);
  });

  it('rejects over-complex expressions', () => {
    const long = Array.from({ length: 300 }, () => '1').join(' + ');
    const result = compileExpr(long);
    expect(result.ok).toBe(false);
  });
});

describe('evaluateExpr', () => {
  it('applies precedence and parentheses', () => {
    expect(evaluateExpr('1 + 2 * 3', {})).toBe(7);
    expect(evaluateExpr('(1 + 2) * 3', {})).toBe(9);
    expect(evaluateExpr('-2 * -3', {})).toBe(6);
  });

  it('reads variables and functions', () => {
    expect(
      evaluateExpr('prompt_tokens * 2 + completion_tokens', {
        prompt_tokens: 10,
        completion_tokens: 5,
      }),
    ).toBe(25);
    expect(
      evaluateExpr(
        'min(prompt_tokens, completion_tokens) + max(prompt_tokens, completion_tokens)',
        {
          prompt_tokens: 3,
          completion_tokens: 8,
        },
      ),
    ).toBe(11);
  });

  it('treats division by zero as zero instead of throwing', () => {
    expect(evaluateExpr('100 / 0', {})).toBe(0);
  });

  it('clamps negatives and absurd amounts', () => {
    expect(evaluateExpr('0 - 100', {})).toBe(0);
    expect(evaluateExpr('1e9 * 1e9', {})).toBeNull(); // 科学计数法不支持 → 编译失败
    expect(evaluateExpr(`${EXPR_MAX_AMOUNT} * 10`, {})).toBe(EXPR_MAX_AMOUNT);
  });

  it('returns null for an uncompilable source (hot path must not throw)', () => {
    expect(evaluateExpr('nope(1)', {})).toBeNull();
  });
});

describe('strategyOf', () => {
  it('infers from tiers and expr when not declared', () => {
    expect(strategyOf({})).toBe('flat');
    expect(strategyOf({ tiers: [{ from: 0 }] })).toBe('tiered');
    expect(strategyOf({ expr: 'prompt_tokens' })).toBe('expr');
  });

  it('honours the explicit declaration', () => {
    expect(strategyOf({ strategy: 'flat', expr: 'prompt_tokens' })).toBe('flat');
  });
});

describe('computeAmount with expr strategy', () => {
  const exprPrice: ModelPrice = {
    inputPrice: 0,
    outputPrice: 0,
    multiplier: 100,
    strategy: 'expr',
    // 每 1K 输入 2 分、每 1K 输出 8 分
    expr: 'prompt_tokens / 1000 * 2 + completion_tokens / 1000 * 8',
  };

  it('uses the expression result as the amount', () => {
    expect(computeAmount(exprPrice, { promptTokens: 2_000, completionTokens: 500 })).toBe(8);
  });

  it('applies the permission-group discount to the expression result', () => {
    expect(
      computeAmount(
        exprPrice,
        { promptTokens: 2_000, completionTokens: 500 },
        { discountPercent: 50 },
      ),
    ).toBe(4);
  });

  it('falls back to flat pricing when the expression is broken', () => {
    const broken: ModelPrice = {
      inputPrice: 1_000,
      outputPrice: 2_000,
      multiplier: 100,
      strategy: 'expr',
      expr: 'bogus_function(1)',
    };
    expect(computeAmount(broken, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(1_000);
  });

  it('charges nothing when the expression evaluates to zero', () => {
    const free: ModelPrice = {
      inputPrice: 100,
      outputPrice: 100,
      multiplier: 100,
      strategy: 'expr',
      expr: 'prompt_tokens * 0',
    };
    expect(computeAmount(free, { promptTokens: 10_000, completionTokens: 10 })).toBe(0);
  });
});
