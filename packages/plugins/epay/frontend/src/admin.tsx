'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent, type ReactElement } from 'react';
import { toast } from 'sonner';

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
          toast.error(await readErrorMessage(response));
          return;
        }
        toast.success('易支付配置已保存。');
        router.refresh();
      } catch {
        toast.error('保存失败，请稍后重试。');
      }
    });
  }

  return (
    <main className="w-full space-y-8">
      <PageHeader title="易支付" description="配置兼容 RSA V2 协议的易支付网关。" />
      {status?.secretsEnabled === false ? (
        <p className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          未配置平台加密密钥，无法保存商户私钥。
        </p>
      ) : null}
      {status?.configured ? (
        <section className="rounded-lg border bg-card p-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">网关地址</dt>
              <dd className="mt-1 break-all">{status.baseUrl}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">商户 PID</dt>
              <dd className="mt-1 font-mono">{status.pid}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">支付方式</dt>
              <dd className="mt-1">{status.methods?.map((method) => method.label).join('、')}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2"
      >
        <Field
          label="网关地址"
          name="baseUrl"
          placeholder="https://pay.example.com"
          value={baseUrl}
          onChange={setBaseUrl}
          required
        />
        <Field label="商户 PID" name="pid" value={pid} onChange={setPid} required />
        <Field
          label="商户 RSA 私钥"
          name="privateKey"
          textarea
          value={privateKey}
          onChange={setPrivateKey}
          required
        />
        <Field
          label="平台 RSA 公钥"
          name="platformPublicKey"
          textarea
          value={platformPublicKey}
          onChange={setPlatformPublicKey}
          required
        />
        <Field
          label="支付方式"
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
          {pending ? '保存中…' : '保存配置'}
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
async function readErrorMessage(response: Response): Promise<string> {
  if (response.status === 401) return '登录状态已失效，请重新登录。';
  if (response.status === 403) return '无权执行此操作。';
  try {
    const body = (await response.json()) as ProblemDetails;
    const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
    if (detail) return detail;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title) return title;
    if (typeof body.code === 'string' && body.code.trim()) return `保存失败（${body.code}）。`;
  } catch {
    // Non-JSON error body; fall through to a generic message.
  }
  return `保存失败（HTTP ${response.status}）。`;
}

export const adminPages = {
  'admin/overview': EpayAdminPage,
} as const;
