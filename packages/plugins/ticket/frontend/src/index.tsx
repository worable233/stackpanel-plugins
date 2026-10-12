import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  AdminWidgetProps,
  FinderContext,
  FrontendPackage,
  PluginActionDefinition,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { z } from 'zod';

import { ArrowLeft, Inbox, Plus, Send, UserRound } from 'lucide-react';

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
  OPEN: { label: '待处理', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  IN_PROGRESS: { label: '处理中', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  RESOLVED: { label: '已解决', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  CLOSED: { label: '已关闭', cls: 'bg-muted text-muted-foreground' },
};

const PRIORITY_META: Record<string, { label: string; cls: string }> = {
  LOW: { label: '低', cls: 'bg-muted text-muted-foreground' },
  NORMAL: { label: '普通', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  HIGH: { label: '高', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
  URGENT: { label: '紧急', cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' };
}

function priorityMeta(priority: string) {
  return PRIORITY_META[priority] ?? { label: priority, cls: 'bg-muted text-muted-foreground' };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Badge({ meta }: { meta: { label: string; cls: string } }): ReactElement {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}

function Empty({ text }: { text: string }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Inbox className="size-5" />
      </span>
      <p className="mt-4 text-sm font-medium">{text}</p>
    </div>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required = false,
  defaultValue,
  placeholder,
  as = 'input',
  options,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  as?: 'input' | 'textarea' | 'select';
  options?: Array<{ value: string; label: string }>;
}): ReactElement {
  const base =
    'w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60';
  const selectOptions = options ?? [
    { value: 'LOW', label: '低' },
    { value: 'NORMAL', label: '普通' },
    { value: 'HIGH', label: '高' },
    { value: 'URGENT', label: '紧急' },
  ];
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </span>
      {as === 'textarea' ? (
        <textarea
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          rows={4}
          className={`${base} resize-y`}
        />
      ) : as === 'select' ? (
        <select
          name={name}
          defaultValue={defaultValue}
          required={required}
          className={`${base} h-10`}
        >
          {selectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          type={type}
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          className={`${base} h-10`}
        />
      )}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Account pages                                                       */
/* ------------------------------------------------------------------ */

function TicketAccountListPage(props: AccountPageComponentProps): ReactElement {
  const tickets = (props.data.tickets as Ticket[] | undefined) ?? [];
  return (
    <main className="space-y-6">
      <PageHeader
        title="我的工单"
        description="查看你提交给服务团队的请求。"
        actions={
          <Link
            href="/account/tickets/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            <Plus className="size-4" />
            提交工单
          </Link>
        }
      />
      {tickets.length > 0 ? (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/account/tickets/${ticket.id}`}
                className="grid gap-2 px-5 py-4 text-sm transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-6"
              >
                <span className="truncate font-medium">{ticket.subject}</span>
                <span className="flex items-center gap-2">
                  <Badge meta={statusMeta(ticket.status)} />
                  <Badge meta={priorityMeta(ticket.priority)} />
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {formatDate(ticket.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty text="还没有工单" />
      )}
    </main>
  );
}

function TicketNewPage(props: AccountPageComponentProps): ReactElement {
  const create = props.actions['ticket.create'];
  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/account/tickets"
            className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回我的工单
          </Link>
        }
        title="提交工单"
        description="告诉我们你遇到的问题，我们会尽快处理。"
      />
      {create ? (
        <form
          action={create}
          className="grid max-w-xl gap-4 rounded-2xl border bg-card p-6 shadow-sm"
        >
          <Field label="主题" name="subject" required placeholder="简要描述问题" />
          <Field
            label="问题描述"
            name="body"
            required
            as="textarea"
            placeholder="详细描述你遇到的问题"
          />
          <button
            type="submit"
            className="inline-flex h-10 w-fit items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            <Send className="size-4" />
            提交工单
          </button>
        </form>
      ) : null}
    </main>
  );
}

function TicketAccountDetailPage(props: AccountPageComponentProps): ReactElement {
  const ticket = props.data.ticket as TicketDetail | undefined;
  const reply = props.actions['ticket.reply'];
  if (!ticket) {
    return (
      <main>
        <PageHeader title="工单详情" description="找不到这张工单。" />
      </main>
    );
  }
  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/account/tickets"
            className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回我的工单
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {ticket.subject}
            <Badge meta={statusMeta(ticket.status)} />
            <Badge meta={priorityMeta(ticket.priority)} />
          </span>
        }
        description={`创建于 ${formatDate(ticket.createdAt)}`}
      />
      <div className="space-y-3">
        {ticket.messages.map((message) => (
          <div key={message.id} className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                <UserRound className="size-3" />
              </span>
              <span className="font-medium text-card-foreground">
                {message.authorId === ticket.viewerId
                  ? '我'
                  : message.authorRole === 'ADMIN'
                    ? '客服'
                    : (message.authorEmail ?? '用户')}
              </span>
              <span className="tabular-nums">{formatDate(message.createdAt)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{message.body}</p>
          </div>
        ))}
      </div>
      {reply ? (
        <form
          action={reply}
          className="mt-6 grid max-w-xl gap-3 rounded-2xl border bg-card p-4 shadow-sm"
        >
          <input type="hidden" name="id" value={ticket.id} />
          <Field label="回复" name="body" required as="textarea" placeholder="输入你的回复…" />
          <button
            type="submit"
            className="inline-flex h-9 w-fit items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            <Send className="size-4" />
            发送
          </button>
        </form>
      ) : null}
    </main>
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
    <section className="rounded-2xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">最近工单</h2>
        <Link href="/admin/plugin/ticket/tickets" className="text-xs text-primary hover:underline">
          查看全部
        </Link>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">打开工单管理页面跟进处理。</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Finders                                                             */
/* ------------------------------------------------------------------ */

const ticketFinders = {
  'ticket.myTickets': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) => {
      const result = await ctx.api.get('/tickets?page=1&pageSize=50', ticketListSchema);
      return result.tickets;
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
    input: [
      { name: 'subject', type: 'string', required: true, maxLength: 191 },
      { name: 'body', type: 'string', required: true, maxLength: 191 },
    ],
  },
  {
    id: 'ticket.reply',
    method: 'POST',
    path: '/tickets/:id/messages',
    permission: 'ticket.create',
    input: [
      { name: 'id', type: 'string', required: true, maxLength: 191 },
      { name: 'body', type: 'string', required: true, maxLength: 191 },
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
        path: '/tickets',
        component: 'account/tickets',
        permission: 'ticket.view',
        nav: { label: '我的工单', group: '服务' },
        data: [{ finder: 'ticket.myTickets', as: 'tickets' }],
      },
      {
        path: '/tickets/new',
        component: 'account/tickets/new',
        permission: 'ticket.create',
        data: [],
      },
      {
        path: '/tickets/:id',
        component: 'account/tickets/detail',
        permission: 'ticket.view',
        data: [{ finder: 'ticket.ticket', as: 'ticket', input: { id: ':id' } }],
      },
    ],
    adminRoutes: [
      {
        path: '/tickets',
        component: 'admin/tickets',
        permission: 'ticket.admin',
        nav: { label: '工单管理', group: '商店插件' },
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
      'account/tickets': TicketAccountListPage,
      'account/tickets/new': TicketNewPage,
      'account/tickets/detail': TicketAccountDetailPage,
    },
    accountWidgetComponents: { 'account/tickets': TicketAccountWidget },
  },
};

export default frontend;
