import type { ExtensionClient, ExtensionTransaction } from '@stackpanel/sdk';

/**
 * Stable codes for catalog errors (ADR-0012 §2). The plugin throws
 * `CatalogError(status, message)` in ~26 places; map the stable message to a
 * code here so the wrapper can promote it to `PluginError`.
 */
const CATALOG_ERROR_CODES: Record<string, string> = {
  '缺少商品 ID': 'catalog.product.id_required',
  '商品不存在': 'catalog.product.not_found',
  '上架参数无效': 'catalog.listing.params_invalid',
  '分类不能移动到自身': 'catalog.category.move_into_self',
  '分类不能移动到其子分类下': 'catalog.category.move_into_descendant',
  '排序列表的父分类缺失': 'catalog.category.parent_missing',
  '排序列表包含不存在的分类': 'catalog.sort.category_missing',
  '排序参数无效': 'catalog.sort.params_invalid',
  '分类参数无效': 'catalog.category.params_invalid',
  '缺少分类 ID': 'catalog.category.id_required',
  '分类不存在': 'catalog.category.not_found',
  '分类标识已存在': 'catalog.category.slug_taken',
  '请先删除或移动子分类': 'catalog.category.has_children',
  '分类数据已损坏': 'catalog.category.corrupt',
  '上架数据已损坏': 'catalog.listing.corrupt',
  '商品目录未就绪': 'catalog.not_ready',
  '商店商品数据不可用': 'catalog.store_data_unavailable',
  '商店库存服务不可用': 'catalog.store_stock_unavailable',
};

/** Messages carrying a variable suffix; matched on the part before `：`. */
const CATALOG_ERROR_PREFIX_CODES: Record<string, string> = {
  分类不存在: 'catalog.category.not_found',
};

/** Resolve a stable code from a catalog error message (exact, then prefix). */
export function catalogErrorCode(message: string): string {
  return (
    CATALOG_ERROR_CODES[message] ??
    CATALOG_ERROR_PREFIX_CODES[message.split(/[:：]/)[0] ?? ''] ??
    'catalog.error'
  );
}

export class CatalogError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
    this.code = catalogErrorCode(message);
  }
}

type TransactionRunner = <T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>;

let extensionClient: ExtensionClient | null = null;
let transactionRunner: TransactionRunner | null = null;

/** The plugin's own model client, bound at activation. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new CatalogError(503, '商品目录未就绪');
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!transactionRunner) throw new CatalogError(503, '商品目录未就绪');
  return transactionRunner(fn);
}

export function bindExtensions(client: ExtensionClient, runTransactionFn: TransactionRunner): void {
  extensionClient = client;
  transactionRunner = runTransactionFn;
}

export function clearExtensions(): void {
  extensionClient = null;
  transactionRunner = null;
}
