import type { ExtensionInstance } from '@stackpanel/sdk';
import { extensions, storeProductRead, storeProductUpdate } from './context.js';
import {
  zjmfProductMappingModel,
  zjmfSyncRunModel,
  zjmfUpstreamModel,
  type ZjmfProductMappingData,
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

/** 映射实例 + 引擎元数据。 */
export interface MappingRecord extends ZjmfProductMappingData {
  id: string;
}

export function toUpstream(instance: ExtensionInstance<ZjmfUpstreamData>): UpstreamRecord {
  return { id: instance.name, ...instance.spec, createdAt: instance.createdAt, updatedAt: instance.updatedAt };
}

export function toMapping(instance: ExtensionInstance<ZjmfProductMappingData>): MappingRecord {
  return { id: instance.name, ...instance.spec };
}

export async function getUpstream(id: string): Promise<UpstreamRecord | null> {
  const instance = await extensions().get<ZjmfUpstreamData>(zjmfUpstreamModel, id);
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

export async function countMappings(upstreamId: string): Promise<number> {
  const rows = await extensions().listAll<ZjmfProductMappingData>(zjmfProductMappingModel, {
    where: { upstreamId: { eq: upstreamId } },
  });
  return rows.length;
}

export async function listMappings(upstreamId: string): Promise<MappingRecord[]> {
  const rows = await extensions().listAll<ZjmfProductMappingData>(zjmfProductMappingModel, {
    where: { upstreamId: { eq: upstreamId } },
  });
  return rows.map(toMapping);
}

export async function findMappingByProductId(productId: string): Promise<MappingRecord | null> {
  const page = await extensions().list<ZjmfProductMappingData>(zjmfProductMappingModel, {
    where: { productId: { eq: productId } },
    page: 1,
    pageSize: 1,
  });
  const item = page.items[0];
  return item ? toMapping(item) : null;
}

export async function findMappingByUpstreamProduct(
  upstreamId: string,
  upstreamProductId: string,
): Promise<MappingRecord | null> {
  const page = await extensions().list<ZjmfProductMappingData>(zjmfProductMappingModel, {
    where: { upstreamId: { eq: upstreamId }, upstreamProductId: { eq: upstreamProductId } },
    page: 1,
    pageSize: 1,
  });
  const item = page.items[0];
  return item ? toMapping(item) : null;
}

/** 建立或更新映射（按 upstreamId+upstreamProductId 唯一）。 */
export async function upsertMapping(
  data: ZjmfProductMappingData,
): Promise<MappingRecord> {
  const existing = await findMappingByUpstreamProduct(data.upstreamId, data.upstreamProductId);
  if (existing) {
    const updated = await extensions().update<ZjmfProductMappingData>(
      zjmfProductMappingModel,
      existing.id,
      { ...existing, ...data },
    );
    return toMapping(updated);
  }
  const created = await extensions().create<ZjmfProductMappingData>(
    zjmfProductMappingModel,
    data,
  );
  return toMapping(created);
}

export async function updateMapping(
  id: string,
  spec: ZjmfProductMappingData,
): Promise<void> {
  await extensions().update<ZjmfProductMappingData>(zjmfProductMappingModel, id, spec);
}

export async function deleteMapping(id: string): Promise<void> {
  await extensions().delete(zjmfProductMappingModel, id);
}

export async function deleteMappingsByProductId(productId: string): Promise<void> {
  const rows = await extensions().listAll<ZjmfProductMappingData>(zjmfProductMappingModel, {
    where: { productId: { eq: productId } },
  });
  for (const row of rows) {
    await extensions().delete(zjmfProductMappingModel, row.name);
  }
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
  const instance = await extensions().get<ZjmfSyncRunData>(zjmfSyncRunModel, id);
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

export async function listSyncRuns(upstreamId: string): Promise<Array<ZjmfSyncRunData & { id: string; startedAt: Date }>> {
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

export async function getStoreProduct(id: string): Promise<StoreProductSummary | null> {
  return storeProductRead().getById(id);
}

export async function listStoreProductsByIds(ids: string[]): Promise<StoreProductSummary[]> {
  return storeProductRead().listByIds(ids);
}

export function storeProductMutation() {
  return storeProductUpdate();
}
