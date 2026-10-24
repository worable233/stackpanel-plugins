'use client';

import { FeatureOverview, TicketWorkspace } from '@stackpanel/ui';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { useEffect, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { ticketWorkspaceLabels } from './ticket-workspace-labels.js';
import { t } from './i18n.js';

/**
 * 后台页取数的两条路径。
 *
 * 后台管理页走 M2（浏览器端模块），所以可以自己 `fetch`。这条路径是**默认**的：
 * 本插件不是内核内置包，内核因此不会在 web 进程里执行它的 finders
 * （`serverExecution: 'declarative'`，见 ADR-0024 / 契约 03 §3.1）。若页面只等
 * `props.data`，后台列表会永远是空的。
 *
 * `props.data` 仍然优先——运维若在 `STACKPANEL_FRONTEND_SERVER_EXEC` 里授权了本
 * 插件，内核会预取首屏数据，那样就没有额外的一次往返、也不会闪一下空列表。
 */
const TICKET_BFF_BASE = '/api/plugins';

async function bffGet<T>(path: string): Promise<T> {
  const response = await fetch(`${TICKET_BFF_BASE}${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  userEmail?: string | null;
  assigneeEmail?: string | null;
  category?: string | null;
  departmentId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  reminderCount?: number;
}

interface TicketDetail extends Ticket {
  messages: Array<{
    id: string;
    body: string;
    authorId: string;
    authorEmail?: string | null;
    authorRole?: string | null;
    internal?: boolean;
    createdAt: string;
  }>;
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  viewerId?: string;
}

/** 客户端兜底取数：服务端没给数据（未授权 finder）时自己去拉。 */
function useClientData<T>(initial: T | undefined, load: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);
  useEffect(() => {
    if (initial !== undefined) {
      setValue(initial);
      return;
    }
    let live = true;
    load()
      .then((next) => {
        if (live) setValue(next);
      })
      .catch(() => {
        // 取数失败保持 undefined：页面据此显示「暂无数据」，而不是白屏或假数据。
        if (live) setValue(undefined);
      });
    return () => {
      live = false;
    };
    // `load` 每次渲染都是新函数；依赖 initial 即可（数据缺失是唯一会变化的输入）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  return value;
}

function AdminTicketListPage(props: AdminPageComponentProps): ReactElement {
  const initial = props.data.tickets as Ticket[] | undefined;
  const tickets = useClientData(initial, async () => {
    const result = await bffGet<{ tickets: Ticket[] }>('/ticket/admin/tickets?page=1&pageSize=50');
    return result.tickets;
  });
  return (
    <TicketWorkspace
      mode="list"
      admin
      basePath="/admin/plugin/ticket/tickets"
      tickets={tickets ?? []}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

function AdminTicketDetailPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const id = props.params['id'] ?? '';
  const initialTicket = props.data.ticket as TicketDetail | undefined;
  const initialTickets = props.data.tickets as Ticket[] | undefined;
  const ticket = useClientData(initialTicket, () =>
    bffGet<TicketDetail>(`/ticket/admin/tickets/${encodeURIComponent(id)}`),
  );
  const tickets = useClientData(initialTickets, async () => {
    const result = await bffGet<{ tickets: Ticket[] }>('/ticket/admin/tickets?page=1&pageSize=50');
    return result.tickets;
  });
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
      tickets={tickets ?? []}
      ticket={ticket}
      update={props.actions['ticket.update']}
      reply={props.actions['ticket.reply']}
      extraActions={<AdminAcceptAction props={props} ticket={ticket} />}
      locale={props.locale}
      labels={ticketWorkspaceLabels(props.locale)}
    />
  );
}

/**
 * 「接单」不是独立接口：把它建模成「指派给自己」的一次 PATCH，从而只有一条
 * 写入路径 —— 两套写状态的接口迟早会给出不一致的 assignee/status 组合。
 */
function AdminAcceptAction({
  props,
  ticket,
}: {
  props: AdminPageComponentProps;
  ticket: TicketDetail;
}): ReactElement | null {
  const tr = t(props.locale);
  const update = props.actions['ticket.update'];
  if (!update || ticket.status === 'CLOSED' || ticket.assigneeId === ticket.viewerId) return null;
  return (
    <form action={update}>
      <input type="hidden" name="id" value={ticket.id} />
      <input type="hidden" name="assigneeId" value={ticket.viewerId ?? ''} />
      <button
        type="submit"
        className="h-8 rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground"
      >
        {tr('workspace.accept')}
      </button>
    </form>
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
