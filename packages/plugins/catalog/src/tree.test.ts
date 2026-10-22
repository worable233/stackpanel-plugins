import { describe, expect, it } from 'vitest';
import type { CategoryRow } from './tree.js';
import { buildCategoryForest, collectSubtreeIds, flattenCategoryOptions } from './tree.js';

function row(partial: Partial<CategoryRow> & { id: string }): CategoryRow {
  return {
    parentId: null,
    name: partial.id,
    slug: null,
    description: null,
    sortOrder: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
  };
}

describe('catalog tree helpers', () => {
  it('builds a forest with children ordered by sortOrder then zh-CN name', () => {
    const rows = [
      row({ id: 'b', parentId: 'root', sortOrder: 1 }),
      row({ id: 'a', parentId: 'root', sortOrder: 0 }),
      row({ id: 'root' }),
      row({ id: 'orphan', parentId: 'missing', sortOrder: 1 }),
    ];
    const forest = buildCategoryForest(rows, new Map());
    expect(forest.map((node) => node.id)).toEqual(['root', 'orphan']);
    expect(forest[0]?.children.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('accumulates product counts across the whole subtree', () => {
    const rows = [
      row({ id: 'root' }),
      row({ id: 'a', parentId: 'root' }),
      row({ id: 'a1', parentId: 'a' }),
      row({ id: 'b', parentId: 'root' }),
    ];
    const counts = new Map([
      ['a1', 2],
      ['a', 3],
      ['b', 5],
    ]);
    const forest = buildCategoryForest(rows, counts);
    expect(forest[0]?.productCount).toBe(10);
    const nodeA = forest[0]?.children.find((node) => node.id === 'a');
    expect(nodeA?.productCount).toBe(5);
    expect(nodeA?.children[0]?.productCount).toBe(2);
  });

  it('collects a subtree including the root and all descendants', () => {
    const rows = [
      row({ id: 'root' }),
      row({ id: 'a', parentId: 'root' }),
      row({ id: 'a1', parentId: 'a' }),
      row({ id: 'b', parentId: 'root' }),
    ];
    expect(collectSubtreeIds(rows, 'a')).toEqual(['a', 'a1']);
    expect(collectSubtreeIds(rows, 'root')).toEqual(['root', 'a', 'a1', 'b']);
  });

  it('flattens a forest into depth-prefixed select options', () => {
    const rows = [
      row({ id: 'root' }),
      row({ id: 'a', parentId: 'root' }),
      row({ id: 'a1', parentId: 'a' }),
    ];
    const forest = buildCategoryForest(rows, new Map());
    const options = flattenCategoryOptions(forest);
    expect(options).toEqual([
      { value: 'root', label: 'root' },
      { value: 'a', label: '\u3000a' },
      { value: 'a1', label: '\u3000\u3000a1' },
    ]);
  });
});
