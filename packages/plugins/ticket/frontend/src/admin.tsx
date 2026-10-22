'use client';

import { FeatureOverview, TicketWorkspace } from '@stackpanel/ui';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { ticketWorkspaceLabels } from './ticket-workspace-labels.js';
import { t } from './i18n.js';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  userEmail?: string | null;
  assigneeEmail?: string | null;
}

interface TicketDetail extends Ticket {
  messages: Array<{
    id: string;
    body: string;
    authorId: string;
    authorEmail?: string | null;
    authorRole?: string | null;
    createdAt: string;
  }>;
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  viewerId?: string;
}

function AdminTicketListPage(props: AdminPageComponentProps): ReactElement {
  return (
    <TicketWorkspace
      mode="list"
      admin
      basePath="/admin/plugin/ticket/tickets"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

function AdminTicketDetailPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const ticket = props.data.ticket as TicketDetail | undefined;
  if (!ticket) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Inbox className="size-6 opacity-50" />
          <p>{tr('admin.notFound')}</p>
          <Link href="/admin/plugin/ticket/tickets" className="text-primary hover:underline">
            {tr('admin.backToList')}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <TicketWorkspace
      mode="detail"
      admin
      basePath="/admin/plugin/ticket/tickets"
      tickets={(props.data.tickets as Ticket[] | undefined) ?? []}
      ticket={ticket}
      update={props.actions['ticket.update']}
      reply={props.actions['ticket.reply']}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

function SupportAdminOverview(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const summary = props.data.summary as { total: number; tickets: Ticket[] } | undefined;
  return (
    <FeatureOverview
      title={tr('overview.adminTitle')}
      description={tr('overview.adminDescription')}
      unavailable={!summary}
      metrics={[{ label: tr('overview.total'), value: summary?.total ?? '—' }]}
      links={[
        {
          label: tr('overview.adminTicketsLink'),
          description: tr('overview.adminTicketsLinkDescription'),
          href: '/admin/plugin/ticket/tickets',
        },
      ]}
      activity={{
        title: tr('overview.recent'),
        items: (summary?.tickets ?? []).map((ticket) => ({
          label: ticket.subject,
          detail: tr(`status.${ticket.status}`),
          href: `/admin/plugin/ticket/tickets/${ticket.id}`,
        })),
      }}
    />
  );
}

export const adminPages = {
  'admin/summary': SupportAdminOverview,
  'admin/tickets': AdminTicketListPage,
  'admin/tickets/detail': AdminTicketDetailPage,
} as const;
