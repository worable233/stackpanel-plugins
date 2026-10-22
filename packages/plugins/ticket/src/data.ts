import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/** 工单模型：按用户归属的工单主记录。 */
export const TICKET_KIND = 'ticket/ticket';
export const TICKET_MESSAGE_KIND = 'ticket/message';

export const ticketModel = defineModel({
  kind: TICKET_KIND,
  label: '工单',
  schema: z.object({
    userId: z.string(),
    subject: z.string(),
    status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).default('OPEN'),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    assigneeId: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['priority'], types: { priority: 'string' } },
    { fields: ['assigneeId'], types: { assigneeId: 'string' } },
  ],
});

export const ticketMessageModel = defineModel({
  kind: TICKET_MESSAGE_KIND,
  label: '工单消息',
  schema: z.object({
    ticketId: z.string(),
    authorId: z.string(),
    body: z.string(),
  }),
  indexes: [{ fields: ['ticketId'], types: { ticketId: 'string' } }],
});

/** 工单载荷（与 {@link ticketModel} 的 zod schema 对齐）。 */
export interface TicketData {
  userId: string;
  subject: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  assigneeId: string | null;
}

/** 工单消息载荷（与 {@link ticketMessageModel} 对齐）。 */
export interface TicketMessageData {
  ticketId: string;
  authorId: string;
  body: string;
}
