'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { t } from './i18n.js';

/** 「我的企业 → 企业信息」：企业 ID 就在这一页最底部，后台导航里很难找。 */
const WECOM_PROFILE_URL = 'https://work.weixin.qq.com/wework_admin/frame#/profile';

const statusSchema = z.object({
  configured: z.boolean(),
  secretsEnabled: z.boolean().optional(),
  corpId: z.string().optional(),
  from: z.string().nullable().optional(),
  baseUrl: z.string().optional(),
  publicBaseUrl: z.string().nullable().optional(),
  excludeTypes: z.string().optional(),
  tokenCached: z.boolean().optional(),
  tokenExpiresInSeconds: z.number().optional(),
  adminEmail: z.string().nullable().optional(),
  otherChannels: z
    .array(z.object({ id: z.string(), configured: z.boolean().nullable() }))
    .optional(),
});
type Status = z.infer<typeof statusSchema>;

const connectResultSchema = z.object({
  connected: z.boolean(),
  corpId: z.string(),
  publicBaseUrl: z.string().nullable().optional(),
  test: z
    .object({
      sent: z.boolean(),
      to: z.string().nullable().optional(),
      code: z.string().optional(),
    })
    .optional(),
});
type ConnectResult = z.infer<typeof connectResultSchema>;

/**
 * 内核的错误体是 RFC 7807 的 problem-details（ADR-0012）：稳定的 `code` 才是
 * 契约，`detail` 只是给人看的补充。所以界面按 `code` 决定说什么——厂商的
 * errcode 早在上游就被翻译成稳定码了（见 `src/wecom-client.ts`）。
 */
async function problemOf(response: Response, fallback: string): Promise<{ code?: string }> {
  try {
    const body = (await response.json()) as { code?: string; error?: string };
    return { code: body.code ?? body.error };
  } catch {
    return { code: fallback };
  }
}

/**
 * 稳定错误码 → 「去后台做哪一件事」。取不到对应文案时返回 `null`，
 * 调用方退回通用提示，绝不显示原始 errcode。
 */
function remedyFor(tr: (key: string) => string, code: string | undefined): string | null {
  if (!code) return null;
  const key = `remedy.${code}`;
  const text = tr(key);
  return text === key ? null : text;
}

function Field({
  label,
  name,
  value,
  onChange,
  hint,
  type = 'text',
  placeholder,
  required = false,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: string;
  placeholder?: string;
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
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function WecomMailSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
  const status = props.data.status as Status | undefined;

  // 一键接入
  const [paste, setPaste] = useState('');
  const [sendTest, setSendTest] = useState(true);
  const [connected, setConnected] = useState<ConnectResult | null>(null);
  const [failure, setFailure] = useState<{ code?: string } | null>(null);

  // 高级设置（沿用已保存的值）
  const [corpId, setCorpId] = useState(status?.corpId ?? '');
  const [corpSecret, setCorpSecret] = useState('');
  const [from, setFrom] = useState(status?.from ?? '');
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? 'https://qyapi.weixin.qq.com');
  const [publicBaseUrl, setPublicBaseUrl] = useState(status?.publicBaseUrl ?? '');
  const [excludeTypes, setExcludeTypes] = useState(status?.excludeTypes ?? '');

  const [testTo, setTestTo] = useState(status?.adminEmail ?? '');
  const [busy, setBusy] = useState(false);

  /** 会真的发信、并且确实配置好的其它渠道：同时开两个 = 用户收到两封。 */
  const duplicateChannels = (status?.otherChannels ?? [])
    .filter((channel) => channel.configured !== false)
    .map((channel) => channel.id);

  async function connect() {
    setBusy(true);
    setFailure(null);
    setConnected(null);
    try {
      const response = await fetch('/api/plugins/wecom-mail/admin/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: paste,
          testSend: sendTest,
          ...(testTo ? { to: testTo } : {}),
        }),
      });
      if (!response.ok) {
        const problem = await problemOf(response, 'wecom.send_failed');
        setFailure(problem);
        toast.error(remedyFor(tr, problem.code) ?? tr('error.connectFailed'));
        return;
      }
      const parsed = connectResultSchema.safeParse(await response.json());
      if (!parsed.success) {
        setFailure({});
        toast.error(tr('error.connectFailed'));
        return;
      }
      setConnected(parsed.data);
      setPaste('');
      toast.success(parsed.data.test?.sent ? tr('connect.successWithTest') : tr('connect.success'));
      router.refresh();
    } catch (error) {
      setFailure({});
      toast.error(tr('error.connectFailed'));
      console.error('[wecom-mail] connect failed', error);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch('/api/plugins/wecom-mail/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          corpId,
          // 留空＝沿用已保存的 Secret：后台常规操作（改排除类型、换站点地址）
          // 不该逼运维再翻一次控制台贴密码。
          corpSecret: corpSecret || undefined,
          from: from || undefined,
          baseUrl: baseUrl || undefined,
          publicBaseUrl: publicBaseUrl || undefined,
          excludeTypes,
        }),
      });
      if (!response.ok) {
        const problem = await problemOf(response, 'wecom.send_failed');
        toast.error(remedyFor(tr, problem.code) ?? tr('error.saveFailed'));
        return;
      }
      toast.success(tr('notice.saved'));
      setCorpSecret('');
      // `location.reload()` 会把刚弹出的 toast 一起销毁；`router.refresh()` 只重取
      // RSC 数据，宿主 `<Toaster />` 不动，回执才看得见。
      router.refresh();
    } catch (error) {
      toast.error(tr('error.saveFailed'));
      console.error('[wecom-mail] save failed', error);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const response = await fetch('/api/plugins/wecom-mail/admin/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: testTo }),
      });
      if (!response.ok) {
        const problem = await problemOf(response, 'wecom.send_failed');
        toast.error(remedyFor(tr, problem.code) ?? tr('error.sendFailed'));
        return;
      }
      toast.success(tr('test.sent'));
    } catch (error) {
      toast.error(tr('error.sendFailed'));
      console.error('[wecom-mail] test send failed', error);
    } finally {
      setBusy(false);
    }
  }

  const connectRemedy = remedyFor(tr, failure?.code);
  const testFailureRemedy = remedyFor(tr, connected?.test?.code);

  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('page.title')} />
      <p className="text-sm text-muted-foreground">{tr('page.description')}</p>

      <p className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 ${
            status?.configured
              ? 'bg-emerald-500/10 text-emerald-600'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {status?.configured ? tr('status.configured') : tr('status.notConfigured')}
        </span>
        {status?.configured ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            {status.tokenCached
              ? `${tr('status.tokenCached')} · ${tr('status.expiresIn').replace(
                  '{{seconds}}',
                  String(status.tokenExpiresInSeconds ?? 0),
                )}`
              : tr('status.tokenMissing')}
          </span>
        ) : null}
      </p>

      {status?.secretsEnabled === false ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {tr('page.noSecrets')}
        </p>
      ) : null}

      {status?.configured && duplicateChannels.length > 0 ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-500">
          {tr('warning.duplicateChannel').replace('{{channels}}', duplicateChannels.join(', '))}
        </p>
      ) : null}

      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{tr('help.title')}</p>
        <p className="mt-1 leading-relaxed">{tr('help.steps')}</p>
      </div>

      {/* 一键接入：粘贴 → 真校验 → 保存 → 自测发信 */}
      <section className="space-y-3 rounded-lg border p-4">
        <div>
          <h2 className="text-sm font-semibold">{tr('connect.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{tr('connect.pasteHint')}</p>
          <a
            className="mt-1 inline-block text-xs underline underline-offset-2 hover:text-foreground"
            href={WECOM_PROFILE_URL}
            target="_blank"
            rel="noreferrer"
          >
            {tr('connect.corpIdLink')}
          </a>
        </div>
        <textarea
          className="min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={tr('connect.pastePlaceholder')}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={sendTest}
              onChange={(e) => setSendTest(e.target.checked)}
            />
            {testTo || status?.adminEmail
              ? tr('connect.testToggle').replace('{{email}}', testTo || status?.adminEmail || '')
              : tr('connect.testToggleNoEmail')}
          </label>
          <button
            type="button"
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60"
            disabled={busy || paste.trim().length === 0 || status?.secretsEnabled === false}
            onClick={() => void connect()}
          >
            {busy ? tr('connect.submitting') : tr('connect.submit')}
          </button>
        </div>

        {connected ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
            <p className="font-medium text-emerald-700 dark:text-emerald-500">
              {connected.test?.sent ? tr('connect.successWithTest') : tr('connect.success')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr('connect.connectedAs').replace('{{corpId}}', connected.corpId)}
              {connected.publicBaseUrl
                ? ` · ${tr('connect.publicBaseUrl').replace('{{url}}', connected.publicBaseUrl)}`
                : ''}
            </p>
            {connected.test && !connected.test.sent && connected.test.to ? (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">
                {tr('connect.testFailed')
                  .replace('{{email}}', connected.test.to)
                  .replace('{{reason}}', testFailureRemedy ?? tr('connect.testFailedUnknown'))}
              </p>
            ) : null}
          </div>
        ) : null}

        {failure ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <p className="font-medium">{tr('connect.failed')}</p>
            <p className="mt-1 text-xs">{connectRemedy ?? tr('error.connectFailed')}</p>
          </div>
        ) : null}
      </section>

      {/* 手工配置：一键接入覆盖不到的地方（内网代理、精确排除规则、发件人展示） */}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-semibold">{tr('advanced.title')}</summary>
        <form onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label={tr('field.corpId')}
            name="corpId"
            value={corpId}
            onChange={setCorpId}
            hint={tr('field.corpIdHint')}
            required
          />
          <Field
            label={tr('field.corpSecret')}
            name="corpSecret"
            value={corpSecret}
            onChange={setCorpSecret}
            hint={tr('field.corpSecretHint')}
            type="password"
          />
          <Field
            label={tr('field.from')}
            name="from"
            value={from}
            onChange={setFrom}
            hint={tr('field.fromHint')}
            type="email"
          />
          <Field
            label={tr('field.baseUrl')}
            name="baseUrl"
            value={baseUrl}
            onChange={setBaseUrl}
            hint={tr('field.baseUrlHint')}
          />
          <Field
            label={tr('field.publicBaseUrl')}
            name="publicBaseUrl"
            value={publicBaseUrl}
            onChange={setPublicBaseUrl}
            hint={tr('field.publicBaseUrlHint')}
            placeholder="https://panel.example.com"
          />
          <Field
            label={tr('field.excludeTypes')}
            name="excludeTypes"
            value={excludeTypes}
            onChange={setExcludeTypes}
            hint={tr('field.excludeTypesHint')}
            placeholder="security."
          />
          <button
            className="h-9 w-fit rounded-md border px-4 text-sm disabled:opacity-60 sm:col-span-2"
            disabled={busy}
          >
            {busy ? tr('action.saving') : tr('action.save')}
          </button>
        </form>
      </details>

      <section className="border-t pt-5">
        <h2 className="text-sm font-semibold">{tr('test.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{tr('test.hint')}</p>
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
            disabled={busy || !testTo || !status?.configured}
            onClick={() => void test()}
          >
            {tr('test.submit')}
          </button>
        </div>
      </section>
    </main>
  );
}

// The host resolves a manifest route's `component` against the loaded
// module's `adminPages` map, so the export name is part of the ABI.
export const adminPages = { 'admin/settings': WecomMailSettings } as const;
export { WecomMailSettings };
