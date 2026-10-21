'use client';

import { FeatureOverview, TicketWorkspace } from '@stackpanel/ui';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';

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
    />
  );
}

function AdminTicketDetailPage(props: AdminPageComponentProps): ReactElement {
  const ticket = props.data.ticket as TicketDetail | undefined;
  if (!ticket) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Inbox className="size-6 opacity-50" />
          <p>找不到这张工单</p>
          <Link href="/admin/plugin/ticket/tickets" className="text-primary hover:underline">
            返回工单列表
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
    />
  );
}

function SupportAdminOverview(props: AdminPageComponentProps): ReactElement {
  const summary = props.data.summary as { total: number; tickets: Ticket[] } | undefined;
  return (
    <FeatureOverview
      title="概览"
      description="查看用户工单与最近处理状态。"
      unavailable={!summary}
      metrics={[{ label: '工单总数', value: summary?.total ?? '—' }]}
      links={[
        {
          label: '工单',
          description: '查看并回复用户提交的问题。',
          href: '/admin/plugin/ticket/tickets',
        },
      ]}
      activity={{
        title: '最近工单',
        items: (summary?.tickets ?? []).map((ticket) => ({
          label: ticket.subject,
          detail: ticket.status,
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
