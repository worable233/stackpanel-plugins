import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@stackpanel/ui';
import type { AdminPageComponentProps, FrontendPackage } from '@stackpanel/sdk';
import { messages, t } from './i18n.js';

/**
 * 自托管人机验证的设置页。
 *
 * 这个页面只有一件事要注意：**没有任何密钥要填**。签名密钥由插件自己生成，
 * 所以这里能配的只有「多难」「多久过期」「哪些操作要验证」。控件本身由内核
 * 登录/注册等表单自动渲染，不需要在这里预览。
 */

interface Status {
  configured: boolean;
  keyFingerprint: string | null;
  actions: Record<string, string>;
  maxNumber: number;
  expiresMinutes: number;
  language: string | null;
  theme: 'light' | 'dark' | 'auto' | null;
  singleUse: boolean;
  widgetBytes: number;
  secretsEnabled?: boolean;
}

/** 受保护操作，顺序即展示顺序（与内核调用点一致）。 */
const ACTIONS = [
  'login',
  'register',
  'register_send_code',
  'password_reset',
  'change_password',
  'change_email',
  'api_token_create',
] as const;

const MODES = ['required', 'optional', 'off'] as const;

/**
 * Log the cause, show the message. A stack trace is never user-facing copy, and
 * the console is where an operator will actually look.
 */
function failure(cause: unknown, message: string): string {
  console.error('[altcha] request failed', cause);
  return message;
}

function AltchaSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
  const status = props.data.status as Status | undefined;

  const [actions, setActions] = useState<Record<string, string>>(status?.actions ?? {});
  const [maxNumber, setMaxNumber] = useState(String(status?.maxNumber ?? 100_000));
  const [expiresMinutes, setExpiresMinutes] = useState(String(status?.expiresMinutes ?? 10));
  const [language, setLanguage] = useState(status?.language ?? '');
  const [theme, setTheme] = useState(status?.theme ?? 'auto');
  const [singleUse, setSingleUse] = useState(status?.singleUse ?? true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const res = await fetch('/api/plugins/altcha/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actions,
          maxNumber: Number(maxNumber),
          expiresMinutes: Number(expiresMinutes),
          language: language.trim(),
          theme,
          singleUse,
        }),
      });
      if (!res.ok) throw new Error(tr('error.saveFailed'));
      setMessage(tr('notice.saved'));
      // `router.refresh()` re-fetches the RSC data (including `status`) without
      // remounting the page, so the notice stays visible.
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(failure(error, tr('error.saveFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function selfTest(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const res = await fetch('/api/plugins/altcha/admin/test', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok) throw new Error(tr('error.testFailed'));
      setFailed(!body?.ok);
      setMessage(body?.ok ? tr('test.passed') : tr('test.rejected'));
    } catch (error) {
      setFailed(true);
      setMessage(failure(error, tr('error.testFailed')));
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

      <p className="text-xs text-muted-foreground">
        {status?.configured ? tr('page.statusOn') : tr('page.statusOff')}
        {status?.keyFingerprint
          ? ` · ${tr('page.keyFingerprint').replace('{fingerprint}', status.keyFingerprint)}`
          : ''}
      </p>

      <form onSubmit={submit} className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{tr('policy.title')}</h2>
          <p className="text-xs text-muted-foreground">{tr('policy.hint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {ACTIONS.map((action) => (
              <label key={action} className="flex items-center justify-between gap-3 text-sm">
                <span>{tr(`policy.action.${action}`)}</span>
                <select
                  className="h-9 rounded-md border bg-background px-2"
                  value={actions[action] ?? 'required'}
                  onChange={(e) =>
                    setActions((prev) => ({ ...prev, [action]: e.target.value }))
                  }
                >
                  {MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {tr(`policy.mode.${mode}`)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{tr('field.maxNumber')}</span>
            <input
              type="number"
              min={1_000}
              max={5_000_000}
              step={1_000}
              className="h-9 rounded-md border bg-background px-3"
              value={maxNumber}
              onChange={(e) => setMaxNumber(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">{tr('field.maxNumberHint')}</span>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{tr('field.expiresMinutes')}</span>
            <input
              type="number"
              min={0}
              max={120}
              step={1}
              className="h-9 rounded-md border bg-background px-3"
              value={expiresMinutes}
              onChange={(e) => setExpiresMinutes(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">{tr('field.expiresMinutesHint')}</span>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{tr('field.language')}</span>
            <input
              type="text"
              placeholder="zh-cn"
              className="h-9 rounded-md border bg-background px-3"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">{tr('field.languageHint')}</span>
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

          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2">
            <span className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={singleUse}
                onChange={(e) => setSingleUse(e.target.checked)}
              />
              {tr('field.singleUse')}
            </span>
            <span className="text-xs text-muted-foreground">{tr('field.singleUseHint')}</span>
          </label>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
            disabled={busy}
          >
            {busy ? tr('action.saving') : tr('action.save')}
          </button>
          {message ? (
            <span className={`text-sm ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
              {message}
            </span>
          ) : null}
        </div>
      </form>

      <section className="space-y-3 border-t pt-4">
        <h2 className="text-sm font-semibold">{tr('test.title')}</h2>
        <p className="text-xs text-muted-foreground">{tr('test.hint')}</p>
        <button
          type="button"
          className="h-9 rounded-md border px-4 text-sm disabled:opacity-60"
          disabled={busy}
          onClick={() => void selfTest()}
        >
          {tr('test.submit')}
        </button>
      </section>
    </main>
  );
}

// The host resolves a manifest route's `component` against the loaded module's
// `adminPages` map, so the export name is part of the ABI, not a convenience.
// Only `src/index.tsx` is bundled (shared tsup preset), which makes a separate
// `admin.tsx` a file nothing ever loads — it is folded in here instead.
export const adminPages = { 'admin/settings': AltchaSettings } as const;

const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  adminPages,
  ui: {
    adminRoutes: [
      {
        path: '/settings',
        component: 'admin/settings',
        permission: 'altcha.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 126 },
        // Declarative data (ADR-0027): the host performs the kernel GET, so this
        // panel needs no server execution grant.
        data: [{ fetch: { path: '/altcha/admin/config' }, as: 'status' }],
      },
    ],
  },
};

export { AltchaSettings };
export default frontend;
