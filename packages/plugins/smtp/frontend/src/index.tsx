'use client';

import type { AdminPageComponentProps, FinderContext, FrontendPackage } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const statusSchema = z.object({
  configured: z.boolean(),
  secretsEnabled: z.boolean(),
  host: z.string().optional(), port: z.number().optional(), secure: z.boolean().optional(),
  requireStartTls: z.boolean().optional(), from: z.string().optional(), fromName: z.string().nullable().optional(),
  user: z.string().nullable().optional(), excludeTypes: z.string().optional(),
});
type Status = z.infer<typeof statusSchema>;

function Field({ label, name, value, onChange, type = 'text', required = false }: { label: string; name: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }): ReactElement {
  return <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">{label}</span><input className="h-9 rounded-md border bg-background px-3" name={name} type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)} /></label>;
}

function SmtpSettings({ data }: AdminPageComponentProps): ReactElement {
  const status = data.data.status as Status | undefined;
  const [host, setHost] = useState(status?.host ?? ''); const [port, setPort] = useState(String(status?.port ?? 465));
  const [from, setFrom] = useState(status?.from ?? ''); const [fromName, setFromName] = useState(status?.fromName ?? '');
  const [user, setUser] = useState(status?.user ?? ''); const [password, setPassword] = useState('');
  const [secure, setSecure] = useState(status?.secure ?? true); const [startTls, setStartTls] = useState(status?.requireStartTls ?? false);
  const [testTo, setTestTo] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); try { const res = await fetch('/api/plugins/smtp/smtp/admin/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host, port: Number(port), from, fromName: fromName || undefined, user: user || undefined, password: password || undefined, secure, requireStartTls: startTls, allowInsecure: false, rejectUnauthorized: true, excludeTypes: '' }) }); if (!res.ok) throw new Error((await res.json()).error ?? '保存失败'); toast.success('SMTP 配置已保存'); window.location.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } }
  async function test() { setBusy(true); try { const res = await fetch('/api/plugins/smtp/smtp/admin/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: testTo }) }); if (!res.ok) throw new Error((await res.json()).error ?? '发送失败'); toast.success('测试邮件已发送'); } catch (e) { toast.error(e instanceof Error ? e.message : '发送失败'); } finally { setBusy(false); } }
  return <main className="w-full space-y-6"><PageHeader title="SMTP 邮件" /><p className="text-sm text-muted-foreground">用于发送注册邮箱验证码、密码安全通知和站内通知邮件。</p>{status?.secretsEnabled === false ? <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">平台加密密钥未配置，无法保存 SMTP 密码。</p> : null}<form onSubmit={submit} className="grid gap-4 sm:grid-cols-2"><Field label="SMTP 主机" name="host" value={host} onChange={setHost} required /><Field label="端口" name="port" value={port} onChange={setPort} type="number" required /><Field label="发件邮箱" name="from" value={from} onChange={setFrom} type="email" required /><Field label="发件人名称" name="fromName" value={fromName} onChange={setFromName} /><Field label="用户名" name="user" value={user} onChange={setUser} /><Field label="密码" name="password" value={password} onChange={setPassword} type="password" /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />隐式 TLS（通常端口 465）</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={startTls} onChange={(e) => setStartTls(e.target.checked)} />STARTTLS（通常端口 587）</label><button className="h-9 w-fit rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60 sm:col-span-2" disabled={busy}>{busy ? '保存中…' : '保存配置'}</button></form><section className="border-t pt-5"><h2 className="text-sm font-semibold">发送测试邮件</h2><div className="mt-3 flex max-w-xl gap-2"><input className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="收件地址" type="email" /><button type="button" className="h-9 rounded-md border px-3 text-sm disabled:opacity-60" disabled={busy || !testTo} onClick={() => void test()}>发送测试</button></div></section></main>;
}

const frontend: FrontendPackage = { finders: { 'smtp.status': { handler: async (_input: Record<string, unknown>, ctx: FinderContext) => ctx.api.get('/smtp/admin/config', statusSchema) } }, ui: { adminRoutes: [{ path: '/settings', component: 'admin/settings', permission: 'smtp.admin', systemSettings: { labelKey: 'admin.systemSettings', order: 130 }, data: [{ finder: 'smtp.status', as: 'status' }] }] } };
export { SmtpSettings };
export default frontend;
