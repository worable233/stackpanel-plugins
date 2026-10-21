import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  AdminWidgetProps,
  FinderContext,
  FrontendPackage,
  PluginActionDefinition,
} from '@stackpanel/sdk';
import { FeatureOverview, TicketWorkspace } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { z } from 'zod';

import { ArrowUpRight, Inbox } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Types & schemas                                                     */
/* ------------------------------------------------------------------ */

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  userEmail?: string | null;
}

interface TicketMessage {
  id: string;
  body: string;
  authorId: string;
  authorEmail?: string | null;
  authorRole?: string | null;
  createdAt: string;
}

interface TicketDetail extends Ticket {
  messages: TicketMessage[];
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  viewerId?: string;
}

const ticketListItemSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.string(),
  priority: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  userEmail: z.string().nullable().optional(),
  assigneeEmail: z.string().nullable().optional(),
});

const ticketListSchema = z.object({
  tickets: z.array(ticketListItemSchema),
  total: z.number(),
});

const ticketDetailSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.string(),
  priority: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  userEmail: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  assigneeEmail: z.string().nullable().optional(),
  viewerId: z.string().nullable().optional(),
  messages: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      authorId: z.string(),
      authorEmail: z.string().nullable().optional(),
      authorRole: z.string().nullable().optional(),
      createdAt: z.string(),
    }),
  ),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const STATUS_META: Record<string, { label: string; cls: string }> = {
  OPEN: {
    label: '待处理',
    cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  IN_PROGRESS: {
    label: '处理中',
    cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  RESOLVED: {
    label: '已解决',
    cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  CLOSED: { label: '已关闭', cls: 'bg-muted text-muted-foreground' },
};

function statusMeta(status: string) {
  return (
    STATUS_META[status] ?? {
      label: status,
      cls: 'bg-muted text-muted-foreground',
    }
  );
}

/* ------------------------------------------------------------------ */
/* Account pages                                                       */
/* ------------------------------------------------------------------ */

function TicketAccountListPage(props: AccountPageComponentProps): ReactElement {
  return (
    <TicketWorkspace mode="list" tickets={(props.data.tickets as Ticket[] | undefined) ?? []} />
  );
}

function TicketNewPage(props: AccountPageComponentProps): ReactElement {
  return (
    <TicketWorkspace
      mode="new"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      create={props.actions['ticket.create']}
    />
  );
}

function TicketAccountDetailPage(props: AccountPageComponentProps): ReactElement {
  return (
    <TicketWorkspace
      mode="detail"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      ticket={props.data.ticket as TicketDetail | undefined}
      reply={props.actions['ticket.reply']}
    />
  );
}

function TicketAccountWidget(_props: AccountWidgetProps): ReactElement {
  return (
    <Link
      href="/account/tickets"
      className="group block rounded-2xl border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Inbox className="size-5" />
      </span>
      <p className="mt-4 text-sm font-semibold">服务工单</p>
      <p className="mt-1.5 text-sm text-muted-foreground">查看已提交的服务请求。</p>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Admin widget                                                        */
/* ------------------------------------------------------------------ */

function TicketAdminWidget(_props: AdminWidgetProps): ReactElement {
  return (
    <Link
      href="/admin/plugin/ticket/tickets"
      className="backend-widget group flex min-h-24 items-center gap-3 p-4 text-card-foreground transition-colors hover:border-primary/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Inbox className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">工单管理</span>
        <span className="mt-1 block text-xs text-muted-foreground">查看并跟进服务请求</span>
      </span>
      <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Finders                                                             */
/* ------------------------------------------------------------------ */

function SupportOverview(props: AccountPageComponentProps): ReactElement {
  const summary = props.data.summary as { total: number; tickets: Ticket[] } | undefined;
  return (
    <FeatureOverview
      title="概览"
      description="查看你的工单与最近处理状态。"
      unavailable={!summary}
      metrics={[{ label: '工单总数', value: summary?.total ?? '—' }]}
      links={[
        {
          label: '我的工单',
          description: '查看回复和处理进度。',
          href: '/account/tickets',
        },
      ]}
      activity={{
        title: '最近工单',
        items: (summary?.tickets ?? []).map((ticket) => ({
          label: ticket.subject,
          detail: statusMeta(ticket.status).label,
          href: `/account/tickets/${ticket.id}`,
        })),
      }}
    />
  );
}

const ticketFinders = {
  'ticket.adminSummary': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
      ctx.api.get('/ticket/admin/tickets?page=1&pageSize=5', ticketListSchema),
  },
  'ticket.pendingCount': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) => {
      let count = 0;
      let page = 1;
      let fetched = 0;
      while (true) {
        const result = await ctx.api.get(`/tickets?page=${page}&pageSize=100`, ticketListSchema);
        count += result.tickets.filter(
          (ticket) => ticket.status === 'OPEN' || ticket.status === 'IN_PROGRESS',
        ).length;
        fetched += result.tickets.length;
        if (fetched >= result.total || result.tickets.length === 0) break;
        page += 1;
      }
      return { count };
    },
  },
  'ticket.mySummary': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
      ctx.api.get('/tickets?page=1&pageSize=5', ticketListSchema),
  },
  'ticket.myTickets': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) => {
      const tickets: z.infer<typeof ticketListItemSchema>[] = [];
      let page = 1;
      while (true) {
        const result = await ctx.api.get(`/tickets?page=${page}&pageSize=100`, ticketListSchema);
        tickets.push(...result.tickets);
        if (tickets.length >= result.total || result.tickets.length === 0) return tickets;
        page += 1;
      }
    },
  },
  'ticket.ticket': {
    handler: async (input: Record<string, unknown>, ctx: FinderContext) => {
      const id = typeof input.id === 'string' ? input.id : '';
      return ctx.api.get(`/tickets/${encodeURIComponent(id)}`, ticketDetailSchema);
    },
  },
  'ticket.adminTickets': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) => {
      const result = await ctx.api.get(
        '/ticket/admin/tickets?page=1&pageSize=50',
        ticketListSchema,
      );
      return result.tickets;
    },
  },
  'ticket.adminTicket': {
    handler: async (input: Record<string, unknown>, ctx: FinderContext) => {
      const id = typeof input.id === 'string' ? input.id : '';
      return ctx.api.get(`/ticket/admin/tickets/${encodeURIComponent(id)}`, ticketDetailSchema);
    },
  },
};

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const ticketActions: PluginActionDefinition[] = [
  {
    id: 'ticket.create',
    method: 'POST',
    path: '/tickets',
    permission: 'ticket.create',
    redirect: { responsePath: 'redirectUrl' },
    input: [
      { name: 'subject', type: 'string', required: true, maxLength: 191 },
      { name: 'body', type: 'string', required: true, maxLength: 10000 },
    ],
  },
  {
    id: 'ticket.reply',
    method: 'POST',
    path: '/tickets/:id/messages',
    permission: 'ticket.create',
    input: [
      { name: 'id', type: 'string', required: true, maxLength: 191 },
      { name: 'body', type: 'string', required: true, maxLength: 10000 },
    ],
  },
  {
    id: 'ticket.update',
    method: 'PATCH',
    path: '/ticket/admin/tickets/:id',
    permission: 'ticket.admin',
    input: [
      { name: 'id', type: 'string', required: true, maxLength: 191 },
      { name: 'status', type: 'string', maxLength: 32 },
      { name: 'priority', type: 'string', maxLength: 32 },
      { name: 'assigneeId', type: 'string', maxLength: 191 },
    ],
  },
];

export const frontend: FrontendPackage = {
  finders: ticketFinders,
  ui: {
    actions: ticketActions,
    adminWidgets: { 'ticket-summary': TicketAdminWidget },
    accountRoutes: [
      {
        path: '/support',
        component: 'account/support-overview',
        permission: 'ticket.view',
        nav: { label: '概览', group: '支持', order: 0 },
        data: [{ finder: 'ticket.mySummary', as: 'summary' }],
      },
      {
        path: '/tickets',
        component: 'account/tickets',
        permission: 'ticket.view',
        nav: { label: '我的工单', group: '支持', order: 10 },
        data: [{ finder: 'ticket.myTickets', as: 'tickets' }],
      },
      {
        path: '/tickets/new',
        component: 'account/tickets/new',
        permission: 'ticket.create',
        data: [{ finder: 'ticket.myTickets', as: 'tickets' }],
      },
      {
        path: '/tickets/:id',
        component: 'account/tickets/detail',
        permission: 'ticket.view',
        data: [
          { finder: 'ticket.myTickets', as: 'tickets' },
          { finder: 'ticket.ticket', as: 'ticket', input: { id: ':id' } },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'ticket.admin',
        nav: { label: '概览', group: '支持', order: 0 },
        data: [{ finder: 'ticket.adminSummary', as: 'summary' }],
      },
      {
        path: '/tickets',
        component: 'admin/tickets',
        permission: 'ticket.admin',
        nav: { label: '工单', group: '支持', order: 10 },
        data: [{ finder: 'ticket.adminTickets', as: 'tickets' }],
      },
      {
        path: '/tickets/:id',
        component: 'admin/tickets/detail',
        permission: 'ticket.admin',
        data: [{ finder: 'ticket.adminTicket', as: 'ticket', input: { id: ':id' } }],
      },
    ],
    accountWidgets: [{ id: 'tickets', title: '服务工单', component: 'account/tickets' }],
    accountPages: {
      'account/support-overview': SupportOverview,
      'account/tickets': TicketAccountListPage,
      'account/tickets/new': TicketNewPage,
      'account/tickets/detail': TicketAccountDetailPage,
    },
    accountWidgetComponents: { 'account/tickets': TicketAccountWidget },
  },
};

export default frontend;
