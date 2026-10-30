'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { FeatureOverview, PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from './i18n.js';

interface EpayStatus {
  configured: boolean;
  secretsEnabled: boolean;
  baseUrl?: string;
  pid?: string;
  methods?: Array<{ id: string; label: string }>;
}

const DEFAULT_METHODS = 'alipay,wxpay,qqpay';

/** RFC 7807 problem-details body emitted by the kernel (ADR-0012). */
interface ProblemDetails {
  code?: string;
  title?: string;
  detail?: string;
}

/**
 * 易支付配置表单。
 *
 * 直接提交到该插件自己的内核路由（经通用 BFF 代理转发），而不是走内核的
 * 声明式 action 桥：桥在失败时用 `redirect` 回退，会重新渲染整页并清空
 * 未受控输入。这里用受控组件，失败时保留已填内容并以 toast 提示。
 */
function EpayAdminPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const status = props.data.status as EpayStatus | undefined;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? '');
  const [pid, setPid] = useState(status?.pid ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [platformPublicKey, setPlatformPublicKey] = useState('');
  const [methods, setMethods] = useState(
    status?.methods?.map((method) => method.id).join(',') || DEFAULT_METHODS,
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const payload = {
      baseUrl: baseUrl.trim(),
      pid: pid.trim(),
      privateKey: privateKey.trim(),
      platformPublicKey: platformPublicKey.trim(),
      methods: methods.trim(),
    };
    startTransition(async () => {
      try {
        const response = await fetch('/api/plugins/epay/admin/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          toast.error(await readErrorMessage(response, tr));
          return;
        }
        toast.success(tr('notice.saved'));
        router.refresh();
      } catch {
        toast.error(tr('notice.saveFailed'));
      }
    });
  }

  return (
    <main className="w-full space-y-8">
      <PageHeader title={tr('page.title')} />
      {status?.secretsEnabled === false ? (
        <p className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {tr('page.noSecrets')}
        </p>
      ) : null}
      {status?.configured ? (
        <section className="rounded-lg border bg-card p-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{tr('summary.gateway')}</dt>
              <dd className="mt-1 break-all">{status.baseUrl}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.pid')}</dt>
              <dd className="mt-1 font-mono">{status.pid}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tr('summary.methods')}</dt>
              <dd className="mt-1">
                {status.methods?.map((method) => method.label).join(tr('summary.join'))}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2"
      >
        <Field
          label={tr('field.baseUrl')}
          name="baseUrl"
          placeholder="https://pay.example.com"
          value={baseUrl}
          onChange={setBaseUrl}
          required
        />
        <Field label={tr('field.pid')} name="pid" value={pid} onChange={setPid} required />
        <Field
          label={tr('field.privateKey')}
          name="privateKey"
          textarea
          value={privateKey}
          onChange={setPrivateKey}
          required
        />
        <Field
          label={tr('field.platformPublicKey')}
          name="platformPublicKey"
          textarea
          value={platformPublicKey}
          onChange={setPlatformPublicKey}
          required
        />
        <Field
          label={tr('field.methods')}
          name="methods"
          placeholder="alipay,wxpay,qqpay"
          value={methods}
          onChange={setMethods}
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

function Field({
  label,
  name,
  placeholder,
  textarea = false,
  required = false,
  value,
  onChange,
}: {
  label: string;
  name: string;
  placeholder?: string;
  textarea?: boolean;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
    onChange(event.target.value);
  return (
    <label className={textarea ? 'grid gap-1 text-sm sm:col-span-2' : 'grid gap-1 text-sm'}>
      <span>{label}</span>
      {textarea ? (
        <textarea
          name={name}
          required={required}
          value={value}
          onChange={handleChange}
          className="min-h-32 rounded-lg border bg-background px-3 py-2 font-mono text-xs"
        />
      ) : (
        <input
          name={name}
          required={required}
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          className="h-9 rounded-lg border bg-background px-3 text-sm"
        />
      )}
    </label>
  );
}

/** Render a kernel problem-details response into a single user-facing message. */
async function readErrorMessage(
  response: Response,
  tr: (key: string, params?: Record<string, string | number>) => string,
): Promise<string> {
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
    // Non-JSON error body; fall through to a generic message.
  }
  return tr('error.withStatus', { status: response.status });
}

function EpayOverview(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const status = props.data.status as EpayStatus | undefined;
  return (
    <FeatureOverview
      title={tr('overview.title')}
      description={tr('overview.description')}
      unavailable={!status}
      labels={{
        unavailable: tr('overview.unavailable'),
        manageTitle: tr('overview.manageTitle'),
        manageDescription: tr('overview.manageDescription'),
        activityDescription: tr('overview.activityDescription'),
        empty: tr('overview.empty'),
      }}
      metrics={[
        {
          label: tr('overview.gatewayState'),
          value: status?.configured ? tr('overview.configured') : tr('overview.notConfigured'),
        },
        { label: tr('overview.methods'), value: status?.methods?.length ?? 0 },
        {
          label: tr('overview.secretStorage'),
          value: status?.secretsEnabled ? tr('overview.available') : tr('overview.disabled'),
        },
      ]}
      links={[
        {
          label: tr('overview.settingsLink'),
          description: tr('overview.settingsLinkDescription'),
          href: '/admin/plugin/epay/settings',
        },
      ]}
      activity={{
        title: tr('overview.activity'),
        items: (status?.methods ?? []).map((method) => ({
          label: method.label,
          detail: method.id,
        })),
      }}
    />
  );
}

export const adminPages = {
  'admin/summary': EpayOverview,
  'admin/overview': EpayAdminPage,
} as const;
