'use client';

import type { AdminPageComponentProps, FrontendPackage } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { messages, t } from './i18n.js';

const statusSchema = z.object({
  configured: z.boolean(),
  secretsEnabled: z.boolean(),
  host: z.string().optional(),
  port: z.number().optional(),
  secure: z.boolean().optional(),
  requireStartTls: z.boolean().optional(),
  from: z.string().optional(),
  fromName: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
  excludeTypes: z.string().optional(),
});
type Status = z.infer<typeof statusSchema>;

/**
 * 反馈只显示已本地化文案；异常正文（SMTP 报错、`SignatureDoesNotMatch` 之类）
 * 只进控制台。
 */
function failure(cause: unknown, message: string): string {
  console.error('[smtp] request failed', cause);
  return message;
}

function Field({
  label,
  name,
  value,
  onChange,
  type = 'text',
  required = false,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input
        className="h-9 rounded-md border bg-background px-3"
        name={name}
        type={type}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SmtpSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
  const status = props.data.status as Status | undefined;
  const [host, setHost] = useState(status?.host ?? '');
  const [port, setPort] = useState(String(status?.port ?? 465));
  const [from, setFrom] = useState(status?.from ?? '');
  const [fromName, setFromName] = useState(status?.fromName ?? '');
  const [user, setUser] = useState(status?.user ?? '');
  const [password, setPassword] = useState('');
  const [secure, setSecure] = useState(status?.secure ?? true);
  const [startTls, setStartTls] = useState(status?.requireStartTls ?? false);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/smtp/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host,
          port: Number(port),
          from,
          fromName: fromName || undefined,
          user: user || undefined,
          password: password || undefined,
          secure,
          requireStartTls: startTls,
          allowInsecure: false,
          rejectUnauthorized: true,
          excludeTypes: '',
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? tr('error.saveFailed'));
      toast.success(tr('notice.saved'));
      // `location.reload()` 会把刚弹出的 toast 一起销毁；`router.refresh()` 只重取
      // RSC 数据，宿主 `<Toaster />` 不动，回执才看得见。
      router.refresh();
    } catch (e) {
      toast.error(failure(e, tr('error.saveFailed')));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/smtp/admin/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: testTo }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? tr('error.sendFailed'));
      toast.success(tr('test.sent'));
    } catch (e) {
      toast.error(failure(e, tr('error.sendFailed')));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('page.title')} />
      <p className="text-sm text-muted-foreground">{tr('page.description')}</p>
      {status?.secretsEnabled === false ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {tr('page.noSecrets')}
        </p>
      ) : null}
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={tr('field.host')} name="host" value={host} onChange={setHost} required />
        <Field
          label={tr('field.port')}
          name="port"
          value={port}
          onChange={setPort}
          type="number"
          required
        />
        <Field
          label={tr('field.from')}
          name="from"
          value={from}
          onChange={setFrom}
          type="email"
          required
        />
        <Field
          label={tr('field.fromName')}
          name="fromName"
          value={fromName}
          onChange={setFromName}
        />
        <Field label={tr('field.user')} name="user" value={user} onChange={setUser} />
        <Field
          label={tr('field.password')}
          name="password"
          value={password}
          onChange={setPassword}
          type="password"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
          {tr('field.secure')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={startTls}
            onChange={(e) => setStartTls(e.target.checked)}
          />
          {tr('field.startTls')}
        </label>
        <button
          className="h-9 w-fit rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60 sm:col-span-2"
          disabled={busy}
        >
          {busy ? tr('action.saving') : tr('action.save')}
        </button>
      </form>
      <section className="border-t pt-5">
        <h2 className="text-sm font-semibold">{tr('test.title')}</h2>
        <div className="mt-3 flex max-w-xl gap-2">
          <input
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={tr('test.placeholder')}
            type="email"
          />
          <button
            type="button"
            className="h-9 rounded-md border px-3 text-sm disabled:opacity-60"
            disabled={busy || !testTo}
            onClick={() => void test()}
          >
            {tr('test.submit')}
          </button>
        </div>
      </section>
    </main>
  );
}

const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    adminRoutes: [
      {
        path: '/settings',
        component: 'admin/settings',
        permission: 'smtp.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 130 },
        // The settings page must open on the *current* relay, not on an empty
        // form: a blank host/port pair that gets saved silently disables mail
        // delivery. `fetch` is right for this: the host performs a plain kernel
        // GET under the operator's own session (ADR-0027), so the page needs **no**
        // server-execution admission — nothing from this package runs in the web
        // process.
        data: [{ fetch: { path: '/smtp/admin/config' }, as: 'status' }],
      },
    ],
  },
};
export { SmtpSettings };
export default frontend;
