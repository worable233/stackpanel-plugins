import { describe, expect, it } from 'vitest';
import { idleSyncReason, isProductiveSync } from './index.js';

/**
 * 「同步成功但什么都没做」——线上实测的假成功。
 *
 * 证据（ext_zjmf-upstream_sync-run）：
 *   {"status":"SUCCEEDED","created":0,"updated":0,"skipped":0}
 * 同时 ext_store_product = 0、ext_catalog_product = 0，而上游
 * GET /api/product/list 返回 1890 个商品。
 *
 * 契约：成功必须意味着「有商品被真的处理过」。三种「没干活」要分开报，
 * 因为修法完全不同。
 */

const base = { fetched: 0, bound: 0, created: 0, updated: 0, skipped: 0 };

describe('isProductiveSync', () => {
  it('treats the reported 0/0/0 run as not productive', () => {
    expect(isProductiveSync(base)).toBe(false);
  });

  it('counts an update as productive', () => {
    expect(isProductiveSync({ ...base, fetched: 1890, bound: 3, updated: 3 })).toBe(true);
  });

  it('counts a delisting (skipped) as productive', () => {
    // 上游不再提供某商品时标记 DISCONTINUED 是有效动作。
    expect(isProductiveSync({ ...base, fetched: 1890, bound: 3, skipped: 2 })).toBe(true);
  });

  it('does not count merely fetching as productive', () => {
    expect(isProductiveSync({ ...base, fetched: 1890 })).toBe(false);
  });
});

describe('idleSyncReason', () => {
  it('returns null when the run did work', () => {
    expect(idleSyncReason({ ...base, fetched: 1890, bound: 1, updated: 1 })).toBeNull();
  });

  it('blames the upstream when nothing was fetched', () => {
    const reason = idleSyncReason({ ...base, fetched: 0 });
    expect(reason?.code).toBe('zjmf.sync_upstream_empty');
  });

  it('blames the missing binding when fetched but nothing is bound', () => {
    // 这正是现场：上游有 1890 个商品，本地一个都没绑定。
    const reason = idleSyncReason({ ...base, fetched: 1890, bound: 0 });
    expect(reason?.code).toBe('zjmf.sync_no_bound_products');
    // 提示必须可执行，而不是让用户去猜。
    expect(reason?.message).toMatch(/绑定/);
  });

  it('distinguishes bound-but-unmatched from not-bound-at-all', () => {
    const reason = idleSyncReason({ ...base, fetched: 1890, bound: 5 });
    expect(reason?.code).toBe('zjmf.sync_no_effect');
  });

  it('never returns an empty message', () => {
    for (const summary of [
      base,
      { ...base, fetched: 1 },
      { ...base, fetched: 1, bound: 1 },
    ]) {
      expect(idleSyncReason(summary)?.message.length ?? 0).toBeGreaterThan(0);
    }
  });
});
