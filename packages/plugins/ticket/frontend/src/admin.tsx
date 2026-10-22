'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Inbox, Send, UserRound } from 'lucide-react';

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
  required = false,
  defaultValue,
  placeholder,
  as = 'input',
  options,
}: {
  label: string;
  name: string;
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
          type="text"
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          className={`${base} h-10`}
        />
      )}
    </label>
  );
}

function TicketAdminListPage(props: AdminPageComponentProps): ReactElement {
  const tickets = (props.data.tickets as Ticket[] | undefined) ?? [];
  return (
    <main className="w-full space-y-6">
      <PageHeader title="工单管理" description="查看用户提交的工单并跟进处理。" />
      {tickets.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">主题</th>
                <th className="px-4 py-2.5 font-medium">提交人</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">优先级</th>
                <th className="px-4 py-2.5 text-right font-medium">提交时间</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/plugin/ticket/tickets/${ticket.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {ticket.subject}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{ticket.userEmail ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge meta={statusMeta(ticket.status)} />
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge meta={priorityMeta(ticket.priority)} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                    {formatDate(ticket.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="还没有工单" />
      )}
    </main>
  );
}

function TicketAdminDetailPage(props: AdminPageComponentProps): ReactElement {
  const ticket = props.data.ticket as TicketDetail | undefined;
  const update = props.actions['ticket.update'];
  const reply = props.actions['ticket.reply'];
  if (!ticket) {
    return (
      <main className="w-full">
        <p className="text-sm text-muted-foreground">找不到这张工单。</p>
      </main>
    );
  }
  return (
    <main className="w-full space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/admin/plugin/ticket/tickets"
            className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回工单列表
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {ticket.subject}
            <Badge meta={statusMeta(ticket.status)} />
            <Badge meta={priorityMeta(ticket.priority)} />
          </span>
        }
        description={
          <>
            提交人：{ticket.userEmail ?? '—'}
            {ticket.assigneeEmail ? ` · 处理人：${ticket.assigneeEmail}` : ''}
          </>
        }
      />

      {update ? (
        <form
          action={update}
          className="grid gap-3 rounded-2xl border bg-card p-5 shadow-sm sm:grid-cols-3"
        >
          <input type="hidden" name="id" value={ticket.id} />
          <Field
            label="状态"
            name="status"
            as="select"
            defaultValue={ticket.status}
            options={[
              { value: 'OPEN', label: '待处理' },
              { value: 'IN_PROGRESS', label: '处理中' },
              { value: 'RESOLVED', label: '已解决' },
              { value: 'CLOSED', label: '已关闭' },
            ]}
          />
          <Field label="优先级" name="priority" as="select" defaultValue={ticket.priority} />
          <label className="grid items-end gap-1.5 text-sm">
            <span className="font-medium">处理人（可选）</span>
            <input
              name="assigneeId"
              defaultValue={ticket.assigneeId ?? ''}
              placeholder="用户 ID"
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none"
            />
          </label>
          <button
            type="submit"
            className="inline-flex h-10 w-fit items-center gap-1.5 rounded-lg bg-foreground px-4 text-sm font-semibold text-background sm:col-span-3"
          >
            <Check className="size-4" />
            更新工单
          </button>
        </form>
      ) : null}

      <div className="space-y-3">
        {ticket.messages.map((message) => (
          <div key={message.id} className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                <UserRound className="size-3" />
              </span>
              <span className="font-medium text-card-foreground">
                {message.authorRole === 'ADMIN' ? '客服' : (message.authorEmail ?? '用户')}
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
          className="grid max-w-xl gap-3 rounded-2xl border bg-card p-4 shadow-sm"
        >
          <input type="hidden" name="id" value={ticket.id} />
          <Field label="回复用户" name="body" required as="textarea" placeholder="输入你的回复…" />
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

export const adminPages = {
  'admin/tickets': TicketAdminListPage,
  'admin/tickets/detail': TicketAdminDetailPage,
} as const;
