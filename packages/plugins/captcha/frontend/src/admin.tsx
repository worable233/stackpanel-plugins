'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { AlertTriangle, KeyRound, Save, ShieldCheck, TestTube2 } from 'lucide-react';
import { Button, InlineError, Input, Label, SectionTitle, Select } from '@stackpanel/ui';
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
  id,
  label,
  name,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  required = false,
}: {
  id: string;
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="h-10 bg-background"
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const POLICY_ORDER = ['off', 'optional', 'required'] as const;

function CaptchaSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
  const parsed = statusSchema.safeParse(props.data.status);
  const status: Status | undefined = parsed.success ? parsed.data : undefined;

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
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

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
    setBusy('save');
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
      setBusy(null);
    }
  }

  async function test(): Promise<void> {
    setBusy('test');
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
      setBusy(null);
    }
  }

  return (
    <section className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-1 pb-2">
        <SectionTitle icon={<ShieldCheck />}>{tr('page.title')}</SectionTitle>
        <p className="text-sm leading-6 text-muted-foreground">{tr('page.description')}</p>
      </div>

      {status?.secretsEnabled === false ? (
        <div className="flex gap-3 rounded-2xl bg-destructive/8 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <InlineError>{tr('page.noSecrets')}</InlineError>
        </div>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-5">
        <section className="flex flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5">
          <div className="flex flex-col gap-1">
            <SectionTitle as="h3" icon={<KeyRound />}>
              {tr('field.connection')}
            </SectionTitle>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="captcha-preset">{tr('field.preset')}</Label>
              <Select
                id="captcha-preset"
                className="h-10 bg-background"
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
              >
                {(status?.presets ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
              {selected?.hint ? (
                <p className="text-xs leading-5 text-muted-foreground">{selected.hint}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="captcha-theme">{tr('field.theme')}</Label>
              <Select
                id="captcha-theme"
                className="h-10 bg-background"
                value={theme}
                onChange={(event) => setTheme(event.target.value as 'auto' | 'light' | 'dark')}
              >
                <option value="auto">{tr('field.themeAuto')}</option>
                <option value="light">{tr('field.themeLight')}</option>
                <option value="dark">{tr('field.themeDark')}</option>
              </Select>
            </div>

            <Field
              id="captcha-site-key"
              label={tr('field.siteKey')}
              name="siteKey"
              value={siteKey}
              onChange={setSiteKey}
              required
            />
            <Field
              id="captcha-secret"
              label={tr('field.secret')}
              name="secret"
              value={secret}
              onChange={setSecret}
              type="password"
              placeholder={status?.secretConfigured ? tr('field.secretSaved') : undefined}
              required={!status?.secretConfigured}
            />
            <Field
              id="captcha-verify-url"
              label={tr('field.verifyUrl')}
              name="verifyUrl"
              value={verifyUrl}
              onChange={setVerifyUrl}
              placeholder={selected?.verifyUrl || 'https://…'}
            />

            {preset === 'cap' ? (
              <Field
                id="captcha-cap-endpoint"
                label={tr('field.capEndpoint')}
                name="capEndpoint"
                value={capEndpoint}
                onChange={setCapEndpoint}
                placeholder="https://cap.example.com/"
              />
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5">
          <div className="flex flex-col gap-1">
            <SectionTitle as="h3" icon={<ShieldCheck />}>
              {tr('policy.title')}
            </SectionTitle>
            <p className="text-xs leading-5 text-muted-foreground">{tr('policy.hint')}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {actions.map((action, index) => (
              <div
                key={action}
                className={`flex items-center justify-between gap-3 rounded-xl bg-background px-3.5 py-2.5 ${
                  index === actions.length - 1 && actions.length % 2 === 1 ? 'sm:col-span-2' : ''
                }`}
              >
                <span className="min-w-0 text-sm">{tr(`policy.action.${action}`)}</span>
                <Select
                  aria-label={tr(`policy.action.${action}`)}
                  className="h-8 w-32 shrink-0"
                  value={policies[action] ?? 'off'}
                  onChange={(event) => setPolicy(action, event.target.value)}
                >
                  {POLICY_ORDER.map((mode) => (
                    <option key={mode} value={mode}>
                      {tr(`policy.mode.${mode}`)}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="h-10 px-5" disabled={busy !== null}>
            <Save className="size-4" aria-hidden="true" />
            {busy === 'save' ? tr('action.saving') : tr('action.save')}
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5">
        <div className="flex flex-col gap-1">
          <SectionTitle as="h3" icon={<TestTube2 />}>
            {tr('test.title')}
          </SectionTitle>
          <p className="text-xs leading-5 text-muted-foreground">{tr('test.hint')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            className="h-10 min-w-0 flex-1 bg-background"
            value={testToken}
            onChange={(event) => setTestToken(event.target.value)}
            placeholder={tr('test.placeholder')}
          />
          <Button
            type="button"
            variant="secondary"
            className="h-10 shrink-0 px-4"
            disabled={busy !== null || !testToken}
            onClick={() => void test()}
          >
            <TestTube2 className="size-4" aria-hidden="true" />
            {tr('test.submit')}
          </Button>
        </div>
      </section>
    </section>
  );
}

// The host resolves a manifest route's `component` against the loaded module's
// `adminPages` map, so the export name is part of the ABI, not a convenience.
// Only `src/index.tsx` is bundled (shared tsup preset), which makes a separate
// `admin.tsx` a file nothing loads — it is folded in here instead.
export const adminPages = { 'admin/settings': CaptchaSettings } as const;

export { CaptchaSettings };
