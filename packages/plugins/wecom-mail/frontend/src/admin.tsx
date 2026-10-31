'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { t } from './i18n.js';

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
});
type Status = z.infer<typeof statusSchema>;

/**
 * 反馈只显示已本地化文案；上游原文（企业微信 errcode / 网络异常）只进控制台
 * ——运维排查看日志，终端用户看得到的是稳定错误码对应的那句话（ADR-0012）。
 */
function failure(cause: unknown, message: string): string {
  console.error('[wecom-mail] request failed', cause);
  return message;
}

function Field({
  label,
  name,
  value,
  onChange,
  hint,
  type = 'text',
  required = false,
  placeholder,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
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

  const [corpId, setCorpId] = useState(status?.corpId ?? '');
  const [corpSecret, setCorpSecret] = useState('');
  const [from, setFrom] = useState(status?.from ?? '');
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? 'https://qyapi.weixin.qq.com');
  const [publicBaseUrl, setPublicBaseUrl] = useState(status?.publicBaseUrl ?? '');
  const [excludeTypes, setExcludeTypes] = useState(status?.excludeTypes ?? '');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/wecom-mail/admin/config', {
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
      if (!res.ok) throw new Error((await res.json()).error ?? tr('error.saveFailed'));
      toast.success(tr('notice.saved'));
      setCorpSecret('');
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
      const res = await fetch('/api/plugins/wecom-mail/admin/test', {
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

      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{tr('help.title')}</p>
        <p className="mt-1 leading-relaxed">{tr('help.steps')}</p>
      </div>

      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
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
          className="h-9 w-fit rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60 sm:col-span-2"
          disabled={busy}
        >
          {busy ? tr('action.saving') : tr('action.save')}
        </button>
      </form>

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
