'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from './i18n.js';

interface WechatPayStatus {
  configured: boolean;
  secretsEnabled: boolean;
  appId?: string;
  mchId?: string;
  serialNo?: string;
  apiBase?: string;
  methods?: Array<{ id: string; label: string }>;
  platformCertificates?: Array<{ serialNo: string; expiresAtMs: number }>;
}

interface ProblemDetails {
  code?: string;
  title?: string;
  detail?: string;
}

const DEFAULT_API_BASE = 'https://api.mch.weixin.qq.com';

/**
 * 微信支付 v3 配置表单。
 *
 * 与支付宝页的两处差别：
 * - 密钥材料多两样（证书序列号、APIv3 密钥）。APIv3 密钥**不预填也不回显**：
 *   它同时是回调解密密钥，能读它就能伪造回调。
 * - 已配置后私钥/平台公钥留空表示「保持不变」，但 APIv3 密钥首次必填。
 */
function WechatPayAdminPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const status = props.data.status as WechatPayStatus | undefined;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [appId, setAppId] = useState(status?.appId ?? '');
  const [mchId, setMchId] = useState(status?.mchId ?? '');
  const [serialNo, setSerialNo] = useState(status?.serialNo ?? '');
  const [apiBase, setApiBase] = useState(status?.apiBase ?? DEFAULT_API_BASE);
  const [privateKey, setPrivateKey] = useState('');
  const [apiV3Key, setApiV3Key] = useState('');
  const [platformPublicKey, setPlatformPublicKey] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  /**
   * 手动触发平台证书轮换。平时由 `platform-cert-refresh` 任务每 12 小时跑一次；
   * 这个按钮的用处是「刚换了配置、又不想等下一次」。
   */
  function handleRefreshCertificates(): void {
    setRefreshing(true);
    void fetch('/api/plugins/wechatpay/admin/refresh-certificates', { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          toast.error(await readErrorMessage(response, tr));
          return;
        }
        const summary = (await response.json()) as { count?: number };
        toast.success(tr('notice.certificatesRefreshed', { count: String(summary.count ?? 0) }));
        router.refresh();
      })
      .catch(() => toast.error(tr('notice.certificatesRefreshFailed')))
      .finally(() => setRefreshing(false));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!status?.configured && apiV3Key.trim().length === 0) {
      toast.error(tr('notice.apiV3KeyRequired'));
      return;
    }
    const payload = {
      appId: appId.trim(),
      mchId: mchId.trim(),
      serialNo: serialNo.trim(),
      privateKey: privateKey.trim(),
      apiV3Key: apiV3Key.trim(),
      platformPublicKey: platformPublicKey.trim(),
      apiBase: apiBase.trim() || DEFAULT_API_BASE,
    };
    startTransition(async () => {
      try {
        const response = await fetch('/api/plugins/wechatpay/admin/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          toast.error(await readErrorMessage(response, tr));
          return;
        }
        toast.success(tr('notice.saved'));
        setPrivateKey('');
        setApiV3Key('');
        setPlatformPublicKey('');
        router.refresh();
      } catch {
        toast.error(tr('notice.saveFailed'));
      }
    });
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('page.title')} />
      {status?.secretsEnabled === false ? (
        <p className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {tr('page.noSecrets')}
        </p>
      ) : null}
      <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
        {tr('page.callbackHint', { path: '/callbacks/wechatpay' })}
      </p>

      {status?.configured ? (
        <section className="rounded-lg border bg-card p-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{tr('summary.mchId')}</dt>
              <dd className="mt-1 font-mono">{status.mchId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.serialNo')}</dt>
              <dd className="mt-1 font-mono break-all">{status.serialNo}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.appId')}</dt>
              <dd className="mt-1 font-mono break-all">{status.appId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.apiBase')}</dt>
              <dd className="mt-1 break-all">{status.apiBase}</dd>
            </div>
          </dl>
          <div className="mt-4 space-y-2 border-t pt-4">
            <p className="text-muted-foreground">
              {tr('summary.certificates', {
                count: String(status.platformCertificates?.length ?? 0),
                expiry: formatExpiry(status.platformCertificates?.[0]?.expiresAtMs),
              })}
            </p>
            <button
              type="button"
              onClick={handleRefreshCertificates}
              disabled={refreshing}
              className="h-8 rounded-lg border px-3 text-sm font-medium disabled:opacity-60"
            >
              {refreshing ? tr('action.refreshing') : tr('action.refreshCertificates')}
            </button>
          </div>
        </section>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2"
      >
        <Field label={tr('field.appId')} name="appId" value={appId} onChange={setAppId} required />
        <Field label={tr('field.mchId')} name="mchId" value={mchId} onChange={setMchId} required />
        <Field
          label={tr('field.serialNo')}
          name="serialNo"
          value={serialNo}
          onChange={setSerialNo}
          required
        />
        <Field
          label={tr('field.apiBase')}
          name="apiBase"
          value={apiBase}
          onChange={setApiBase}
          hint={tr('field.apiBaseHint', { default: DEFAULT_API_BASE })}
        />
        <Field
          label={tr('field.privateKey')}
          name="privateKey"
          textarea
          placeholder={status?.configured ? tr('field.keyKeep') : ''}
          value={privateKey}
          onChange={setPrivateKey}
          required={!status?.configured}
        />
        <Field
          label={tr('field.platformPublicKey')}
          name="platformPublicKey"
          textarea
          placeholder={status?.configured ? tr('field.keyKeep') : ''}
          value={platformPublicKey}
          onChange={setPlatformPublicKey}
          required={!status?.configured}
        />
        <Field
          label={tr('field.apiV3Key')}
          name="apiV3Key"
          value={apiV3Key}
          onChange={setApiV3Key}
          placeholder={status?.configured ? tr('field.keyKeep') : ''}
          required={!status?.configured}
        />
        <button
          type="submit"
          disabled={pending}
          className="h-9 w-fit rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60 sm:col-span-2"
        >
          {pending ? tr('action.saving') : tr('action.save')}
        </button>
      </form>
    </main>
  );
}

function Field(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  textarea?: boolean;
  required?: boolean;
}): ReactElement {
  const id = `wechatpay-${props.name}`;
  const className =
    'w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary';
  return (
    <div className={props.textarea ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
      <label htmlFor={id} className="text-sm font-medium">
        {props.label}
      </label>
      {props.textarea ? (
        <textarea
          id={id}
          name={props.name}
          rows={5}
          className={`${className} font-mono`}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
          required={props.required}
        />
      ) : (
        <input
          id={id}
          name={props.name}
          className={className}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
          required={props.required}
        />
      )}
      {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
    </div>
  );
}

function formatExpiry(expiresAtMs: number | undefined): string {
  if (!expiresAtMs) return '—';
  const date = new Date(expiresAtMs);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

async function readErrorMessage(response: Response, tr: ReturnType<typeof t>): Promise<string> {
  if (response.status === 401) return tr('error.unauthenticated');
  if (response.status === 403) return tr('error.forbidden');
  try {
    const body = (await response.json()) as ProblemDetails;
    const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
    if (detail) return detail;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title) return title;
    if (typeof body.code === 'string' && body.code.trim()) {
      return tr('error.withCode', { code: body.code });
    }
  } catch {
    // 非 JSON 错误体，落到通用提示。
  }
  return tr('error.withStatus', { status: response.status });
}

export const adminPages = {
  'admin/settings': WechatPayAdminPage,
} as const;
