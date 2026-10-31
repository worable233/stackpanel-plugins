import type { ExtensionInstance, HttpReply, HttpRequest, JobContext } from '@stackpanel/sdk';
import {
  EXTENSION_POINTS,
  PluginError,
  WALLET_CURRENCY,
  definePlugin,
  type NotificationTypeDefinition,
} from '@stackpanel/sdk';
import { z } from 'zod';
import { attributeRegistration } from './attribution';
import { createCode, listCodes, updateCode } from './codes';
import { loadConfig, saveConfig } from './config';
import { bindContext, context, resetContext } from './context';
import {
  codeModel,
  configModel,
  recordModel,
  type ReferralCode,
  type ReferralConfig,
  type ReferralRecord,
} from './data';
import { ReferralPluginError } from './errors';
import { awardInviter, clawbackByRefund, qualifyByOrder } from './rewards';

/**
 * 本插件发出的通知类型。
 *
 * 必须显式声明：内核的偏好目录只认已声明的类型，未声明的类型一律「永远投递、
 * 用户无法关闭」。奖励到账这类钱相关通知尤其不能被静默吞掉，也不该绕开用户的
 * 通知偏好设置。
 */
const REFERRAL_NOTIFICATION_TYPES: NotificationTypeDefinition[] = [
  {
    type: 'referral.reward.paid',
    category: 'referral',
    label: '推广奖励已到账',
    description: '推广人或被邀请人收到余额奖励时通知。',
    order: 10,
  },
];

/** 冻结到期扫描的周期：一小时一次足够，冻结以天计。 */
const UNFREEZE_SWEEP_INTERVAL_MS = 3_600_000;
const UNFREEZE_JOB = 'unfreeze-sweep';

/** 单页最多返回的归因记录数。 */

/**
 * 用户端建码/改码的输入。
 *
 * **不接受 `rewardAmount`**，这是有意的：奖励金额是平台级运营策略，由管理员在
 * `/store/admin/referrals/config` 设定。若允许用户自带金额，任何人都能给自己开
 * 一个 1e9 分的推广码，然后自导自演把钱从平台钱包套走。历史记录里的
 * `rewardAmount` 字段仍然保留（老码可能带值），但用户端不能再写它 —— 用
 * `.strict()` 让多传的字段直接 400，而不是被 Zod 默默剥掉、调用方误以为生效了。
 */
const createCodeSchema = z
  .object({
    label: z.string().max(40).optional(),
  })
  .strict();

const updateCodeSchema = z
  .object({
    id: z.string().max(191),
    label: z.string().max(40).optional(),
    state: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const configInputSchema = z.object({
  enabled: z.boolean(),
  trigger: z.enum(['register', 'first_order', 'register_frozen']),
  rewardAmount: z.number().int().min(0).max(2_000_000_000),
  inviteeRewardAmount: z.number().int().min(0).max(2_000_000_000),
  freezeDays: z.number().int().min(0).max(365),
  cookieDays: z.number().int().min(1).max(365),
  maxInvitesPerUser: z.number().int().min(0).max(100_000),
  sameIpLimit: z.number().int().min(0).max(1_000),
  currency: z.string().max(8),
});

const adjustSchema = z.object({
  email: z.string().email().max(191),
  amount: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  note: z.string().min(1).max(191),
});

/**
 * 把插件自己的错误映射成内核可渲染的稳定错误码（ADR-0012）。
 *
 * 内核域错误（WalletError / ExtensionValidationError 等）已经带码，直接放行。
 */
function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof ReferralPluginError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

/** 前端展示用的码视图：不暴露内部实例字段。 */
function toCodeView(code: ExtensionInstance<ReferralCode>, config: ReferralConfig) {
  const reward = code.spec.rewardAmount ?? config.rewardAmount;
  return {
    id: code.name,
    code: code.spec.code,
    label: code.spec.label,
    state: code.spec.state,
    rewardAmount: reward,
    signupCount: code.spec.signupCount,
    createdAt: code.createdAt,
  };
}

function toRecordView(record: ExtensionInstance<ReferralRecord>) {
  return {
    id: record.name,
    code: record.spec.code,
    inviterId: record.spec.inviterId,
    inviteeId: record.spec.inviteeId,
    inviteeEmail: record.spec.inviteeEmail,
    trigger: record.spec.trigger,
    inviterState: record.spec.inviterState,
    inviteeState: record.spec.inviteeState,
    rewardAmount: record.spec.rewardAmount,
    inviteeRewardAmount: record.spec.inviteeRewardAmount,
    createdAt: record.createdAt,
    paidAt: record.spec.paidAt,
  };
}

/** 我的推广：码列表 + 归因统计 + 我的奖励。 */
const getMine = async (req: HttpRequest): Promise<unknown> => {
  const userId = req.user?.id ?? '';
  const config = await loadConfig();
  const extensions = context().extensions;
  const [codes, invited, accounts] = await Promise.all([
    listCodes(userId),
    extensions.list<ReferralRecord>(recordModel, {
      where: { inviterId: { eq: userId } },
      orderBy: { field: 'createdAt', desc: true },
      page: 1,
      pageSize: 50,
    }),
    context().wallet.getAccount(userId),
  ]);
  const paid = invited.items.filter((item) => item.spec.inviterState === 'paid');
  return {
    config: {
      enabled: config.enabled,
      trigger: config.trigger,
      rewardAmount: config.rewardAmount,
      inviteeRewardAmount: config.inviteeRewardAmount,
      cookieDays: config.cookieDays,
      currency: config.currency,
    },
    codes: codes.map((code) => toCodeView(code, config)),
    invites: invited.items.map(toRecordView),
    stats: {
      totalInvites: invited.total,
      paidInvites: paid.length,
      earnedAmount: paid.reduce((sum, item) => sum + item.spec.rewardAmount, 0),
      balance: accounts?.balance ?? 0,
    },
  };
};

const postCode = async (req: HttpRequest): Promise<unknown> => {
  const parsed = createCodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ReferralPluginError(400, '无效的参数');
  const ownerId = req.user?.id ?? '';
  const config = await loadConfig();
  const created = await createCode(ownerId, {
    ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
  });
  return { code: toCodeView(created, config) };
};

const patchCode = async (req: HttpRequest): Promise<unknown> => {
  const parsed = updateCodeSchema.safeParse({ ...(req.body ?? {}), id: req.params?.id });
  if (!parsed.success) throw new ReferralPluginError(400, '无效的参数');
  const { id } = parsed.data;
  const ownerId = req.user?.id ?? '';
  const config = await loadConfig();
  const updated = await updateCode(ownerId, id, {
    ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
    ...(parsed.data.state === undefined ? {} : { state: parsed.data.state }),
  });
  return { code: toCodeView(updated, config) };
};

/** 管理端：归因记录列表 + 推广人汇总。 */
const listAdminRecords = async (req: HttpRequest): Promise<unknown> => {
  const extensions = context().extensions;
  const config = await loadConfig();
  const page = Math.max(1, Number(req.query?.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize) || 20));
  const { items, total } = await extensions.list<ReferralRecord>(recordModel, {
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  const paidByInviter = new Map<string, number>();
  for (const item of items) {
    if (item.spec.inviterState !== 'paid') continue;
    paidByInviter.set(
      item.spec.inviterId,
      (paidByInviter.get(item.spec.inviterId) ?? 0) + item.spec.rewardAmount,
    );
  }
  const inviterIds = [...new Set(items.map((item) => item.spec.inviterId))];
  const users = inviterIds.length ? await context().auth.listUsersByIds(inviterIds) : [];
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  return {
    total,
    page,
    pageSize,
    records: items.map((item) => ({
      ...toRecordView(item),
      inviterEmail: emailById.get(item.spec.inviterId) ?? '',
    })),
    inviters: [...paidByInviter.entries()].map(([inviterId, amount]) => ({
      inviterId,
      inviterEmail: emailById.get(inviterId) ?? '',
      paidAmount: amount,
    })),
    currency: config.currency,
  };
};

const getAdminConfig = async (): Promise<unknown> => ({ config: await loadConfig() });

const putAdminConfig = async (req: HttpRequest): Promise<unknown> => {
  const parsed = configInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ReferralPluginError(400, '无效的配置');
  // Rewards are credited to the wallet, which only holds CNY today, and the
  // currency must come from the kernel catalog rather than free text.
  let currency: string;
  try {
    currency = (await context().currency.requireEnabled(parsed.data.currency)).code;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new ReferralPluginError(400, '不支持的币种');
  }
  if (currency !== WALLET_CURRENCY) {
    throw new ReferralPluginError(400, `推广奖励只能使用 ${WALLET_CURRENCY} 结算`);
  }
  return {
    config: await saveConfig({ ...(parsed.data as ReferralConfig), currency }),
  };
};

/** 管理员手动调账兜底（奖励漏发 / 误发时人工修正）。 */
const postAdjustment = async (req: HttpRequest): Promise<unknown> => {
  const parsed = adjustSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ReferralPluginError(400, '无效的参数');
  const input = parsed.data;
  const user = await context().auth.getUserByEmail(input.email);
  if (!user) throw new ReferralPluginError(404, '用户不存在');
  const config = await loadConfig();
  await context().wallet.adjust({
    userId: user.id,
    amount: input.amount,
    currency: config.currency,
    note: input.note,
    ...(req.user?.id ? { actorId: req.user.id } : {}),
  });
  return { ok: true };
};

/**
 * 首单归因：被邀请人第一次支付成功时，把 pending 记录推进为合格并给推广人发奖。
 *
 * 只认 `trigger === 'first_order'` 的记录；其它档位的记录在注册时就已决定走向。
 */
async function onOrderPaid(payload: unknown): Promise<void> {
  const event = payload as { orderId?: string; userId?: string } | null;
  if (!event?.orderId || !event.userId) return;
  try {
    const extensions = context().extensions;
    const record = await extensions.get<ReferralRecord>(recordModel, event.userId);
    if (!record || record.spec.trigger !== 'first_order') return;
    if (record.spec.inviterState !== 'pending') return;
    const config = await loadConfig();
    if (!config.enabled) return;
    const { items } = await extensions.list<ReferralCode>(codeModel, {
      where: { code: { eq: record.spec.code } },
      page: 1,
      pageSize: 1,
    });
    await qualifyByOrder(record, event.orderId, items[0]?.spec ?? null, config);
  } catch (error) {
    // 事件订阅者的 Promise 不被内核 await，异常必须就地吞掉。
    context().logger.error(`referral: 首单发奖失败 ${String(error)}`);
  }
}

/**
 * 整单退款后追回推广奖励。
 *
 * 只处理 `full === true`：部分退款按比例扣佣金会把规则变成无法解释的算术，
 * 而且与「注册奖励是注册的对价」这一判断冲突。`full` 由 store 的
 * `order.refunded` 载荷提供（本次同时补上了该字段）。
 *
 * 追回失败（用户已把钱花掉）**不抛出**：退款是商店对用户的承诺，不能因为
 * 平台与推广人之间的账而失败；记录会标成 `clawed_back` 且金额为实际扣到的数，
 * 供后台人工补扣。
 */
async function onOrderRefunded(payload: unknown): Promise<void> {
  const event = payload as { orderId?: string; userId?: string; full?: boolean } | null;
  if (!event?.orderId || !event.userId) return;
  if (event.full !== true) return;
  try {
    const extensions = context().extensions;
    // 归因记录以被邀请人 userId 为实例名（见 attribution.ts）。
    const record = await extensions.get<ReferralRecord>(recordModel, event.userId);
    if (!record) return;
    if (record.spec.qualifiedOrderId !== event.orderId) return;
    const config = await loadConfig();
    const result = await clawbackByRefund({
      record,
      orderId: event.orderId,
      currency: config.currency,
    });
    context().logger.info(
      `referral: 退款追回 ${record.name}（订单 ${event.orderId}）→ ${result.inviter}`,
    );
  } catch (error) {
    // 事件订阅者的 Promise 不被内核 await，异常必须就地吞掉。
    context().logger.error(`referral: 退款追回失败 ${String(error)}`);
  }
}

/**
 * 冻结档位解冻：扫描冻结到期仍 pending 的记录，逐条发奖。
 *
 * 逐条 try/catch：一条记录失败不能拖垮整轮扫描。
 */
async function unfreezeSweep(): Promise<void> {
  const extensions = context().extensions;
  const now = Date.now();
  const config = await loadConfig();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await extensions.page<ReferralRecord>(recordModel, {
      where: { inviterState: { eq: 'pending' }, freezeUntil: { lte: now } },
      orderBy: { field: 'freezeUntil', desc: false },
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of result.items) {
      if (record.spec.freezeUntil <= 0) continue;
      try {
        const { items } = await extensions.list<ReferralCode>(codeModel, {
          where: { code: { eq: record.spec.code } },
          page: 1,
          pageSize: 1,
        });
        await awardInviter(record, items[0]?.spec ?? null, config);
      } catch (error) {
        context().logger.error(`referral: 解冻发奖失败 ${record.name} ${String(error)}`);
      }
    }
    if (!result.hasMore) break;
    const last = result.items.at(-1);
    if (!last) break;
    cursor = last.name;
  }
}

function startUnfreezeSchedule(jobs: JobContext): void {
  jobs.handle(UNFREEZE_JOB, () => unfreezeSweep());
  void jobs.schedule(UNFREEZE_JOB, { everyMs: UNFREEZE_SWEEP_INTERVAL_MS }).catch(() => undefined);
}

export const referralPlugin = definePlugin({
  manifest: {
    id: 'referral',
    name: '推广插件',
    version: '0.1.0',
    description: '用户推广码、注册归因与余额奖励。',
    requires: [{ id: 'store', range: '^0.3.0' }],
    permissions: [
      {
        key: 'store.referral',
        name: '推广中心',
        description: '创建推广码、查看自己的邀请与奖励。',
      },
      // store.admin 由商店插件声明并附带说明；此处仅引用以免覆盖其说明。
      'store.admin',
    ],
    roleTemplates: [
      { role: 'USER', permissions: ['store.referral'] },
      { role: 'ADMIN', permissions: ['store.admin'] },
    ],
    // Open-platform surface: every entry mirrors one internal route below and
    // dispatches to the *same* handler, so the alias never widens auth.
    capabilities: [
      {
        id: 'referral.me.read',
        method: 'GET',
        route: '/referral/me',
        path: '/api/v1/referral/me',
        summary: "The caller's referral summary",
      },
      {
        id: 'referral.codes.create',
        method: 'POST',
        route: '/referral/codes',
        path: '/api/v1/referral/codes',
        summary: 'Create a referral code for the caller',
        mutating: true,
        destructive: false,
      },
      {
        id: 'referral.codes.update',
        method: 'PATCH',
        route: '/referral/codes/:id',
        path: '/api/v1/referral/codes/:id',
        summary: "Update one of the caller's referral codes; params: {id}",
        mutating: true,
        destructive: false,
      },
      {
        id: 'referral.admin.records.list',
        method: 'GET',
        route: '/store/admin/referrals',
        path: '/api/v1/store/admin/referrals',
        summary: 'List referral records across users',
        scope: 'store.admin',
      },
      {
        id: 'referral.admin.config.read',
        method: 'GET',
        route: '/store/admin/referrals/config',
        path: '/api/v1/store/admin/referrals/config',
        summary: 'Read the referral program configuration',
        scope: 'store.admin',
      },
      {
        id: 'referral.admin.config.write',
        method: 'POST',
        route: '/store/admin/referrals/config',
        path: '/api/v1/store/admin/referrals/config',
        summary: 'Update the referral program configuration',
        scope: 'store.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'referral.admin.adjustments.create',
        method: 'POST',
        route: '/store/admin/referrals/adjustments',
        path: '/api/v1/store/admin/referrals/adjustments',
        summary: 'Apply a manual referral adjustment. Moves reward balances.',
        scope: 'store.admin',
        mutating: true,
        destructive: true,
      },
    ],
  },
  customModels: [codeModel, recordModel, configModel],
  eventListeners: [
    {
      topic: 'user.registered',
      handler: (payload) => {
        const event = payload as {
          userId?: string;
          email?: string;
          affid?: string | null;
          ip?: string | null;
        } | null;
        if (!event?.userId) return;
        void loadConfig()
          .then((config) =>
            attributeRegistration({
              userId: event.userId!,
              email: event.email ?? '',
              affid: event.affid ?? null,
              ip: event.ip ?? null,
              config,
            }),
          )
          .catch((error: unknown) => {
            context().logger.error(`referral: 归因入口失败 ${String(error)}`);
          });
      },
    },
    {
      topic: 'order.paid',
      handler: (payload) => {
        void onOrderPaid(payload);
      },
    },
    {
      topic: 'order.refunded',
      handler: (payload) => {
        void onOrderRefunded(payload);
      },
    },
  ],
  routes: [
    {
      method: 'GET',
      path: '/referral/me',
      auth: 'user',
      permission: 'store.referral',
      handler: handle(getMine),
    },
    {
      method: 'POST',
      path: '/referral/codes',
      auth: 'user',
      permission: 'store.referral',
      handler: handle(postCode),
    },
    {
      method: 'PATCH',
      path: '/referral/codes/:id',
      auth: 'user',
      permission: 'store.referral',
      handler: handle(patchCode),
    },
    {
      method: 'GET',
      path: '/store/admin/referrals',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminRecords),
    },
    {
      method: 'GET',
      path: '/store/admin/referrals/config',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(getAdminConfig),
    },
    {
      method: 'POST',
      path: '/store/admin/referrals/config',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(putAdminConfig),
    },
    {
      method: 'POST',
      path: '/store/admin/referrals/adjustments',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(postAdjustment),
    },
  ],
  onActivate: (ctx) => {
    bindContext(ctx);
    for (const definition of REFERRAL_NOTIFICATION_TYPES) {
      ctx.registerExtension(EXTENSION_POINTS.notificationType, definition);
    }
    startUnfreezeSchedule(ctx.jobs);
    ctx.logger.info('referral: activated');
  },
  onDeactivate: (ctx) => {
    resetContext();
    ctx.logger.info('referral: deactivated');
  },
});

export default referralPlugin;
