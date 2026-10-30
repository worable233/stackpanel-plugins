import { describe, expect, it } from 'vitest';
import {
  applyBodyRewrites,
  applyHeaderRewrites,
  hasRewriteOps,
  isSafePath,
  mapStatus,
  rewriteConfigOf,
  traceOf,
  validateRewriteConfig,
} from './rewrite.js';

describe('isSafePath', () => {
  it('接受 1–3 层的标识符路径', () => {
    expect(isSafePath('temperature')).toBe(true);
    expect(isSafePath('stream_options.include_usage')).toBe(true);
    expect(isSafePath('a_b-c.d1.e2')).toBe(true);
  });

  it('拒绝原型链污染与数组下标', () => {
    expect(isSafePath('__proto__')).toBe(false);
    expect(isSafePath('constructor.prototype')).toBe(false);
    expect(isSafePath('a.__proto__.b')).toBe(false);
  });

  it('拒绝过深、空、含空格的路径', () => {
    expect(isSafePath('a.b.c.d')).toBe(false);
    expect(isSafePath('')).toBe(false);
    expect(isSafePath('a b')).toBe(false);
    expect(isSafePath('a..b')).toBe(false);
  });
});

describe('validateRewriteConfig', () => {
  it('缺省输入 = 合法且关闭', () => {
    const result = validateRewriteConfig(undefined);
    expect(result.ok).toBe(true);
    expect(result.config.enabled).toBe(false);
    expect(hasRewriteOps(result.config)).toBe(false);
  });

  it('非对象直接拒绝', () => {
    expect(validateRewriteConfig('nope').ok).toBe(false);
    expect(validateRewriteConfig([]).ok).toBe(false);
  });

  it('归一化头名为小写', () => {
    const result = validateRewriteConfig({
      enabled: true,
      setHeaders: { 'X-Custom': 'v' },
      unsetHeaders: ['X-Other'],
    });
    expect(result.ok).toBe(true);
    expect(result.config.setHeaders).toEqual({ 'x-custom': 'v' });
    expect(result.config.unsetHeaders).toEqual(['x-other']);
  });

  it('状态码键归一化为数字串，同码映射被丢弃', () => {
    const result = validateRewriteConfig({ enabled: true, statusMap: { '529': 503, '500': 500 } });
    expect(result.ok).toBe(true);
    expect(result.config.statusMap).toEqual({ '529': 503 });
  });

  it('拒绝非法路径、非标量值、越界状态码', () => {
    expect(validateRewriteConfig({ set: { '__proto__.x': 1 } }).ok).toBe(false);
    expect(validateRewriteConfig({ set: { temperature: { nested: true } } }).ok).toBe(false);
    expect(validateRewriteConfig({ statusMap: { '999': 500 } }).ok).toBe(false);
    expect(validateRewriteConfig({ statusMap: { '500': 42 } }).ok).toBe(false);
    expect(validateRewriteConfig({ setHeaders: { 'bad header': 'x' } }).ok).toBe(false);
    expect(validateRewriteConfig({ rename: { a: 'a' } }).ok).toBe(false);
  });

  it('拒绝超量操作', () => {
    const set: Record<string, number> = {};
    for (let index = 0; index < 25; index += 1) set[`field${index}`] = index;
    expect(validateRewriteConfig({ set }).ok).toBe(false);
  });

  it('合法配置原样保留', () => {
    const result = validateRewriteConfig({
      enabled: true,
      set: { temperature: 0.2, 'stream_options.include_usage': true },
      unset: ['logprobs'],
      rename: { max_tokens: 'max_completion_tokens' },
      statusMap: { '529': 503 },
    });
    expect(result.ok).toBe(true);
    expect(result.config.set).toEqual({
      temperature: 0.2,
      'stream_options.include_usage': true,
    });
    expect(result.config.rename).toEqual({ max_tokens: 'max_completion_tokens' });
  });
});

describe('rewriteConfigOf', () => {
  it('只有 enabled === true 才生效（默认关闭）', () => {
    expect(rewriteConfigOf({ enabled: false, set: { a: 1 } })).toBeNull();
    expect(rewriteConfigOf({ set: { a: 1 } })).toBeNull();
    expect(rewriteConfigOf(null)).toBeNull();
    expect(rewriteConfigOf({ enabled: 'true' })).toBeNull();
    expect(rewriteConfigOf({ enabled: true, set: { a: 1 } })).not.toBeNull();
  });
});

describe('applyBodyRewrites', () => {
  const config = {
    enabled: true,
    rename: { max_tokens: 'max_completion_tokens' },
    unset: ['logprobs', 'stream_options.include_usage'],
    set: { temperature: 0.2, 'meta.tenant': 'acme' },
  };

  it('关闭时原样返回同一引用', () => {
    const body = { a: 1 };
    expect(applyBodyRewrites(body, { enabled: false, set: { a: 2 } }).value).toBe(body);
  });

  it('rename → unset → set 按序生效', () => {
    const result = applyBodyRewrites(
      {
        max_tokens: 64,
        logprobs: true,
        stream_options: { include_usage: true, other: 1 },
        temperature: 1,
      },
      config,
    );
    expect(result.value).toEqual({
      max_completion_tokens: 64,
      meta: { tenant: 'acme' },
      stream_options: { other: 1 },
      temperature: 0.2,
    });
    expect(result.applied).toContain('body.rename:max_tokens>max_completion_tokens');
    expect(result.applied).toContain('body.unset:logprobs');
    expect(result.applied).toContain('body.set:temperature');
  });

  it('不修改入参对象', () => {
    const body = { temperature: 1 };
    applyBodyRewrites(body, config);
    expect(body).toEqual({ temperature: 1 });
  });

  it('非对象请求体不改写', () => {
    expect(applyBodyRewrites('text', config).applied).toEqual([]);
    expect(applyBodyRewrites([1, 2], config).applied).toEqual([]);
  });

  it('不存在的字段不产生痕迹', () => {
    const result = applyBodyRewrites(
      { temperature: 0.2 },
      { enabled: true, set: { temperature: 0.2 } },
    );
    expect(result.applied).toEqual([]);
    const unset = applyBodyRewrites({}, { enabled: true, unset: ['logprobs'] });
    expect(unset.applied).toEqual([]);
  });

  it('中间层是数组/标量时放弃，不去「修复」结构', () => {
    const result = applyBodyRewrites({ meta: [1, 2] }, { enabled: true, set: { 'meta.x': 1 } });
    expect(result.applied).toEqual([]);
    expect(result.value).toEqual({ meta: [1, 2] });
  });
});

describe('applyHeaderRewrites', () => {
  it('小写化写入并删除指定头', () => {
    const result = applyHeaderRewrites(
      { 'Content-Type': 'application/json', 'x-old': '1' },
      { enabled: true, setHeaders: { 'x-new': '2' }, unsetHeaders: ['x-old'] },
    );
    expect(result.value).toEqual({ 'content-type': 'application/json', 'x-new': '2' });
    expect(result.applied).toEqual(['header.unset:x-old', 'header.set:x-new']);
  });

  it('拒绝改写鉴权与协议关键头', () => {
    const result = applyHeaderRewrites(
      { authorization: 'Bearer x' },
      { enabled: true, setHeaders: { authorization: 'Bearer y' }, unsetHeaders: ['authorization'] },
    );
    expect(result.value).toEqual({ authorization: 'Bearer x' });
    expect(result.applied).toEqual([
      'header.skip-unset:authorization',
      'header.skip-set:authorization',
    ]);
  });

  it('关闭时不做任何事', () => {
    const headers = { 'x-a': '1' };
    expect(applyHeaderRewrites(headers, { enabled: false, setHeaders: { 'x-a': '2' } }).value).toBe(
      headers,
    );
  });
});

describe('mapStatus', () => {
  it('命中映射返回新状态码与痕迹', () => {
    expect(mapStatus(529, { enabled: true, statusMap: { '529': 503 } })).toEqual({
      status: 503,
      trace: 'status.529>503',
    });
  });

  it('状态码 0 不是合法上游状态：未初始化的 httpStatus 不得被当作 2xx', () => {
    // 回归：relay 里 `httpStatus` 曾初始化为 0 且成功路径忘了赋 `response.status`，
    // 结果所有成功请求的用量流水都记 httpStatus=0。mapStatus 对 0 必须无映射。
    expect(mapStatus(0, { enabled: true, statusMap: { '0': 500 } })).toEqual({
      status: 500,
      trace: 'status.0>500',
    });
    expect(mapStatus(0, { enabled: true, statusMap: { '529': 503 } })).toBeNull();
  });

  it('未命中 / 关闭时返回 null（绝不让 2xx 被意外改写）', () => {
    expect(mapStatus(200, { enabled: true, statusMap: { '529': 503 } })).toBeNull();
    expect(mapStatus(529, { enabled: false, statusMap: { '529': 503 } })).toBeNull();
    expect(mapStatus(529, null)).toBeNull();
  });
});

describe('traceOf', () => {
  it('拼接并截断过长痕迹', () => {
    expect(traceOf(['body.set:a', '', 'header.set:b'])).toBe('body.set:a,header.set:b');
    const long = traceOf(Array.from({ length: 40 }, (_, index) => `body.set:field${index}`));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
