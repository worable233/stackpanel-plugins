/**
 * 模型映射（B4）契约测试。
 *
 * 关键不变量：映射只改「转发给谁」，不改计费/权限；配置错误时**回退到原名**
 * 而不是把请求打到错误的模型上。
 */
import { describe, expect, it } from 'vitest';
import {
  pickTarget,
  resolveModelMap,
  ruleMatches,
  validateModelMapRule,
  type ModelMapRule,
} from './model-map.js';

function rule(over: Partial<ModelMapRule> = {}): ModelMapRule {
  return {
    from: 'gpt-4o',
    mode: 'exact',
    targets: [{ model: 'gpt-4o-2024-08', weight: 100 }],
    priority: 0,
    enabled: true,
    ...over,
  };
}

describe('ruleMatches', () => {
  it('matches exact, prefix and regex', () => {
    expect(ruleMatches(rule(), 'gpt-4o')).toBe(true);
    expect(ruleMatches(rule(), 'gpt-4o-mini')).toBe(false);
    expect(ruleMatches(rule({ mode: 'prefix', from: 'claude-3-5' }), 'claude-3-5-sonnet')).toBe(
      true,
    );
    expect(
      ruleMatches(rule({ mode: 'regex', from: '^gemini-\\d+\\.\\d+' }), 'gemini-2.5-pro'),
    ).toBe(true);
  });

  it('ignores disabled rules and invalid regex', () => {
    expect(ruleMatches(rule({ enabled: false }), 'gpt-4o')).toBe(false);
    expect(ruleMatches(rule({ mode: 'regex', from: '(' }), 'anything')).toBe(false);
  });
});

describe('pickTarget', () => {
  it('picks by weight deterministically with an injected random', () => {
    const targets = [
      { model: 'a', weight: 100 },
      { model: 'b', weight: 300 },
    ];
    expect(pickTarget(targets, () => 0.0)).toBe('a');
    expect(pickTarget(targets, () => 0.99)).toBe('b');
  });

  it('returns null when no target is usable', () => {
    expect(pickTarget([{ model: 'a', weight: 0 }], () => 0.5)).toBeNull();
    expect(pickTarget([], () => 0.5)).toBeNull();
  });
});

describe('resolveModelMap', () => {
  it('prefers higher priority, then exact over prefix over regex', () => {
    const rules = [
      rule({ from: 'gpt', mode: 'prefix', priority: 0, targets: [{ model: 'prefix', weight: 1 }] }),
      rule({
        from: 'gpt-4o',
        mode: 'exact',
        priority: 0,
        targets: [{ model: 'exact', weight: 1 }],
      }),
      rule({
        from: '^gpt',
        mode: 'regex',
        priority: 10,
        targets: [{ model: 'regex', weight: 1 }],
      }),
    ];
    expect(resolveModelMap(rules, 'gpt-4o', { random: () => 0.1 })?.model).toBe('regex');
  });

  it('uses specificity when priorities tie', () => {
    const rules = [
      rule({ from: 'gpt', mode: 'prefix', targets: [{ model: 'short', weight: 1 }] }),
      rule({ from: 'gpt-4o', mode: 'prefix', targets: [{ model: 'long', weight: 1 }] }),
    ];
    expect(resolveModelMap(rules, 'gpt-4o-mini', { random: () => 0.1 })?.model).toBe('long');
  });

  it('returns null when nothing matches', () => {
    expect(resolveModelMap([rule()], 'claude-3')).toBeNull();
  });

  it('skips a matched rule whose targets are all disabled', () => {
    const rules = [
      rule({ from: 'x', targets: [{ model: 'a', weight: 0 }] }),
      rule({ from: 'x', mode: 'prefix', priority: -1, targets: [{ model: 'b', weight: 1 }] }),
    ];
    expect(resolveModelMap(rules, 'x', { random: () => 0.5 })?.model).toBe('b');
  });
});

describe('validateModelMapRule', () => {
  it('rejects empty patterns, bad regex and empty targets', () => {
    expect(validateModelMapRule({ from: '  ', mode: 'exact', targets: [] })).toContain('不能为空');
    expect(
      validateModelMapRule({ from: '(', mode: 'regex', targets: [{ model: 'a', weight: 1 }] }),
    ).toContain('正则不合法');
    expect(validateModelMapRule({ from: 'a', mode: 'exact', targets: [] })).toContain(
      '至少需要一个目标',
    );
    expect(
      validateModelMapRule({ from: 'a', mode: 'exact', targets: [{ model: 'a', weight: 0 }] }),
    ).toContain('大于 0');
  });

  it('accepts a well-formed rule', () => {
    expect(
      validateModelMapRule({ from: 'a', mode: 'exact', targets: [{ model: 'b', weight: 100 }] }),
    ).toBeNull();
  });
});
