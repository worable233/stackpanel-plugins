import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/** 工单模型：按用户归属的工单主记录。 */
export const TICKET_KIND = 'ticket/ticket';
export const TICKET_MESSAGE_KIND = 'ticket/message';

/** 工单状态。`PENDING_USER` 是「等用户回话」，与「等客服处理」区分开。 */
export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_USER',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * 仍可继续对话的状态。`CLOSED` 是终态；`RESOLVED` 仍允许用户回话
 * （用户往往在「已解决」后才发现没解决，此时应自动重新打开而不是逼他新建工单）。
 */
export const ACTIVE_STATUSES: readonly TicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_USER',
  'RESOLVED',
];

export const ticketModel = defineModel({
  kind: TICKET_KIND,
  label: '工单',
  schema: z.object({
    userId: z.string(),
    subject: z.string(),
    status: z.enum(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED']).default('OPEN'),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    assigneeId: z.string().nullable().default(null),
    /** 工单分类。空 = 未分类；由用户提交时选择或管理员后置。 */
    category: z.string().nullable().default(null),
    /** 负责部门 id（内核 `department` 概念的对齐点）；空 = 未分配。 */
    departmentId: z.string().nullable().default(null),
    /** 关联业务对象（如订单/服务 id），用于「从订单发起工单」与审计追溯。 */
    relatedId: z.string().nullable().default(null),
    /** 关联对象的类型：`order` / `service` / `product`。与 `relatedId` 成对出现。 */
    relatedType: z.string().nullable().default(null),
    /**
     * 用户催单累计次数。
     *
     * 催单不做成消息（会污染时间线），只累计计数 + 记录最后催单时间，
     * 供列表按「等待时长 + 催单次数」排序与提醒管理员。
     */
    reminderCount: z.number().int().min(0).default(0),
    lastRemindedAtMs: z.number().int().nullable().default(null),
    /** 关闭时间（用户或管理员关闭时写入），用于统计「关闭耗时」。 */
    closedAtMs: z.number().int().nullable().default(null),
    /** 关闭方：`user` / `admin`。区分「用户自己放弃」与「客服结单」。 */
    closedBy: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['priority'], types: { priority: 'string' } },
    { fields: ['assigneeId'], types: { assigneeId: 'string' } },
    { fields: ['category'], types: { category: 'string' } },
    { fields: ['departmentId'], types: { departmentId: 'string' } },
    { fields: ['relatedId'], types: { relatedId: 'string' } },
  ],
});

export const ticketMessageModel = defineModel({
  kind: TICKET_MESSAGE_KIND,
  label: '工单消息',
  schema: z.object({
    ticketId: z.string(),
    authorId: z.string(),
    body: z.string(),
    /** 内部备注：管理员可见、用户不可见。 */
    internal: z.boolean().default(false),
  }),
  indexes: [{ fields: ['ticketId'], types: { ticketId: 'string' } }],
});

/** 工单载荷（与 {@link ticketModel} 的 zod schema 对齐）。 */
export interface TicketData {
  userId: string;
  subject: string;
  status: TicketStatus;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  assigneeId: string | null;
  category: string | null;
  departmentId: string | null;
  relatedId: string | null;
  relatedType: string | null;
  reminderCount: number;
  lastRemindedAtMs: number | null;
  closedAtMs: number | null;
  closedBy: string | null;
}

/** 工单消息载荷（与 {@link ticketMessageModel} 对齐）。 */
export interface TicketMessageData {
  ticketId: string;
  authorId: string;
  body: string;
  internal: boolean;
}
