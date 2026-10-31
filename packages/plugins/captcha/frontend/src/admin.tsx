'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { messages, t } from './i18n.js';

const policySchema = z.enum(['off', 'optional', 'required']);

const presetSchema = z.object({
  id: z.string(),
  label: z.string(),
  verifyUrl: z.string(),
  supportsAction: z.boolean(),
  hint: z.string().optional(),
});

const statusSchema = z.object({
  configured: z.boolean(),
  secretsEnabled: z.boolean(),
  presets: z.array(presetSchema).default([]),
  actions: z.array(z.string()).default([]),
  preset: z.string().optional(),
  siteKey: z.string().optional(),
  verifyUrl: z.string().nullable().optional(),
  widgetAttributes: z.record(z.string(), z.string()).optional(),
  fieldMap: z.record(z.string(), z.string()).optional(),
  actionField: z.string().nullable().optional(),
  theme: z.enum(['auto', 'light', 'dark']).nullable().optional(),
  policies: z.record(z.string(), policySchema).optional(),
  secretConfigured: z.boolean().optional(),
});
type Status = z.infer<typeof statusSchema>;

/**
 * Feedback is localized prose only; a vendor's raw error body stays in the
 * console, exactly like the SMTP page: `SignatureDoesNotMatch` or a Cloudflare
 * stack trace is not user-facing copy.
 */
function failure(cause: unknown, message: string): string {
  console.error('[captcha] request failed', cause);
  return message;
}

function Field({
  label,
  name,
  value,
  onChange,
  type = 'text',
  placeholder,
  required = false,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
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
        placeholder={placeholder}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

const POLICY_ORDER = ['off', 'optional', 'required'] as const;

function CaptchaSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
  const status = props.data.status as Status | undefined;

  const [preset, setPreset] = useState(status?.preset ?? 'turnstile');
  const [siteKey, setSiteKey] = useState(status?.siteKey ?? '');
  const [secret, setSecret] = useState('');
  const [verifyUrl, setVerifyUrl] = useState(status?.verifyUrl ?? '');
  const [theme, setTheme] = useState(status?.theme ?? 'auto');
  const [policies, setPolicies] = useState<Record<string, string>>(status?.policies ?? {});
  const [capEndpoint, setCapEndpoint] = useState(
    status?.widgetAttributes?.['data-cap-api-endpoint'] ?? '',
  );
  const [testToken, setTestToken] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = status?.presets.find((item) => item.id === preset);
  const actions = status?.actions ?? [];

  const setPolicy = (action: string, mode: string): void => {
    setPolicies((prev) => {
      const next = { ...prev };
      // `off` is the kernel's default, so dropping the key keeps the payload
      // minimal and lets a future global change take effect again.
      if (mode === 'off') delete next[action];
      else next[action] = mode;
      return next;
    });
  };

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/captcha/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preset,
          siteKey,
          secret: secret || undefined,
          verifyUrl: verifyUrl || undefined,
          theme,
          ...(capEndpoint ? { widgetAttributes: { 'data-cap-api-endpoint': capEndpoint } } : {}),
          actions: policies,
        }),
      });
      if (!res.ok) throw new Error(tr('error.saveFailed'));
      setSecret('');
      toast.success(tr('notice.saved'));
      // `router.refresh()` re-fetches the RSC data without destroying the host
      // `<Toaster />`, so the confirmation is actually visible.
      router.refresh();
    } catch (error) {
      toast.error(failure(error, tr('error.saveFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/captcha/admin/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: testToken }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok) throw new Error(tr('error.testFailed'));
      if (body?.ok) toast.success(tr('test.passed'));
      else toast.error(tr('test.rejected'));
    } catch (error) {
      toast.error(failure(error, tr('error.testFailed')));
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
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{tr('field.preset')}</span>
          <select
            className="h-9 rounded-md border bg-background px-3"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            {(status?.presets ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {selected?.hint ? (
            <span className="text-xs text-muted-foreground">{selected.hint}</span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{tr('field.theme')}</span>
          <select
            className="h-9 rounded-md border bg-background px-3"
            value={theme}
            onChange={(e) => setTheme(e.target.value as 'auto' | 'light' | 'dark')}
          >
            <option value="auto">{tr('field.themeAuto')}</option>
            <option value="light">{tr('field.themeLight')}</option>
            <option value="dark">{tr('field.themeDark')}</option>
          </select>
        </label>

        <Field
          label={tr('field.siteKey')}
          name="siteKey"
          value={siteKey}
          onChange={setSiteKey}
          required
        />
        <Field
          label={tr('field.secret')}
          name="secret"
          value={secret}
          onChange={setSecret}
          type="password"
          placeholder={status?.secretConfigured ? tr('field.secretSaved') : undefined}
          required={!status?.secretConfigured}
        />
        <Field
          label={tr('field.verifyUrl')}
          name="verifyUrl"
          value={verifyUrl}
          onChange={setVerifyUrl}
          placeholder={selected?.verifyUrl || 'https://…'}
        />

        {preset === 'cap' ? (
          <Field
            label={tr('field.capEndpoint')}
            name="capEndpoint"
            value={capEndpoint}
            onChange={setCapEndpoint}
            placeholder="https://cap.example.com/"
          />
        ) : null}

        <section className="sm:col-span-2">
          <h2 className="text-sm font-semibold">{tr('policy.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{tr('policy.hint')}</p>
          <div className="mt-3 divide-y rounded-md border">
            {actions.map((action) => (
              <div key={action} className="flex items-center justify-between gap-4 px-3 py-2">
                <span className="text-sm">{tr(`policy.action.${action}`)}</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={policies[action] ?? 'off'}
                  onChange={(e) => setPolicy(action, e.target.value)}
                >
                  {POLICY_ORDER.map((mode) => (
                    <option key={mode} value={mode}>
                      {tr(`policy.mode.${mode}`)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </section>

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
            value={testToken}
            onChange={(e) => setTestToken(e.target.value)}
            placeholder={tr('test.placeholder')}
          />
          <button
            type="button"
            className="h-9 rounded-md border px-3 text-sm disabled:opacity-60"
            disabled={busy || !testToken}
            onClick={() => void test()}
          >
            {tr('test.submit')}
          </button>
        </div>
      </section>
    </main>
  );
}

// The host resolves a manifest route's `component` against the loaded module's
// `adminPages` map, so the export name is part of the ABI, not a convenience.
// Only `src/index.tsx` is bundled (shared tsup preset), which makes a separate
// `admin.tsx` a file nothing loads — it is folded in here instead.
export const adminPages = { 'admin/settings': CaptchaSettings } as const;

export { CaptchaSettings };
