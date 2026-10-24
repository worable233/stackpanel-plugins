import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  AdminWidgetProps,
  FrontendPackage,
  PluginActionDefinition,
} from '@stackpanel/sdk';
import { FeatureOverview, TicketWorkspace } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';

import { ArrowUpRight, Inbox } from 'lucide-react';
import { ticketWorkspaceLabels } from './ticket-workspace-labels.js';
import { messages, t } from './i18n.js';

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
  category?: string | null;
  departmentId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  reminderCount?: number;
  closedBy?: string | null;
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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Status code → catalog key + tone. Codes are API values, not copy. */
const STATUS_META: Record<string, { messageKey: string; cls: string }> = {
  OPEN: {
    messageKey: 'status.OPEN',
    cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  IN_PROGRESS: {
    messageKey: 'status.IN_PROGRESS',
    cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  PENDING_USER: {
    messageKey: 'status.PENDING_USER',
    cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  },
  RESOLVED: {
    messageKey: 'status.RESOLVED',
    cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  CLOSED: { messageKey: 'status.CLOSED', cls: 'bg-muted text-muted-foreground' },
};

function statusMeta(status: string, tr: (key: string) => string) {
  const meta = STATUS_META[status];
  return {
    label: meta ? tr(meta.messageKey) : status,
    cls: meta?.cls ?? 'bg-muted text-muted-foreground',
  };
}

/* ------------------------------------------------------------------ */
/* Account pages                                                       */
/* ------------------------------------------------------------------ */

function TicketAccountListPage(props: AccountPageComponentProps): ReactElement {
  return (
    <TicketWorkspace
      mode="list"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

function TicketNewPage(props: AccountPageComponentProps): ReactElement {
  return (
    <TicketWorkspace
      mode="new"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      create={props.actions['ticket.create']}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

/**
 * 用户侧工单操作：催单 + 关闭。
 *
 * 共享组件只提供挂载点（`extraActions`），业务动词与文案留在插件里 ——
 * 内核的 `@stackpanel/ui` 不应承载某个插件的工单语义。
 */
function TicketUserActions({
  props,
  ticket,
}: {
  props: AccountPageComponentProps;
  ticket: TicketDetail;
}): ReactElement | null {
  const tr = t(props.locale);
  if (ticket.status === 'CLOSED') return null;
  const remind = props.actions['ticket.remind'];
  const close = props.actions['ticket.close'];
  return (
    <>
      {remind ? (
        <form action={remind}>
          <input type="hidden" name="id" value={ticket.id} />
          <button
            type="submit"
            className="h-8 rounded-lg border bg-background px-2.5 text-xs font-medium hover:bg-muted"
          >
            {tr('workspace.remind')}
          </button>
        </form>
      ) : null}
      {close ? (
        <form action={close}>
          <input type="hidden" name="id" value={ticket.id} />
          <button
            type="submit"
            className="h-8 rounded-lg border bg-background px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            {tr('workspace.close')}
          </button>
        </form>
      ) : null}
    </>
  );
}

function TicketAccountDetailPage(props: AccountPageComponentProps): ReactElement {
  const ticket = props.data.ticket as TicketDetail | undefined;
  return (
    <TicketWorkspace
      mode="detail"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      {...(ticket ? { ticket } : {})}
      reply={props.actions['ticket.reply']}
      extraActions={ticket ? <TicketUserActions props={props} ticket={ticket} /> : undefined}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

function TicketAccountWidget(props: AccountWidgetProps): ReactElement {
  const tr = t(props.locale);
  return (
    <Link
      href="/account/tickets"
      className="group block rounded-2xl border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Inbox className="size-5" />
      </span>
      <p className="mt-4 text-sm font-semibold">{tr('accountWidget.title')}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">{tr('accountWidget.description')}</p>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Admin widget                                                        */
/* ------------------------------------------------------------------ */

function TicketAdminWidget(props: AdminWidgetProps): ReactElement {
  const tr = t(props.locale);
  return (
    <Link
      href="/admin/plugin/ticket/tickets"
      className="backend-widget group flex min-h-24 items-center gap-3 p-4 text-card-foreground transition-colors hover:border-primary/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Inbox className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{tr('adminWidget.title')}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {tr('adminWidget.description')}
        </span>
      </span>
      <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Finders                                                             */
/* ------------------------------------------------------------------ */

function SupportOverview(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const summary = props.data.summary as { total: number; tickets: Ticket[] } | undefined;
  return (
    <FeatureOverview
      title={tr('overview.accountTitle')}
      description={tr('overview.accountDescription')}
      unavailable={!summary}
      metrics={[{ label: tr('overview.total'), value: summary?.total ?? '—' }]}
      links={[
        {
          label: tr('overview.myTicketsLink'),
          description: tr('overview.myTicketsLinkDescription'),
          href: '/account/tickets',
        },
      ]}
      activity={{
        title: tr('overview.recent'),
        items: (summary?.tickets ?? []).map((ticket) => ({
          label: ticket.subject,
          detail: statusMeta(ticket.status, tr).label,
          href: `/account/tickets/${ticket.id}`,
        })),
      }}
    />
  );
}

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
      { name: 'category', type: 'string', maxLength: 64 },
      { name: 'relatedType', type: 'string', maxLength: 16 },
      { name: 'relatedId', type: 'string', maxLength: 191 },
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
      // 仅管理员可置 true（后端会拒绝非管理员）：内部备注对用户不可见。
      { name: 'internal', type: 'boolean' },
    ],
  },
  {
    id: 'ticket.close',
    method: 'POST',
    path: '/tickets/:id/close',
    permission: 'ticket.create',
    input: [
      { name: 'id', type: 'string', required: true, maxLength: 191 },
      { name: 'reason', type: 'string', maxLength: 10000 },
    ],
  },
  {
    id: 'ticket.remind',
    method: 'POST',
    path: '/tickets/:id/remind',
    permission: 'ticket.create',
    input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
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
      { name: 'category', type: 'string', maxLength: 64 },
      { name: 'departmentId', type: 'string', maxLength: 191 },
    ],
  },
];

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    actions: ticketActions,
    adminWidgets: { 'ticket-summary': TicketAdminWidget },
    accountRoutes: [
      {
        path: '/support',
        component: 'account/support-overview',
        permission: 'ticket.view',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 0 },
        // Declarative: the host performs the GET itself, so this page renders
        // populated without the package being admitted to server execution.
        data: [{ fetch: { path: '/tickets?page=1&pageSize=5' }, as: 'summary' }],
      },
      {
        path: '/tickets',
        component: 'account/tickets',
        permission: 'ticket.view',
        nav: { labelKey: 'nav.myTickets', groupKey: 'nav.group', order: 10 },
        data: [{ fetch: { path: '/tickets?all=true', select: 'tickets' }, as: 'tickets' }],
      },
      {
        path: '/tickets/new',
        component: 'account/tickets/new',
        permission: 'ticket.create',
        data: [{ fetch: { path: '/tickets?all=true', select: 'tickets' }, as: 'tickets' }],
      },
      {
        path: '/tickets/:id',
        component: 'account/tickets/detail',
        permission: 'ticket.view',
        data: [
          { fetch: { path: '/tickets?all=true', select: 'tickets' }, as: 'tickets' },
          { fetch: { path: '/tickets/:id' }, as: 'ticket' },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'ticket.admin',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 0 },
        data: [{ fetch: { path: '/ticket/admin/tickets?page=1&pageSize=5' }, as: 'summary' }],
      },
      {
        path: '/tickets',
        component: 'admin/tickets',
        permission: 'ticket.admin',
        nav: { labelKey: 'nav.adminTickets', groupKey: 'nav.group', order: 10 },
        data: [
          {
            fetch: { path: '/ticket/admin/tickets?page=1&pageSize=50', select: 'tickets' },
            as: 'tickets',
          },
        ],
      },
      {
        path: '/tickets/:id',
        component: 'admin/tickets/detail',
        permission: 'ticket.admin',
        data: [{ fetch: { path: '/ticket/admin/tickets/:id' }, as: 'ticket' }],
      },
    ],
    accountWidgets: [
      { id: 'tickets', titleKey: 'accountWidget.title', component: 'account/tickets' },
    ],
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
