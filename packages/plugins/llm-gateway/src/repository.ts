import type { CustomModelDefinition, ExtensionInstance, ExtensionWhere } from '@stackpanel/sdk';
import {
  gatewayAccountModel,
  gatewayBillingEntryModel,
  gatewayConfigModel,
  gatewayKeyPolicyModel,
  gatewayLegacyKeyModel,
  gatewayModelPriceModel,
  gatewayTaskModel,
  gatewayUsageLogModel,
  gatewayUserSettingModel,
  type GatewayAccountData,
  type GatewayBillingEntryData,
  type GatewayConfigData,
  type GatewayKeyPolicyData,
  type GatewayLegacyKeyData,
  type GatewayModelPriceData,
  type GatewayTaskData,
  type GatewayUsageLogData,
  type GatewayUserSettingData,
} from './data.js';
import { extensions } from './context.js';
import { DEFAULT_PRICE_MODEL } from './pricing.js';

/** 平台配置内置默认值（未配置过时的兜底）。 */
const DEFAULT_GATEWAY_CONFIG: GatewayConfigData = {
  globalConcurrency: 0,
  userRpm: 0,
  modelRpm: 0,
  providerRpm: 0,
  retryAttempts: 3,
  maxResponseBytes: 32 * 1024 * 1024,
  holdTtlMs: 15 * 60 * 1000,
};

/** Extension instance flattened into `{ id, ...spec, createdAt, updatedAt }`. */
type Row<T> = T & { id: string; createdAt: string; updatedAt: string };

function toRow<T>(instance: ExtensionInstance<T>): Row<T> {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

/**
 * Page through `list` until `take` rows are collected. Used by analytics reads
 * whose historical `findMany({ take })` semantics exceeded the engine's single
 * page cap; batching preserves the same upper bound instead of silently
 * truncating at one page.
 */
async function pageTake<T>(
  model: CustomModelDefinition,
  options: {
    where?: ExtensionWhere;
    orderBy?: { field: string; desc?: boolean };
    take: number;
  },
): Promise<Array<ExtensionInstance<T>>> {
  const pageSize = 200;
  const out: Array<ExtensionInstance<T>> = [];
  let page = 1;
  for (;;) {
    const result = await extensions().list<T>(model, {
      ...(options.where ? { where: options.where } : {}),
      ...(options.orderBy ? { orderBy: options.orderBy } : {}),
      page,
      pageSize,
    });
    out.push(...result.items);
    if (out.length >= options.take || out.length >= result.total || result.items.length === 0) {
      break;
    }
    page += 1;
  }
  return out.slice(0, options.take);
}

/* -------------------------------- 账号池 -------------------------------- */

export type AccountRow = Row<GatewayAccountData>;

export async function listActiveAccounts(): Promise<AccountRow[]> {
  const rows = await extensions().listAll<GatewayAccountData>(gatewayAccountModel, {
    where: { status: { eq: 'ACTIVE' } },
  });
  return rows.map(toRow);
}

export async function listAllAccounts(): Promise<AccountRow[]> {
  const rows = await extensions().listAll<GatewayAccountData>(gatewayAccountModel, {
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toRow);
}

export async function countAccounts(): Promise<number> {
  const result = await extensions().list(gatewayAccountModel, { page: 1, pageSize: 1 });
  return result.total;
}

export async function getAccount(id: string): Promise<AccountRow | null> {
  const instance = await extensions().get<GatewayAccountData>(gatewayAccountModel, id);
  return instance ? toRow(instance) : null;
}

export async function createAccount(spec: GatewayAccountData): Promise<AccountRow> {
  const instance = await extensions().create(gatewayAccountModel, spec);
  return toRow(instance);
}

export async function updateAccount(
  id: string,
  patch: Partial<GatewayAccountData>,
): Promise<AccountRow | null> {
  const current = await extensions().get<GatewayAccountData>(gatewayAccountModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayAccountModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

export async function removeAccount(id: string): Promise<boolean> {
  const current = await extensions().get<GatewayAccountData>(gatewayAccountModel, id);
  if (!current) return false;
  await extensions().delete(gatewayAccountModel, id);
  return true;
}

/* ------------------------------ 凭证策略 ------------------------------ */

export type KeyPolicyRow = Row<GatewayKeyPolicyData>;

export async function getPolicy(apiTokenId: string): Promise<KeyPolicyRow | null> {
  const instance = await extensions().get<GatewayKeyPolicyData>(gatewayKeyPolicyModel, apiTokenId);
  return instance ? toRow(instance) : null;
}

export async function listPoliciesByTokens(apiTokenIds: string[]): Promise<KeyPolicyRow[]> {
  if (apiTokenIds.length === 0) return [];
  const rows = await extensions().listAll<GatewayKeyPolicyData>(gatewayKeyPolicyModel, {
    where: { apiTokenId: { in: apiTokenIds } },
  });
  return rows.map(toRow);
}

/** Upsert the plugin policy keyed by its ApiToken id (instance id = apiTokenId). */
export async function upsertPolicy(
  apiTokenId: string,
  patch: Partial<GatewayKeyPolicyData>,
): Promise<KeyPolicyRow> {
  const current = await extensions().get<GatewayKeyPolicyData>(gatewayKeyPolicyModel, apiTokenId);
  if (current) {
    const instance = await extensions().update(gatewayKeyPolicyModel, apiTokenId, {
      ...current.spec,
      ...patch,
    });
    return toRow(instance);
  }
  const instance = await extensions().create(
    gatewayKeyPolicyModel,
    {
      apiTokenId,
      models: [],
      rpmLimit: 0,
      concurrencyLimit: 0,
      quotaLimit: null,
      quotaUsed: 0,
      ...patch,
    },
    { name: apiTokenId },
  );
  return toRow(instance);
}

export async function removePolicy(apiTokenId: string): Promise<void> {
  await extensions()
    .delete(gatewayKeyPolicyModel, apiTokenId)
    .catch(() => undefined);
}

/** Charge `amount` minor units against the token's policy, creating it if absent. */
export async function addPolicyUsage(apiTokenId: string, amount: number): Promise<void> {
  const updated = await extensions()
    .updateWhere(gatewayKeyPolicyModel, { apiTokenId: { eq: apiTokenId } }, { quotaUsed: { inc: amount } })
    .then((result) => result.updated)
    .catch(() => 0);
  if (updated > 0) return;
  await upsertPolicy(apiTokenId, { quotaUsed: amount }).catch(() => undefined);
}

/* ------------------------------ 平台配置 ------------------------------ */

/** 平台配置单例的实例 id。 */
export const CONFIG_INSTANCE_ID = 'default';

/** 读平台配置；从未配置过时返回内置默认值。 */
export async function getConfig(): Promise<GatewayConfigData> {
  const instance = await extensions()
    .get<GatewayConfigData>(gatewayConfigModel, CONFIG_INSTANCE_ID)
    .catch(() => null);
  if (!instance) return { ...DEFAULT_GATEWAY_CONFIG };
  return { ...DEFAULT_GATEWAY_CONFIG, ...instance.spec };
}

/** 写平台配置（整体替换，未给的字段回落默认）。 */
export async function setConfig(patch: Partial<GatewayConfigData>): Promise<GatewayConfigData> {
  const current = await getConfig();
  const next: GatewayConfigData = { ...current, ...patch };
  const existing = await extensions()
    .get<GatewayConfigData>(gatewayConfigModel, CONFIG_INSTANCE_ID)
    .catch(() => null);
  const instance = existing
    ? await extensions().update(gatewayConfigModel, CONFIG_INSTANCE_ID, next)
    : await extensions().create(gatewayConfigModel, next, { name: CONFIG_INSTANCE_ID });
  return instance.spec;
}

/* ------------------------------ 计费开关 ------------------------------ */

export async function getSetting(userId: string): Promise<GatewayUserSettingData | null> {
  const instance = await extensions().get<GatewayUserSettingData>(gatewayUserSettingModel, userId);
  return instance ? instance.spec : null;
}

export async function setSetting(
  userId: string,
  billingEnabled: boolean,
): Promise<GatewayUserSettingData> {
  const current = await extensions().get<GatewayUserSettingData>(gatewayUserSettingModel, userId);
  const instance = current
    ? await extensions().update(gatewayUserSettingModel, userId, { userId, billingEnabled })
    : await extensions().create(gatewayUserSettingModel, { userId, billingEnabled }, { name: userId });
  return instance.spec;
}

/* ------------------------------ 用量流水 ------------------------------ */

export type UsageLogRow = Row<GatewayUsageLogData>;

export async function createUsageLog(spec: GatewayUsageLogData): Promise<UsageLogRow> {
  const instance = await extensions().create(gatewayUsageLogModel, spec);
  return toRow(instance);
}

export async function setUsageLogError(id: string, error: string): Promise<void> {
  const current = await extensions().get<GatewayUsageLogData>(gatewayUsageLogModel, id);
  if (!current) return;
  await extensions().update(gatewayUsageLogModel, id, { ...current.spec, error });
}

export async function listRecentLogs(userId: string, take: number): Promise<UsageLogRow[]> {
  const rows = await extensions().list<GatewayUsageLogData>(gatewayUsageLogModel, {
    where: { userId: { eq: userId } },
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return rows.items.map(toRow);
}

export async function listUserLogsSince(userId: string, since: Date): Promise<UsageLogRow[]> {
  const rows = await pageTake<GatewayUsageLogData>(gatewayUsageLogModel, {
    // `createdAt` is a built-in timestamp column; the engine binds the value
    // straight to SQL, so a Date is correct despite the numeric operator type.
    where: { userId: { eq: userId }, createdAt: { gte: since as unknown as number } },
    orderBy: { field: 'createdAt', desc: true },
    take: 20_000,
  });
  return rows.map(toRow);
}

export async function listLogsSince(since: Date, take: number): Promise<UsageLogRow[]> {
  const rows = await pageTake<GatewayUsageLogData>(gatewayUsageLogModel, {
    where: { createdAt: { gte: since as unknown as number } },
    orderBy: { field: 'createdAt', desc: true },
    take,
  });
  return rows.map(toRow);
}

export async function listRecentAllLogs(take: number): Promise<UsageLogRow[]> {
  const rows = await extensions().list<GatewayUsageLogData>(gatewayUsageLogModel, {
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return rows.items.map(toRow);
}

/* ------------------------------ 计费台账 ------------------------------ */

export type BillingEntryRow = Row<GatewayBillingEntryData>;

/**
 * 建一条台账。`referenceId`（= usage-log 的 id）上有唯一索引，因此这一步天然
 * 幂等：重放同一个 referenceId 会抛唯一约束，调用方据此判定「已经建过」。
 */
export async function createBillingEntry(spec: GatewayBillingEntryData): Promise<BillingEntryRow> {
  const instance = await extensions().create(gatewayBillingEntryModel, spec);
  return toRow(instance);
}

export async function getBillingByReference(referenceId: string): Promise<BillingEntryRow | null> {
  const result = await extensions().list<GatewayBillingEntryData>(gatewayBillingEntryModel, {
    where: { referenceId: { eq: referenceId } },
    page: 1,
    pageSize: 1,
  });
  const row = result.items[0];
  return row ? toRow(row) : null;
}

export async function getBillingEntry(id: string): Promise<BillingEntryRow | null> {
  const instance = await extensions().get<GatewayBillingEntryData>(gatewayBillingEntryModel, id);
  return instance ? toRow(instance) : null;
}

export async function updateBillingEntry(
  id: string,
  patch: Partial<GatewayBillingEntryData>,
): Promise<BillingEntryRow | null> {
  const current = await extensions().get<GatewayBillingEntryData>(gatewayBillingEntryModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayBillingEntryModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

/** 待补偿队列：COMPENSATING 且已到重试时间的台账，按到期时间升序。 */
export async function listPendingCompensations(
  now: number,
  take = 50,
): Promise<BillingEntryRow[]> {
  const rows = await extensions().list<GatewayBillingEntryData>(gatewayBillingEntryModel, {
    where: { status: { eq: 'COMPENSATING' } },
    orderBy: { field: 'nextAttemptAt', desc: false },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return rows.items.filter((row) => (row.spec.nextAttemptAt ?? 0) <= now).map(toRow);
}

/** 运维查询：全部补偿相关台账（不分到期与否）。 */
export async function listCompensationEntries(take = 100): Promise<BillingEntryRow[]> {
  const rows = await extensions().list<GatewayBillingEntryData>(gatewayBillingEntryModel, {
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return rows.items
    .filter((row) => row.spec.status === 'COMPENSATING' || row.spec.status === 'FAILED')
    .map(toRow);
}

/* ------------------------------ 异步任务 ------------------------------ */

export type TaskRow = Row<GatewayTaskData>;

export async function createTask(spec: GatewayTaskData): Promise<TaskRow> {
  const instance = await extensions().create(gatewayTaskModel, spec);
  return toRow(instance);
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const instance = await extensions().get<GatewayTaskData>(gatewayTaskModel, id);
  return instance ? toRow(instance) : null;
}

export async function updateTask(
  id: string,
  patch: Partial<GatewayTaskData>,
): Promise<TaskRow | null> {
  const current = await extensions().get<GatewayTaskData>(gatewayTaskModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayTaskModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

export async function listTasks(take = 100, status?: string): Promise<TaskRow[]> {
  const result = await extensions().list<GatewayTaskData>(gatewayTaskModel, {
    ...(status ? { where: { status: { eq: status } } } : {}),
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return result.items.map(toRow);
}

/* ------------------------------ 模型定价 ------------------------------ */

export type PriceRow = Row<GatewayModelPriceData>;

export async function listEnabledPrices(): Promise<PriceRow[]> {
  const rows = await extensions().listAll<GatewayModelPriceData>(gatewayModelPriceModel, {
    where: { enabled: { eq: true } },
  });
  return rows.map(toRow);
}

/**
 * Read only the pricing rows one request can resolve to: the exact model plus
 * the `*` fallback row.
 *
 * The relay used to pull every enabled row per request and select in memory,
 * which costs O(rows) bytes over IPC and O(rows) work on the hot path. The set
 * `resolveServedPrice` can ever pick from is exactly `{model, '*'}` — the rest
 * is filtered out immediately — so asking for those two keeps the result
 * bounded however large the price list grows.
 */
export async function listPricesForModel(model: string): Promise<PriceRow[]> {
  const names =
    model && model !== DEFAULT_PRICE_MODEL ? [model, DEFAULT_PRICE_MODEL] : [DEFAULT_PRICE_MODEL];
  const result = await extensions().list<GatewayModelPriceData>(gatewayModelPriceModel, {
    where: { enabled: { eq: true }, model: { in: names } },
    page: 1,
    pageSize: 2,
  });
  return result.items.map(toRow);
}

export async function listAllPrices(): Promise<PriceRow[]> {
  const rows = await extensions().listAll<GatewayModelPriceData>(gatewayModelPriceModel, {
    orderBy: { field: 'model' },
  });
  return rows.map(toRow);
}

export async function getPrice(model: string): Promise<PriceRow | null> {
  const instance = await extensions().get<GatewayModelPriceData>(gatewayModelPriceModel, model);
  return instance ? toRow(instance) : null;
}

export async function getPriceById(id: string): Promise<PriceRow | null> {
  const instance = await extensions().get<GatewayModelPriceData>(gatewayModelPriceModel, id);
  return instance ? toRow(instance) : null;
}

export async function createPrice(spec: GatewayModelPriceData): Promise<PriceRow> {
  const instance = await extensions().create(gatewayModelPriceModel, spec, { name: spec.model });
  return toRow(instance);
}

export async function updatePrice(
  id: string,
  patch: Partial<GatewayModelPriceData>,
): Promise<PriceRow | null> {
  const current = await extensions().get<GatewayModelPriceData>(gatewayModelPriceModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayModelPriceModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

export async function removePrice(id: string): Promise<boolean> {
  const current = await extensions().get<GatewayModelPriceData>(gatewayModelPriceModel, id);
  if (!current) return false;
  await extensions().delete(gatewayModelPriceModel, id);
  return true;
}

/* --------------------------- 历史密钥（双读兜底） --------------------------- */

export type LegacyKeyRow = Row<GatewayLegacyKeyData>;

export async function getLegacyByHash(keyHash: string): Promise<LegacyKeyRow | null> {
  const result = await extensions().list<GatewayLegacyKeyData>(gatewayLegacyKeyModel, {
    where: { keyHash: { eq: keyHash } },
    page: 1,
    pageSize: 1,
  });
  const row = result.items[0];
  return row ? toRow(row) : null;
}

export async function addLegacyUsage(
  id: string,
  amount: number,
  lastUsedAt: Date,
): Promise<void> {
  await extensions().updateWhere(
    gatewayLegacyKeyModel,
    { name: { eq: id } },
    { quotaUsed: { inc: amount }, lastUsedAt: { set: lastUsedAt.toISOString() } },
  );
}
