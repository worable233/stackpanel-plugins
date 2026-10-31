'use client';

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Gauge,
  Play,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  TestTube2,
} from 'lucide-react';
import {
  Button,
  Checkbox,
  InlineError,
  InlineNotice,
  Input,
  Label,
  SectionTitle,
  Select,
  StatusBadge,
} from '@stackpanel/ui';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
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
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testFailed, setTestFailed] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setSaveMessage(null);
    setSaveFailed(false);
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
      setSaveMessage(tr('notice.saved'));
      // `router.refresh()` re-fetches the RSC data (including `status`) without
      // remounting the page, so the notice stays visible.
      router.refresh();
    } catch (error) {
      setSaveFailed(true);
      setSaveMessage(failure(error, tr('error.saveFailed')));
    } finally {
      setBusy(null);
    }
  }

  async function selfTest(): Promise<void> {
    setBusy('test');
    setTestMessage(null);
    setTestFailed(false);
    try {
      const res = await fetch('/api/plugins/altcha/admin/test', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok) throw new Error(tr('error.testFailed'));
      setTestFailed(!body?.ok);
      setTestMessage(body?.ok ? tr('test.passed') : tr('test.rejected'));
    } catch (error) {
      setTestFailed(true);
      setTestMessage(failure(error, tr('error.testFailed')));
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

      <div className="flex flex-col gap-4 rounded-2xl bg-muted/35 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={
              status?.configured
                ? 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success'
                : 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground'
            }
          >
            {status?.configured ? (
              <ShieldCheck className="size-4" aria-hidden="true" />
            ) : (
              <ShieldOff className="size-4" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={status?.configured ? 'ok' : 'neutral'}>
                {status?.configured ? tr('page.statusOn') : tr('page.statusOff')}
              </StatusBadge>
            </div>
            {status?.keyFingerprint ? (
              <p className="mt-2 text-xs leading-5 break-all text-muted-foreground">
                {tr('page.keyFingerprint').replace('{fingerprint}', status.keyFingerprint)}
              </p>
            ) : null}
          </div>
        </div>
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
            <SectionTitle as="h3" icon={<ShieldCheck />}>
              {tr('policy.title')}
            </SectionTitle>
            <p className="text-xs leading-5 text-muted-foreground">{tr('policy.hint')}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {ACTIONS.map((action) => (
              <div
                key={action}
                className={`flex items-center justify-between gap-3 rounded-xl bg-background px-3.5 py-2.5 ${
                  action === ACTIONS[ACTIONS.length - 1] ? 'sm:col-span-2' : ''
                }`}
              >
                <span className="min-w-0 text-sm">{tr(`policy.action.${action}`)}</span>
                <Select
                  aria-label={tr(`policy.action.${action}`)}
                  className="h-8 w-28 shrink-0"
                  value={actions[action] ?? 'required'}
                  onChange={(event) =>
                    setActions((prev) => ({ ...prev, [action]: event.target.value }))
                  }
                >
                  {MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {tr(`policy.mode.${mode}`)}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5">
          <div className="flex flex-col gap-1">
            <SectionTitle as="h3" icon={<SlidersHorizontal />}>
              {tr('field.runtime')}
            </SectionTitle>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="altcha-max-number">{tr('field.maxNumber')}</Label>
              <Input
                id="altcha-max-number"
                type="number"
                min={1_000}
                max={5_000_000}
                step={1_000}
                className="h-10 bg-background"
                value={maxNumber}
                onChange={(event) => setMaxNumber(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">{tr('field.maxNumberHint')}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="altcha-expires">{tr('field.expiresMinutes')}</Label>
              <Input
                id="altcha-expires"
                type="number"
                min={0}
                max={120}
                step={1}
                className="h-10 bg-background"
                value={expiresMinutes}
                onChange={(event) => setExpiresMinutes(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {tr('field.expiresMinutesHint')}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="altcha-language">{tr('field.language')}</Label>
              <Input
                id="altcha-language"
                type="text"
                placeholder="zh-cn"
                className="h-10 bg-background"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">{tr('field.languageHint')}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="altcha-theme">{tr('field.theme')}</Label>
              <Select
                id="altcha-theme"
                className="h-10 bg-background"
                value={theme}
                onChange={(event) => setTheme(event.target.value as 'auto' | 'light' | 'dark')}
              >
                <option value="auto">{tr('field.themeAuto')}</option>
                <option value="light">{tr('field.themeLight')}</option>
                <option value="dark">{tr('field.themeDark')}</option>
              </Select>
            </div>

            <div className="flex items-start gap-3 rounded-xl bg-background p-3.5 sm:col-span-2">
              <Checkbox
                id="altcha-single-use"
                checked={singleUse}
                onCheckedChange={(checked) => setSingleUse(checked === true)}
                className="mt-0.5"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor="altcha-single-use">{tr('field.singleUse')}</Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  {tr('field.singleUseHint')}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="h-10 px-5" disabled={busy !== null}>
            {busy === 'save' ? tr('action.saving') : tr('action.save')}
          </Button>
          {saveMessage ? (
            saveFailed ? (
              <InlineError>{saveMessage}</InlineError>
            ) : (
              <InlineNotice className="text-success">{saveMessage}</InlineNotice>
            )
          ) : null}
        </div>
      </form>

      <section className="flex flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <SectionTitle as="h3" icon={<TestTube2 />}>
              {tr('test.title')}
            </SectionTitle>
            <p className="text-xs leading-5 text-muted-foreground">{tr('test.hint')}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="h-10 shrink-0 px-4"
            disabled={busy !== null}
            onClick={() => void selfTest()}
          >
            {busy === 'test' ? (
              <Gauge className="size-4 animate-pulse" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )}
            {tr('test.submit')}
          </Button>
        </div>
        {testMessage ? (
          testFailed ? (
            <InlineError>{testMessage}</InlineError>
          ) : (
            <InlineNotice className="text-success">{testMessage}</InlineNotice>
          )
        ) : null}
      </section>
    </section>
  );
}

// The host resolves a manifest route's `component` against the loaded module's
// `adminPages` map, so the export name is part of the ABI, not a convenience.
// Only `src/index.tsx` is bundled (shared tsup preset), which makes a separate
// `admin.tsx` a file nothing ever loads — it is folded in here instead.
export const adminPages = { 'admin/settings': AltchaSettings } as const;

export { AltchaSettings };
