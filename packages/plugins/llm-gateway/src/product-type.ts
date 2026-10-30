/**
 * 套餐商品类型（B1）：把「商店里卖的额度包」挂到网关。
 *
 * ## 为什么用商品类型，而不是自己再做一个商城
 *
 * 内核已经有一套完整的交易骨架：商品、订单、支付、退款、服务实例、续费、
 * 到期暂停、我的服务列表。再写一套「额度商城」等于把支付和订单重做一遍，
 * 两套账迟早对不上。这里只实现履约 SPI（`EXTENSION_POINTS.productType`）：
 * 商店负责「卖」，本插件负责「发」，权益落在 `llm-gateway/entitlement`。
 *
 * ## 履约语义
 *
 * - `quotaAmount`：额度（minor）。`0` = 不限量，只受有效期约束；
 * - `validityDays`：有效期天数。商店传了 `expiresAt` 时**以商店为准**——
 *   两套周期算法必然漂移，用户会看到「服务到期了但额度还在」；
 * - `models`：覆盖的对外模型名，空 = 全部；
 * - 续费：商店已把 `newExpiresAt` 推给服务实例，这里**追加一份额度**并把到期
 *   时间对齐（额度包的续费语义是「再来一包」，不是「同一包用更久」）；
 * - 终止（退款/撤销）：权益置 `REVOKED`，已用额度不回滚（已发生的调用有成本）。
 */

import type {
  FulfillmentProvider,
  ProductConfigField,
  ProductTypeProvider,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceActionResult,
  ServiceDetail,
} from '@stackpanel/sdk';
import { z } from 'zod';
import { logger } from './context.js';
import { entitlementStatusOf, remainingOf } from './entitlements.js';
import {
  createEntitlement,
  getEntitlement,
  listUserEntitlements,
  updateEntitlement,
  type EntitlementRow,
} from './repository.js';

/** 商品类型标识：store 按它把订单分派给本插件。 */
export const ENTITLEMENT_FULFILLMENT_TYPE = 'api_token';

const DAY_MS = 24 * 60 * 60 * 1000;

const configSchema = z
  .object({
    /** 额度（minor）；0 = 不限量。 */
    quotaAmount: z.coerce.number().int().min(0).max(2_000_000_000),
    /** 有效期天数；商店给了计费周期时会被覆盖。 */
    validityDays: z.coerce.number().int().min(1).max(3650).optional(),
    /** 覆盖的对外模型名；空 = 全部。 */
    models: z.array(z.string().min(1).max(191)).max(200).optional(),
    /** 展示名（用户「我的服务」里看到的名字）。 */
    label: z.string().max(191).optional(),
  })
  .passthrough();

/** 商品类型配置表单（store 通用渲染，不需要插件前端）。 */
const configFields: ProductConfigField[] = [
  {
    name: 'quotaAmount',
    label: '额度（分）',
    type: 'number',
    required: true,
    help: '本商品可抵扣的总额度，单位为分（与钱包 minor 单位一致）。0 表示不限量，只受有效期约束。',
    min: 0,
  },
  {
    name: 'validityDays',
    label: '有效期（天）',
    type: 'number',
    help: '商品配置了计费周期时以计费周期为准；两者都为空则永久有效。',
    min: 1,
  },
  {
    name: 'models',
    label: '限定模型',
    type: 'tags',
    help: '留空表示覆盖全部模型。填写后只有这些对外模型名能抵扣本套餐。',
  },
  {
    name: 'label',
    label: '展示名',
    type: 'text',
    placeholder: '例如：Claude 月度包',
  },
];

/** 从商品 metadata 读取类型配置（store 用 `configSchema` 校验后写入）。 */
function readConfig(metadata: unknown): z.infer<typeof configSchema> {
  const parsed = configSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw new Error(
      `商品未配置有效额度：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
    );
  }
  return parsed.data;
}

/** 到期时间归一化：`undefined`/非法值视为永久（null）。 */
function normalizeExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * 已有权益（幂等锚点）。
 *
 * store 可能重试履约（网络抖动、进程重启）。同一订单+商品只能发一次：
 * 否则用户点一次「重试」就白拿一份额度。
 */
async function findByOrder(
  userId: string,
  orderId: string,
  productId: string,
): Promise<EntitlementRow | null> {
  const rows = await listUserEntitlements(userId);
  return (
    rows.find(
      (row) => row.orderId === orderId && row.productId === productId && row.status !== 'REVOKED',
    ) ?? null
  );
}

async function provision(ctx: ProvisionContext): Promise<ProvisionResult> {
  const config = readConfig(ctx.product.metadata);
  const existing = await findByOrder(ctx.userId, ctx.orderId, ctx.productId);
  if (existing) {
    return {
      status: 'ACTIVE',
      providerServiceId: existing.id,
      runtime: { entitlementId: existing.id, quotaAmount: existing.quotaAmount },
      message: '该订单的套餐已发放',
    };
  }
  const now = new Date();
  // 商店算了周期就以商店为准：两套算法会漂移。
  const expiresAt =
    normalizeExpiry(ctx.expiresAt) ??
    (config.validityDays
      ? new Date(now.getTime() + config.validityDays * DAY_MS).toISOString()
      : null);
  const row = await createEntitlement({
    userId: ctx.userId,
    name: config.label ?? ctx.product.name,
    source: 'product',
    productId: ctx.productId,
    orderId: ctx.orderId,
    serviceId: ctx.fulfillmentId ?? '',
    quotaAmount: config.quotaAmount,
    usedAmount: 0,
    models: config.models ?? [],
    startsAt: now.toISOString(),
    expiresAt,
    status: 'ACTIVE',
    priority: 0,
  });
  return {
    status: 'ACTIVE',
    providerServiceId: row.id,
    runtime: {
      entitlementId: row.id,
      quotaAmount: row.quotaAmount,
      // 续费时商店不会再传 metadata，额度要能从 runtime 找回。
      models: row.models,
      label: row.name,
    },
    message: row.quotaAmount > 0 ? `已发放 ${row.quotaAmount} 分额度` : '已发放不限量套餐',
  };
}

async function detailOf(service: ProviderServiceContext): Promise<EntitlementRow | null> {
  const id = service.service.providerServiceId;
  if (!id) return null;
  return getEntitlement(id);
}

function toDetail(row: EntitlementRow): ServiceDetail {
  const remaining = remainingOf(row);
  const status = entitlementStatusOf(row);
  return {
    title: row.name || 'API 额度包',
    expiresAt: row.expiresAt ?? null,
    status: status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
    statusLabel:
      status === 'ACTIVE'
        ? '生效中'
        : status === 'EXHAUSTED'
          ? '额度已用完'
          : status === 'EXPIRED'
            ? '已过期'
            : '已撤销',
    fields: [
      {
        label: '总额度（分）',
        value: row.quotaAmount > 0 ? String(row.quotaAmount) : '不限量',
      },
      {
        label: '已抵扣（分）',
        value: String(row.usedAmount),
      },
      {
        label: '剩余（分）',
        value: Number.isFinite(remaining) ? String(remaining) : '不限量',
      },
      {
        label: '覆盖模型',
        value: row.models.length ? row.models.join('、') : '全部模型',
      },
    ],
    actions: [],
  };
}

export const entitlementProductType: ProductTypeProvider = {
  id: 'llm-gateway-entitlement',
  name: '模型额度包',
  label: '模型额度包',
  fulfillmentTypes: [ENTITLEMENT_FULFILLMENT_TYPE],
  configFields,
  configSchema: configSchema as unknown as z.ZodType<Record<string, unknown>>,

  provision,

  async getDetail(service: ProviderServiceContext): Promise<ServiceDetail> {
    const row = await detailOf(service);
    if (!row) {
      return {
        title: service.service.productName ?? 'API 额度包',
        status: 'FAILED',
        statusLabel: '权益记录缺失',
        fields: [],
      };
    }
    return toDetail(row);
  },

  /**
   * 续费：追加额度 + 对齐到期时间。
   *
   * 额度包的续费是「再来一包」，所以 `quotaAmount` 累加而不是重置；已用量保留，
   * 用户不会因为续费而丢掉「已经用掉多少」的连续记录。
   */
  async renew(service: ProviderServiceContext, info): Promise<ServiceActionResult | void> {
    const row = await detailOf(service);
    if (!row) return { message: '权益记录缺失，请联系客服' };
    const runtime = (service.service.runtime ?? {}) as Record<string, unknown>;
    const topUp = Number(runtime['quotaAmount'] ?? row.quotaAmount);
    const nextQuota = row.quotaAmount > 0 && topUp > 0 ? row.quotaAmount + topUp : row.quotaAmount;
    const updated = await updateEntitlement(row.id, {
      quotaAmount: nextQuota,
      expiresAt: info.newExpiresAt,
      // 续费把「已用尽」的包重新激活：额度加了，状态得跟着回来。
      status: 'ACTIVE',
    }).catch((error: unknown) => {
      logger().warn(`llm-gateway: 套餐续费失败：${String(error)}`);
      return null;
    });
    if (!updated) return { message: '套餐续费失败，请联系客服' };
    return {
      message:
        nextQuota > 0
          ? `额度已追加至 ${nextQuota} 分，有效期至 ${info.newExpiresAt.slice(0, 10)}`
          : `有效期已延长至 ${info.newExpiresAt.slice(0, 10)}`,
    };
  },

  /**
   * 到期暂停：额度本身按 `expiresAt` 即时失效（见 `entitlements.isLive`），
   * 这里不改状态——改成 EXPIRED 会让「宽限期内用户还能用」的语义丢失。
   */
  async suspend(): Promise<void> {},

  /** 终止（退款/撤销）：置 REVOKED，已用额度不回滚（调用已产生上游成本）。 */
  async terminate(service: ProviderServiceContext): Promise<void> {
    const row = await detailOf(service);
    if (!row) return;
    await updateEntitlement(row.id, {
      status: 'REVOKED',
      revokedReason: '服务已终止',
    }).catch((error: unknown) => {
      logger().warn(`llm-gateway: 套餐撤销失败：${String(error)}`);
    });
  },
} satisfies FulfillmentProvider & ProductTypeProvider;
