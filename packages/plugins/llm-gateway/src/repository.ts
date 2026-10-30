import type { CustomModelDefinition, ExtensionInstance, ExtensionWhere } from '@stackpanel/sdk';
import {
  gatewayAccountModel,
  gatewayBillingEntryModel,
  gatewayBudgetLimitModel,
  gatewayConfigModel,
  gatewayEntitlementModel,
  gatewayKeyPolicyModel,
  gatewayLegacyKeyModel,
  gatewayModelMapModel,
  gatewayModelPriceModel,
  gatewayTaskModel,
  gatewayUsageLogModel,
  gatewayUserSettingModel,
  type GatewayAccountData,
  type GatewayBillingEntryData,
  type GatewayBudgetLimitData,
  type GatewayConfigData,
  type GatewayEntitlementData,
  type GatewayKeyPolicyData,
  type GatewayLegacyKeyData,
  type GatewayModelMapData,
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
  autoDisableKeywords: [
    'insufficient balance',
    'insufficient_quota',
    '余额不足',
    '已欠费',
    'account has been disabled',
    'invalid api key',
  ],
  autoDisableStatusCodes: [],
  autoDisableCooldownMs: 10 * 60 * 1000,
  budgetPeriod: 'month',
  sensitiveWords: [],
  sensitiveWordAction: 'block',
  usdRateMinor: 700,
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
    .updateWhere(
      gatewayKeyPolicyModel,
      { apiTokenId: { eq: apiTokenId } },
      { quotaUsed: { inc: amount } },
    )
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
  const merged = { ...DEFAULT_GATEWAY_CONFIG, ...instance.spec };
  // 历史行没有敏感词字段；同时容忍被手工改坏的词表（非数组 → 视为关闭）。
  if (!Array.isArray(merged.sensitiveWords)) merged.sensitiveWords = [];
  if (merged.sensitiveWordAction !== 'log') merged.sensitiveWordAction = 'block';
  return merged;
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
    : await extensions().create(
        gatewayUserSettingModel,
        { userId, billingEnabled },
        { name: userId },
      );
  return instance.spec;
}

/* ------------------------------ 用量流水 ------------------------------ */

export type UsageLogRow = Row<GatewayUsageLogData>;

export async function createUsageLog(spec: GatewayUsageLogData): Promise<UsageLogRow> {
  const instance = await extensions().create(gatewayUsageLogModel, spec);
  return toRow(instance);
}

export async function patchUsageLog(
  id: string,
  patch: Partial<GatewayUsageLogData>,
): Promise<void> {
  const current = await extensions().get<GatewayUsageLogData>(gatewayUsageLogModel, id);
  if (!current) return;
  await extensions()
    .update(gatewayUsageLogModel, id, { ...current.spec, ...patch })
    .catch(() => undefined);
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

/** 管理端用量日志筛选条件（A5）。`since` 走 createdAt 索引下界，不支持上界。 */
export interface UsageLogQuery {
  userId?: string | undefined;
  apiKeyId?: string | undefined;
  accountId?: string | undefined;
  model?: string | undefined;
  status?: string | undefined;
  since?: Date | undefined;
  page: number;
  pageSize: number;
}

export interface UsageLogPage {
  items: UsageLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 管理端分页查询用量流水。
 *
 * 引擎的 `where` 每个字段只能带一个操作符，所以时间条件只支持下界
 * （`since` → `createdAt gte`）。默认看最近窗口，上界由调用方的预设区间保证。
 */
export async function listUsageLogs(query: UsageLogQuery): Promise<UsageLogPage> {
  const where: ExtensionWhere = {};
  if (query.userId) where['userId'] = { eq: query.userId };
  if (query.apiKeyId) where['apiKeyId'] = { eq: query.apiKeyId };
  if (query.accountId) where['accountId'] = { eq: query.accountId };
  if (query.model) where['model'] = { eq: query.model };
  if (query.status) where['status'] = { eq: query.status };
  if (query.since) where['createdAt'] = { gte: query.since as unknown as number };
  const rows = await extensions().list<GatewayUsageLogData>(gatewayUsageLogModel, {
    ...(Object.keys(where).length > 0 ? { where } : {}),
    orderBy: { field: 'createdAt', desc: true },
    page: query.page,
    pageSize: Math.min(Math.max(1, query.pageSize), 200),
  });
  return {
    items: rows.items.map(toRow),
    total: rows.total,
    page: rows.page,
    pageSize: rows.pageSize,
  };
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
export async function listPendingCompensations(now: number, take = 50): Promise<BillingEntryRow[]> {
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

export async function listUserTasks(userId: string, take = 50): Promise<TaskRow[]> {
  const result = await extensions().list<GatewayTaskData>(gatewayTaskModel, {
    where: { userId: { eq: userId } },
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return result.items.map(toRow);
}

/**
 * 到期需要轮询的任务（执行器用）。
 *
 * 只取 `QUEUED` / `RUNNING`：终态任务即使 `nextPollAt` 残留也不会被重新拉起。
 * 结果按 `nextPollAt` 升序，保证「先到期的先推进」，避免少数慢任务排在队尾饿死。
 */
export async function listDueTasks(now: number, take = 10): Promise<TaskRow[]> {
  const result = await extensions().list<GatewayTaskData>(gatewayTaskModel, {
    where: {
      status: { in: ['QUEUED', 'RUNNING'] },
      nextPollAt: { lte: now },
    },
    orderBy: { field: 'nextPollAt', desc: false },
    page: 1,
    pageSize: Math.min(take, 50),
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

export async function addLegacyUsage(id: string, amount: number, lastUsedAt: Date): Promise<void> {
  await extensions().updateWhere(
    gatewayLegacyKeyModel,
    { name: { eq: id } },
    { quotaUsed: { inc: amount }, lastUsedAt: { set: lastUsedAt.toISOString() } },
  );
}

/* ------------------------------ 套餐权益（B1） ------------------------------ */

export type EntitlementRow = Row<GatewayEntitlementData>;

export async function createEntitlement(spec: GatewayEntitlementData): Promise<EntitlementRow> {
  const instance = await extensions().create(gatewayEntitlementModel, spec);
  return toRow(instance);
}

export async function getEntitlement(id: string): Promise<EntitlementRow | null> {
  const instance = await extensions().get<GatewayEntitlementData>(gatewayEntitlementModel, id);
  return instance ? toRow(instance) : null;
}

export async function listUserEntitlements(userId: string): Promise<EntitlementRow[]> {
  const rows = await extensions().listAll<GatewayEntitlementData>(gatewayEntitlementModel, {
    where: { userId: { eq: userId } },
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toRow);
}

/**
 * 该用户可用于抵扣的权益（未按模型/有效期过滤，由 `pickEntitlement` 判断）。
 *
 * 只按 `status` + `userId` 走索引，避免把「已耗尽」的行也拉回来：
 * 结算热路径上这张表的行数会随购买量增长。
 */
export async function listActiveEntitlements(userId: string): Promise<EntitlementRow[]> {
  const rows = await extensions().listAll<GatewayEntitlementData>(gatewayEntitlementModel, {
    where: { userId: { eq: userId }, status: { eq: 'ACTIVE' } },
    orderBy: { field: 'priority' },
  });
  return rows.map(toRow);
}

export async function listAllEntitlements(take = 200): Promise<EntitlementRow[]> {
  const rows = await extensions().list<GatewayEntitlementData>(gatewayEntitlementModel, {
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: Math.min(take, 200),
  });
  return rows.items.map(toRow);
}

export async function updateEntitlement(
  id: string,
  patch: Partial<GatewayEntitlementData>,
): Promise<EntitlementRow | null> {
  const current = await extensions().get<GatewayEntitlementData>(gatewayEntitlementModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayEntitlementModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

export async function removeEntitlement(id: string): Promise<boolean> {
  const current = await extensions().get<GatewayEntitlementData>(gatewayEntitlementModel, id);
  if (!current) return false;
  await extensions().delete(gatewayEntitlementModel, id);
  return true;
}

/**
 * 原子抵扣一段额度。
 *
 * 通过 `updateWhere` 的**条件**（`usedAmount <= quota - amount`）保证并发下不会
 * 把套餐扣穿：条件不满足时更新 0 行，调用方据此把差额改走钱包。
 * 这也是选择「结算时扣减」而非「预留时冻结」的原因——不需要额外的预留表，
 * 条件更新本身就是原子的。
 */
export async function consumeEntitlement(id: string, amount: number): Promise<boolean> {
  if (!(amount > 0)) return false;
  const current = await extensions().get<GatewayEntitlementData>(gatewayEntitlementModel, id);
  if (!current) return false;
  const quota = current.spec.quotaAmount;
  const where: ExtensionWhere =
    quota > 0
      ? { name: { eq: id }, usedAmount: { lte: Math.max(0, quota - amount) } }
      : { name: { eq: id } };
  const result = await extensions()
    .updateWhere(gatewayEntitlementModel, where, { usedAmount: { inc: amount } })
    .catch(() => ({ updated: 0 }));
  if (result.updated === 0) return false;
  if (quota > 0 && current.spec.usedAmount + amount >= quota) {
    // 只把状态置为已用尽，不再写 `usedAmount`——并发结算下用读到的旧值回写
    // 会覆盖别人的增量（丢失更新）。额度本身就是条件更新的守卫。
    await extensions()
      .updateWhere(gatewayEntitlementModel, { name: { eq: id } }, { status: { set: 'EXHAUSTED' } })
      .catch(() => undefined);
  }
  return true;
}

/** 到期权益置为 EXPIRED（清扫任务用；内核读路径不依赖它）。 */
export async function expireEntitlements(now: Date): Promise<number> {
  const rows = await extensions().listAll<GatewayEntitlementData>(gatewayEntitlementModel, {
    where: { status: { eq: 'ACTIVE' } },
  });
  let count = 0;
  for (const row of rows) {
    const expiresAt = row.spec.expiresAt;
    if (!expiresAt) continue;
    if (Date.parse(expiresAt) > now.getTime()) continue;
    await extensions()
      .update(gatewayEntitlementModel, row.name, {
        ...row.spec,
        status: 'EXPIRED',
      })
      .catch(() => undefined);
    count += 1;
  }
  return count;
}

/* ------------------------------ 模型映射（B4） ------------------------------ */

export type ModelMapRow = Row<GatewayModelMapData>;

export async function listEnabledModelMaps(): Promise<ModelMapRow[]> {
  const rows = await extensions().listAll<GatewayModelMapData>(gatewayModelMapModel, {
    where: { enabled: { eq: true } },
    orderBy: { field: 'priority', desc: true },
  });
  return rows.map(toRow);
}

export async function listModelMaps(): Promise<ModelMapRow[]> {
  const rows = await extensions().listAll<GatewayModelMapData>(gatewayModelMapModel, {
    orderBy: { field: 'priority', desc: true },
  });
  return rows.map(toRow);
}

export async function getModelMap(id: string): Promise<ModelMapRow | null> {
  const instance = await extensions().get<GatewayModelMapData>(gatewayModelMapModel, id);
  return instance ? toRow(instance) : null;
}

export async function createModelMap(spec: GatewayModelMapData): Promise<ModelMapRow> {
  const instance = await extensions().create(gatewayModelMapModel, spec);
  return toRow(instance);
}

export async function updateModelMap(
  id: string,
  patch: Partial<GatewayModelMapData>,
): Promise<ModelMapRow | null> {
  const current = await extensions().get<GatewayModelMapData>(gatewayModelMapModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayModelMapModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

export async function removeModelMap(id: string): Promise<boolean> {
  const current = await extensions().get<GatewayModelMapData>(gatewayModelMapModel, id);
  if (!current) return false;
  await extensions().delete(gatewayModelMapModel, id);
  return true;
}

/* ------------------------------ 预算限额（B3） ------------------------------ */

export type BudgetLimitRow = Row<GatewayBudgetLimitData>;

export async function listBudgetLimits(): Promise<BudgetLimitRow[]> {
  const rows = await extensions().listAll<GatewayBudgetLimitData>(gatewayBudgetLimitModel, {
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toRow);
}

/** 取某用户生效的限额（用户自己的 + 全局默认）。 */
export async function listBudgetLimitsFor(userId: string): Promise<BudgetLimitRow[]> {
  const rows = await extensions().listAll<GatewayBudgetLimitData>(gatewayBudgetLimitModel, {
    where: { enabled: { eq: true }, userId: { in: [userId, ''] } },
  });
  return rows.map(toRow);
}

export async function getBudgetLimit(id: string): Promise<BudgetLimitRow | null> {
  const instance = await extensions().get<GatewayBudgetLimitData>(gatewayBudgetLimitModel, id);
  return instance ? toRow(instance) : null;
}

export async function createBudgetLimit(spec: GatewayBudgetLimitData): Promise<BudgetLimitRow> {
  const instance = await extensions().create(gatewayBudgetLimitModel, spec);
  return toRow(instance);
}

export async function updateBudgetLimit(
  id: string,
  patch: Partial<GatewayBudgetLimitData>,
): Promise<BudgetLimitRow | null> {
  const current = await extensions().get<GatewayBudgetLimitData>(gatewayBudgetLimitModel, id);
  if (!current) return null;
  const instance = await extensions().update(gatewayBudgetLimitModel, id, {
    ...current.spec,
    ...patch,
  });
  return toRow(instance);
}

export async function removeBudgetLimit(id: string): Promise<boolean> {
  const current = await extensions().get<GatewayBudgetLimitData>(gatewayBudgetLimitModel, id);
  if (!current) return false;
  await extensions().delete(gatewayBudgetLimitModel, id);
  return true;
}

/* ------------------------------ 对账单（B5） ------------------------------ */

/**
 * 取某个时间区间的流水。
 *
 * 引擎的 `where` 每个字段只允许一个操作符，所以时间下界走 `gte`、上界在内存里
 * 过滤（月区间最多 31 天，数量可控）。`take` 上界防止极端用户把内存打满。
 */
export async function listLogsBetween(
  since: Date,
  until: Date,
  take = 50_000,
  filter: { userId?: string | undefined } = {},
): Promise<UsageLogRow[]> {
  const where: ExtensionWhere = filter.userId
    ? { userId: { eq: filter.userId }, createdAt: { gte: since as unknown as number } }
    : { createdAt: { gte: since as unknown as number } };
  const rows = await pageTake<GatewayUsageLogData>(gatewayUsageLogModel, {
    where,
    orderBy: { field: 'createdAt', desc: true },
    take,
  });
  const untilMs = until.getTime();
  return rows.filter((row) => row.createdAt.getTime() < untilMs).map(toRow);
}
