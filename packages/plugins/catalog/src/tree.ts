/** A flat row derived from Extension rows of kind `catalog/category`. */
export interface CategoryRow {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A category node with its children and the count of products in its subtree. */
export interface CategoryNode extends CategoryRow {
  children: CategoryNode[];
  productCount: number;
}

/** Build a forest from flat rows; children ordered by sortOrder then zh-CN name. */
export function buildCategoryForest(
  rows: readonly CategoryRow[],
  countsByCategory: ReadonlyMap<string, number>,
): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      ...row,
      productCount: countsByCategory.get(row.id) ?? 0,
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  sortForest(roots);
  accumulateCounts(roots);
  return roots;
}

function sortForest(nodes: CategoryNode[]): void {
  nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'));
  for (const node of nodes) sortForest(node.children);
}

/** Fold child counts upward so productCount covers the entire subtree. */
function accumulateCounts(nodes: readonly CategoryNode[]): void {
  for (const node of nodes) {
    accumulateCounts(node.children);
    node.productCount += node.children.reduce((sum, child) => sum + child.productCount, 0);
  }
}

/** Return the ids of `rootId` and every descendant. */
export function collectSubtreeIds(rows: readonly CategoryRow[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId) {
      const children = childrenByParent.get(row.parentId) ?? [];
      children.push(row.id);
      childrenByParent.set(row.parentId, children);
    }
  }
  const result: string[] = [];
  const visit = (id: string): void => {
    result.push(id);
    for (const child of childrenByParent.get(id) ?? []) visit(child);
  };
  visit(rootId);
  return result;
}

/** Flatten a forest into depth-prefixed options for select elements. */
export function flattenCategoryOptions(
  nodes: readonly CategoryNode[],
  depth = 0,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  for (const node of nodes) {
    options.push({ value: node.id, label: `${'\u3000'.repeat(depth)}${node.name}` });
    options.push(...flattenCategoryOptions(node.children, depth + 1));
  }
  return options;
}
