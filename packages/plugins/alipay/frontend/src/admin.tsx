'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from './i18n.js';

interface AlipayStatus {
  configured: boolean;
  secretsEnabled: boolean;
  appId?: string;
  gatewayUrl?: string;
  methods?: Array<{ id: string; label: string }>;
}

interface ProblemDetails {
  code?: string;
  title?: string;
  detail?: string;
}

const DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

/**
 * 支付宝当面付配置表单。
 *
 * 直接提交到插件自己的内核路由（经通用 BFF 代理），不走声明式 action 桥：
 * 桥在失败时 redirect 回退会重渲染整页，把已经粘贴进去的私钥清空 —— 对
 * 一段 2000 字符的密钥来说，这个体验代价太大。
 *
 * 私钥不预填：服务端只回显「已配置」，不把密钥材料再吐回浏览器。
 */
function AlipayAdminPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const status = props.data.status as AlipayStatus | undefined;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [appId, setAppId] = useState(status?.appId ?? '');
  const [gatewayUrl, setGatewayUrl] = useState(status?.gatewayUrl ?? DEFAULT_GATEWAY);
  const [privateKey, setPrivateKey] = useState('');
  const [alipayPublicKey, setAlipayPublicKey] = useState('');

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const payload = {
      appId: appId.trim(),
      privateKey: privateKey.trim(),
      alipayPublicKey: alipayPublicKey.trim(),
      gatewayUrl: gatewayUrl.trim() || DEFAULT_GATEWAY,
    };
    startTransition(async () => {
      try {
        const response = await fetch('/api/plugins/alipay/admin/config', {
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
        {tr('page.callbackHint', { path: '/callbacks/alipay' })}
      </p>

      {status?.configured ? (
        <section className="rounded-lg border bg-card p-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{tr('summary.appId')}</dt>
              <dd className="mt-1 font-mono break-all">{status.appId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.gateway')}</dt>
              <dd className="mt-1 break-all">{status.gatewayUrl}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.methods')}</dt>
              <dd className="mt-1">{status.methods?.map((method) => method.label).join('、')}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2"
      >
        <Field label={tr('field.appId')} name="appId" value={appId} onChange={setAppId} required />
        <Field
          label={tr('field.gatewayUrl')}
          name="gatewayUrl"
          value={gatewayUrl}
          onChange={setGatewayUrl}
          hint={tr('field.gatewayHint', { sandbox: SANDBOX_GATEWAY })}
          required
        />
        <Field
          label={tr('field.privateKey')}
          name="privateKey"
          textarea
          placeholder={status?.configured ? tr('field.keyKeep') : ''}
          value={privateKey}
          onChange={setPrivateKey}
          required
        />
        <Field
          label={tr('field.alipayPublicKey')}
          name="alipayPublicKey"
          textarea
          placeholder={status?.configured ? tr('field.keyKeep') : ''}
          value={alipayPublicKey}
          onChange={setAlipayPublicKey}
          required
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
  const id = `alipay-${props.name}`;
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
  'admin/settings': AlipayAdminPage,
} as const;
