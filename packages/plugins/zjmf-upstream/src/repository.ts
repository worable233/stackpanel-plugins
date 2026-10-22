import type { ExtensionInstance } from '@stackpanel/sdk';
import { extensions, storeProductRead, storeProductUpdate } from './context.js';
import {
  zjmfSyncRunModel,
  zjmfUpstreamModel,
  type ZjmfSyncRunData,
  type ZjmfUpstreamData,
} from './data.js';
import type { StoreProductSummary } from './store-capabilities.js';

/** 上游实例 + 引擎元数据。 */
export interface UpstreamRecord extends ZjmfUpstreamData {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toUpstream(
  instance: ExtensionInstance<ZjmfUpstreamData>,
): UpstreamRecord {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export async function getUpstream(id: string): Promise<UpstreamRecord | null> {
  const instance = await extensions().get<ZjmfUpstreamData>(
    zjmfUpstreamModel,
    id,
  );
  return instance ? toUpstream(instance) : null;
}

export async function listUpstreams(): Promise<UpstreamRecord[]> {
  const rows = await extensions().listAll<ZjmfUpstreamData>(zjmfUpstreamModel, {
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toUpstream);
}

export async function listEnabledUpstreams(): Promise<UpstreamRecord[]> {
  const rows = await extensions().listAll<ZjmfUpstreamData>(zjmfUpstreamModel, {
    where: { enabled: { eq: true } },
  });
  return rows.map(toUpstream);
}

/**
 * 读取商品 metadata 里的上游绑定（{@link StoreProductSummary.metadata}.upstream）。
 * 绑定由 store 在商品创建/编辑时写入，zjmf 不持有本地映射表。
 */
export interface ProductUpstreamBinding {
  providerId: string;
  sourceRef: string | null;
  productId: string;
}

export function readUpstreamBinding(
  metadata: unknown,
): ProductUpstreamBinding | null {
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  )
    return null;
  const upstream = (metadata as Record<string, unknown>)['upstream'];
  if (
    upstream === null ||
    typeof upstream !== 'object' ||
    Array.isArray(upstream)
  )
    return null;
  const record = upstream as Record<string, unknown>;
  if (record['providerId'] !== 'zjmf') return null;
  const productId = record['productId'];
  if (typeof productId !== 'string' || !productId) return null;
  return {
    providerId: 'zjmf',
    sourceRef:
      typeof record['sourceRef'] === 'string' ? record['sourceRef'] : null,
    productId,
  };
}

/** 列出所有已绑定魔方上游的商店商品（按需扫描，商店侧商品规模可控）。 */
export async function listBoundProducts(): Promise<
  Array<{ product: StoreProductSummary; binding: ProductUpstreamBinding }>
> {
  const products = await storeProductRead().listAll();
  const result: Array<{
    product: StoreProductSummary;
    binding: ProductUpstreamBinding;
  }> = [];
  for (const product of products) {
    if (product.providerId !== 'zjmf') continue;
    const binding = readUpstreamBinding(product.metadata);
    if (binding) result.push({ product, binding });
  }
  return result;
}

/** 统计某上游实例下已绑定的商店商品数（管理端展示用）。 */
export async function countBoundProducts(upstreamId: string): Promise<number> {
  const products = await storeProductRead().listAll();
  let count = 0;
  for (const product of products) {
    if (product.providerId !== 'zjmf') continue;
    const binding = readUpstreamBinding(product.metadata);
    if (binding?.sourceRef === upstreamId) count += 1;
  }
  return count;
}

export async function createSyncRun(upstreamId: string): Promise<string> {
  const created = await extensions().create<ZjmfSyncRunData>(zjmfSyncRunModel, {
    upstreamId,
    status: 'RUNNING',
    created: 0,
    updated: 0,
    skipped: 0,
  });
  return created.name;
}

export async function finishSyncRun(
  id: string,
  data: {
    status: 'SUCCEEDED' | 'FAILED';
    created?: number;
    updated?: number;
    skipped?: number;
    error?: string | null;
  },
): Promise<void> {
  const instance = await extensions().get<ZjmfSyncRunData>(
    zjmfSyncRunModel,
    id,
  );
  const base: ZjmfSyncRunData = instance?.spec ?? {
    upstreamId: '',
    status: 'RUNNING',
    created: 0,
    updated: 0,
    skipped: 0,
  };
  await extensions().update<ZjmfSyncRunData>(zjmfSyncRunModel, id, {
    ...base,
    status: data.status,
    ...(data.created !== undefined ? { created: data.created } : {}),
    ...(data.updated !== undefined ? { updated: data.updated } : {}),
    ...(data.skipped !== undefined ? { skipped: data.skipped } : {}),
    error: data.error ?? null,
    completedAt: new Date().toISOString(),
  });
}

export async function listSyncRuns(
  upstreamId: string,
): Promise<Array<ZjmfSyncRunData & { id: string; startedAt: Date }>> {
  const rows = await extensions().listAll<ZjmfSyncRunData>(zjmfSyncRunModel, {
    where: { upstreamId: { eq: upstreamId } },
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.slice(0, 30).map((row) => ({
    id: row.name,
    ...row.spec,
    startedAt: row.createdAt,
  }));
}

/* ---------- store product capability wrappers ---------- */

export async function getStoreProduct(
  id: string,
): Promise<StoreProductSummary | null> {
  return storeProductRead().getById(id);
}

export async function listStoreProductsByIds(
  ids: string[],
): Promise<StoreProductSummary[]> {
  return storeProductRead().listByIds(ids);
}

export function storeProductMutation() {
  return storeProductUpdate();
}
