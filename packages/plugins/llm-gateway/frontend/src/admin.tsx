'use client';
import { SectionTitle } from '@stackpanel/ui';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useState, useTransition } from 'react';
import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { z } from 'zod';
import {
  Button,
  Card,
  CardHeader,
  CardContent,
  CardDescription,
  Field,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
  Input,
  Label,
  PageHeader,
  Select,
} from '@stackpanel/ui';
import {
  Save,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Tags,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import {
  CAPABILITY_OPTIONS,
  Empty,
  PROTOCOL_OPTIONS,
  Section,
  Stats,
  accountSchema,
  adminAccountsSchema,
  adminOverviewSchema,
  adminPricesSchema,
  capabilityLabel,
  money,
  protocolLabel,
  shortTime,
} from './ui';
import { t } from './i18n.js';

/**
 * 管理端交互页面（客户端 bundle）。
 *
 * 对应 `ui.adminRoutes` 中的 `component`：
 * - `admin/overview` → GatewayAdminOverview
 * - `admin/accounts` → GatewayAdminAccounts
 *
 * 构建脚本会把本文件编译为 `frontend/dist/admin.js`，并写入
 * `apps/web/src/lib/frontend-client-registry.ts`。
 */

type AccountRow = z.infer<typeof accountSchema>;
type Translator = (key: string, params?: Record<string, string | number>) => string;

/**
 * 反馈只能显示已本地化的文案，绝不显示原始异常正文（同内核契约：按 code 查文案）。
 *
 * 异常正文只进控制台，界面拿到调用方选定的 `tr(...)` 文案。
 */
function failure(cause: unknown, message: string): string {
  console.error('[llm-gateway] request failed', cause);
  return message;
}

const MODEL_LIMIT = 500;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function GatewayAdminOverview(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const locale = props.locale ?? 'zh-CN';
  const data = props.data as { overview?: z.infer<typeof adminOverviewSchema> };
  const overview = data.overview;
  return (
    <main className="space-y-8">
      <PageHeader title={tr('admin.overview.title')} />
      {overview ? (
        <Stats
          items={[
            { label: tr('admin.overview.accounts'), value: String(overview.accounts) },
            { label: tr('admin.overview.keys'), value: String(overview.keys) },
            { label: tr('admin.overview.requests'), value: String(overview.summary.requests) },
            { label: tr('admin.overview.revenue'), value: money(overview.summary.amount) },
          ]}
        />
      ) : null}

      <Section icon={<TrendingUp />} title={tr('admin.overview.topModels')}>
        {overview?.topModels.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {overview.topModels.map((row) => (
              <li
                key={row.model}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
              >
                <span className="min-w-0 truncate font-medium">{row.model}</span>
                <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {tr('admin.overview.topModelRequests', { count: row.requests })}
                  </span>
                  <span className="hidden tabular-nums sm:inline">{row.totalTokens} token</span>
                  <span className="font-mono text-sm font-semibold text-foreground tabular-nums">
                    {money(row.amount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('admin.overview.empty')} icon={<TrendingUp />} />
        )}
      </Section>

      <Section
        icon={<History />}
        title={tr('admin.overview.recentTitle')}
        description={tr('admin.overview.recentDescription')}
      >
        {overview?.logs.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {overview.logs.map((log) => (
              <li
                key={log.id}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{log.model}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {shortTime(log.createdAt, locale)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {log.totalTokens} token
                  </span>
                  <span
                    className={
                      log.status === 'SUCCESS'
                        ? 'text-xs text-emerald-600'
                        : 'text-xs text-destructive'
                    }
                  >
                    {log.status === 'SUCCESS' ? tr('common.success') : tr('common.failed')}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{money(log.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('admin.overview.recentEmpty')} icon={<History />} />
        )}
      </Section>
    </main>
  );
}

function GatewayAdminAccounts(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as {
    accounts?: z.infer<typeof adminAccountsSchema>;
    prices?: z.infer<typeof adminPricesSchema>;
  };
  const accounts = data.accounts?.accounts ?? [];
  const prices = data.prices?.prices ?? [];

  return (
    <div className="grid gap-6">
      <PageHeader title={tr('admin.accounts.title')} />
      <Section
        icon={<Server />}
        title={tr('admin.accounts.poolTitle')}
        description={tr('admin.accounts.poolDescription')}
        action={
          <Button
            type="button"
            nativeButton={false}
            render={<Link href="/admin/plugin/llm-gateway/accounts/new" />}
          >
            <Plus className="size-4" />
            {tr('admin.accounts.addAccount')}
          </Button>
        }
      >
        {accounts.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {accounts.map((account) => {
              const models = asStringArray(account.models);
              return (
                <li
                  key={account.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 text-sm"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {account.name}
                      <span
                        className={
                          account.status === 'ACTIVE'
                            ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                            : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                        }
                      >
                        {account.status === 'ACTIVE' ? tr('common.enabled') : tr('common.disabled')}
                      </span>
                      <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        {protocolLabel(account.provider)}
                      </span>
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {account.baseUrl}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tr('admin.accounts.meta', {
                        models: models.length
                          ? tr('admin.accounts.modelCount', { count: models.length })
                          : tr('admin.accounts.allModels'),
                        priority: account.priority,
                        weight: account.weight,
                        concurrency: account.maxConcurrency || '∞',
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={
                        <Link href={`/admin/plugin/llm-gateway/accounts/${account.id}/edit`} />
                      }
                    >
                      <Pencil className="size-3.5" />
                      {tr('common.edit')}
                    </Button>
                    <form action={props.actions['llm-gateway.set-account-status']}>
                      <input type="hidden" name="id" value={account.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={account.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        {account.status === 'ACTIVE' ? tr('common.disabled') : tr('common.enabled')}
                      </Button>
                    </form>
                    <form action={props.actions['llm-gateway.delete-account']}>
                      <input type="hidden" name="id" value={account.id} />
                      <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty text={tr('admin.accounts.empty')} icon={<Server />} />
        )}
      </Section>

      <Section
        icon={<Tags />}
        title={tr('admin.accounts.pricingTitle')}
        description={tr('admin.accounts.pricingDescription')}
        action={
          <Button
            type="button"
            nativeButton={false}
            render={<Link href="/admin/plugin/llm-gateway/prices/new" />}
          >
            <Plus className="size-4" />
            {tr('admin.accounts.addPrice')}
          </Button>
        }
      >
        {prices.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {prices.map((price) => (
              <li
                key={price.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 text-sm"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {price.model}
                    {price.upstreamModel && price.upstreamModel !== price.model ? (
                      <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        {tr('admin.accounts.upstreamBadge', { model: price.upstreamModel })}
                      </span>
                    ) : null}
                    <span
                      className={
                        price.enabled
                          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                          : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                      }
                    >
                      {price.enabled ? tr('common.enabled') : tr('common.disabled')}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {tr('admin.accounts.priceMeta', {
                      input: money(price.inputPrice),
                      output: money(price.outputPrice),
                      cacheRead: price.cacheReadPrice ? money(price.cacheReadPrice) : '—',
                      cacheWrite: price.cacheWritePrice ? money(price.cacheWritePrice) : '—',
                    })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {price.capabilities.length
                      ? price.capabilities.map((item) => capabilityLabel(item, tr)).join(' / ')
                      : '—'}{' '}
                    · {tr('admin.accounts.priceMultiplier', { multiplier: price.multiplier })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/admin/plugin/llm-gateway/prices/${price.id}/edit`} />}
                  >
                    <Pencil className="size-3.5" />
                    {tr('common.edit')}
                  </Button>
                  <form action={props.actions['llm-gateway.delete-price']}>
                    <input type="hidden" name="id" value={price.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('admin.accounts.priceEmpty')} icon={<Tags />} />
        )}
      </Section>
    </div>
  );
}

function GatewayAdminPriceEditor(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as {
    prices?: z.infer<typeof adminPricesSchema>;
    accounts?: z.infer<typeof adminAccountsSchema>;
  };
  const priceId = props.params?.id;
  const editing = priceId
    ? ((data.prices?.prices ?? []).find((price) => price.id === priceId) ?? null)
    : null;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [upstreamModel, setUpstreamModel] = useState(editing?.upstreamModel ?? '');
  const [models, setModels] = useState<string[]>(() =>
    Array.from(
      new Set((data.accounts?.accounts ?? []).flatMap((account) => asStringArray(account.models))),
    ).sort(),
  );
  const router = useRouter();
  const saveAction = props.actions['llm-gateway.save-price'];

  async function loadCatalog() {
    setLoadingCatalog(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins/llm-gateway/admin/upstream-model-catalog', {
        headers: { accept: 'application/json' },
      });
      const json = (await response.json().catch(() => null)) as {
        models?: unknown;
      } | null;
      if (!response.ok || !json || !Array.isArray(json.models))
        throw new Error(tr('common.fetchFailedStatus', { status: response.status }));
      const next = json.models.filter((item): item is string => typeof item === 'string');
      if (!next.length) throw new Error(tr('common.noUpstreamModels'));
      setModels((current) => Array.from(new Set([...current, ...next])).sort());
    } catch (cause) {
      setError(failure(cause, tr('common.fetchFailed')));
    } finally {
      setLoadingCatalog(false);
    }
  }

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        backHref="/admin/plugin/llm-gateway/accounts"
        backLabel={tr('admin.editor.backToAccounts')}
        title={priceId ? tr('admin.editor.priceTitleEdit') : tr('admin.editor.priceTitleNew')}
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push('/admin/plugin/llm-gateway/accounts')}
              disabled={saving}
            >
              {tr('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="gateway-price-form"
              disabled={saving || Boolean(priceId && !editing)}
            >
              {saving ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {saving ? tr('common.saving') : tr('admin.editor.savePrice')}
            </Button>
          </>
        }
      />
      {priceId && !editing ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tr('admin.editor.priceMissing')}
        </p>
      ) : (
        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <form
            id="gateway-price-form"
            key={editing?.id ?? 'new'}
            onSubmit={async (event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              if (saving) return;
              setSaving(true);
              setError(null);
              try {
                await saveAction(formData);
                router.push('/admin/plugin/llm-gateway/accounts');
                router.refresh();
              } catch (cause) {
                setError(failure(cause, tr('common.saveFailed')));
              } finally {
                setSaving(false);
              }
            }}
            className="flex min-w-0 flex-col gap-6"
          >
            {editing ? (
              <input type="hidden" name="enabled" value={String(editing.enabled)} />
            ) : null}
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.modelConfig')}</SectionTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <Label htmlFor="price-model-page">{tr('admin.editor.userModel')}</Label>
                    <Input
                      id="price-model-page"
                      name="model"
                      required
                      readOnly={editing !== null}
                      defaultValue={editing?.model ?? ''}
                      placeholder={tr('admin.editor.userModelPlaceholder')}
                    />
                    <FieldDescription>{tr('admin.editor.userModelHelp')}</FieldDescription>
                  </Field>
                  <Field>
                    <Label htmlFor="price-upstream-page">{tr('admin.editor.upstreamModel')}</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="price-upstream-page"
                        name="upstreamModel"
                        list="upstream-model-options-page"
                        value={upstreamModel}
                        onChange={(event) => setUpstreamModel(event.target.value)}
                        placeholder={tr('admin.editor.upstreamModelPlaceholder')}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void loadCatalog()}
                        disabled={loadingCatalog}
                      >
                        <RefreshCw
                          data-icon="inline-start"
                          className={loadingCatalog ? 'animate-spin' : undefined}
                        />
                        {tr('admin.editor.fetchFromUpstream')}
                      </Button>
                    </div>
                    <datalist id="upstream-model-options-page">
                      {models.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.billingSettings')}</SectionTitle>
                <CardDescription>{tr('admin.editor.billingUnit')}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <div className="grid gap-5 sm:grid-cols-2">
                    {(
                      [
                        ['inputPrice', 'admin.editor.inputPrice', editing?.inputPrice ?? 0],
                        ['outputPrice', 'admin.editor.outputPrice', editing?.outputPrice ?? 0],
                        [
                          'cacheReadPrice',
                          'admin.editor.cacheReadPrice',
                          editing?.cacheReadPrice ?? 0,
                        ],
                        [
                          'cacheWritePrice',
                          'admin.editor.cacheWritePrice',
                          editing?.cacheWritePrice ?? 0,
                        ],
                        ['multiplier', 'admin.editor.multiplier', editing?.multiplier ?? 100],
                      ] as const
                    ).map(([name, labelKey, value]) => (
                      <Field key={name}>
                        <Label htmlFor={`price-${name}-page`}>{tr(labelKey)}</Label>
                        <Input
                          id={`price-${name}-page`}
                          name={name}
                          type="number"
                          min={0}
                          required={name === 'inputPrice' || name === 'outputPrice'}
                          step={1}
                          defaultValue={value}
                        />
                      </Field>
                    ))}
                  </div>
                </FieldGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.capabilities')}</SectionTitle>
              </CardHeader>
              <CardContent>
                <FieldSet>
                  <FieldLegend className="sr-only">{tr('admin.editor.capabilities')}</FieldLegend>
                  <div className="flex flex-wrap gap-x-5 gap-y-3">
                    {CAPABILITY_OPTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="capabilities"
                          value={option.value}
                          defaultChecked={editing?.capabilities.includes(option.value) ?? false}
                          className="size-4 accent-primary"
                        />
                        {tr(option.labelKey)}
                      </label>
                    ))}
                  </div>
                </FieldSet>
              </CardContent>
            </Card>
            {error ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {error}
              </p>
            ) : null}
          </form>
          <Card className="xl:sticky xl:top-24">
            <CardHeader>
              <SectionTitle>{tr('admin.editor.priceNotes')}</SectionTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{tr('admin.editor.priceNotesBody')}</p>
              {editing ? <p className="mt-4 break-all font-mono text-sm">{editing.model}</p> : null}
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

function GatewayAdminAccountEditor(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as { accounts?: z.infer<typeof adminAccountsSchema> };
  const accountId = props.params?.id;
  const editing = accountId
    ? ((data.accounts?.accounts ?? []).find((account) => account.id === accountId) ?? null)
    : null;
  const createAction = props.actions['llm-gateway.create-account'];
  const updateAction = props.actions['llm-gateway.update-account'];
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const returnToList = () => router.push('/admin/plugin/llm-gateway/accounts');
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        backHref="/admin/plugin/llm-gateway/accounts"
        backLabel={tr('admin.editor.backToAccountList')}
        title={editing ? tr('admin.editor.accountTitleEdit') : tr('admin.editor.accountTitleNew')}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={returnToList} disabled={saving}>
              {tr('common.cancel')}
            </Button>
            <Button type="submit" form="gateway-account-form" disabled={saving}>
              {saving ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {saving ? tr('common.saving') : tr('admin.editor.saveAccount')}
            </Button>
          </>
        }
      />
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 rounded-xl border bg-card p-5 sm:p-6">
          <AccountForm
            key={editing?.id ?? 'new'}
            editing={editing}
            createAction={createAction}
            updateAction={updateAction}
            onDone={returnToList}
            onPendingChange={setSaving}
            tr={tr}
          />
        </div>
        <aside className="rounded-xl border bg-card p-5 xl:sticky xl:top-24">
          <SectionTitle>{tr('admin.editor.accountOverview')}</SectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {tr('admin.editor.accountOverviewDescription')}
          </p>
          <dl className="mt-5 flex flex-col gap-4 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{tr('admin.editor.status')}</dt>
              <dd>
                {editing?.status === 'DISABLED' ? tr('common.disabled') : tr('common.enabled')}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{tr('admin.editor.protocol')}</dt>
              <dd>
                {editing ? protocolLabel(editing.provider) : tr('admin.editor.notConfigured')}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{tr('admin.editor.models')}</dt>
              <dd>
                {editing
                  ? asStringArray(editing.models).length || tr('admin.editor.all')
                  : tr('admin.editor.notConfigured')}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </main>
  );
}

function AccountForm({
  editing,
  createAction,
  updateAction,
  onDone,
  onPendingChange,
  tr,
}: {
  editing: AccountRow | null;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
  tr: Translator;
}): ReactElement {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(editing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState(editing?.provider ?? 'openai-chat');
  const [priority, setPriority] = useState(String(editing?.priority ?? 0));
  const [weight, setWeight] = useState(String(editing?.weight ?? 100));
  const [maxConcurrency, setMaxConcurrency] = useState(String(editing?.maxConcurrency ?? 0));
  const [status, setStatus] = useState(editing?.status ?? 'ACTIVE');

  const [selected, setSelected] = useState<string[]>(() => asStringArray(editing?.models));
  const [available, setAvailable] = useState<string[]>(() => asStringArray(editing?.models));
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');
  const [fetching, setFetching] = useState(false);

  const candidates = Array.from(new Set([...available, ...selected])).sort();
  const filtered = query
    ? candidates.filter((model) => model.toLowerCase().includes(query.toLowerCase()))
    : candidates;

  function toggle(model: string) {
    setSelected((current) =>
      current.includes(model) ? current.filter((item) => item !== model) : [...current, model],
    );
  }

  function selectAllVisible() {
    setSelected((current) => Array.from(new Set([...current, ...filtered])).slice(0, MODEL_LIMIT));
  }

  function clearSelected() {
    setSelected([]);
  }

  function addManual() {
    const parts = manual
      .split(/[\s,;，；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    setAvailable((current) => Array.from(new Set([...current, ...parts])).sort());
    setSelected((current) => Array.from(new Set([...current, ...parts])).slice(0, MODEL_LIMIT));
    setManual('');
  }

  async function fetchModels() {
    if (!baseUrl.trim()) {
      setError(tr('admin.editor.missingBaseUrl'));
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError(tr('admin.editor.missingApiKey'));
      return;
    }
    setFetching(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins/llm-gateway/admin/upstream-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          provider,
          ...(editing ? { id: editing.id } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        models?: string[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(json.error ?? tr('common.fetchFailedStatus', { status: response.status }));
      const models = Array.isArray(json.models) ? json.models : [];
      if (models.length === 0) {
        setError(tr('common.noUpstreamModels'));
        return;
      }
      setAvailable((current) => Array.from(new Set([...current, ...models])).sort());
      setSelected(models.slice(0, MODEL_LIMIT));
    } catch (fetchError) {
      setError(failure(fetchError, tr('common.fetchFailed')));
    } finally {
      setFetching(false);
    }
  }

  function submit() {
    if (isPending) return;
    if (!name.trim()) {
      setError(tr('admin.editor.missingName'));
      return;
    }
    if (!baseUrl.trim()) {
      setError(tr('admin.editor.missingBaseUrl'));
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError(tr('admin.editor.missingApiKey'));
      return;
    }
    setError(null);
    const form = new FormData();
    form.set('name', name.trim());
    form.set('baseUrl', baseUrl.trim());
    form.set('provider', provider);
    if (apiKey.trim()) form.set('apiKey', apiKey.trim());
    form.set('priority', String(Math.trunc(Number(priority) || 0)));
    form.set('weight', String(Math.trunc(Number(weight) || 100)));
    form.set('maxConcurrency', String(Math.trunc(Number(maxConcurrency) || 0)));
    for (const model of selected.slice(0, MODEL_LIMIT)) form.append('models', model);

    onPendingChange(true);
    startTransition(async () => {
      try {
        if (editing) {
          form.set('id', editing.id);
          form.set('status', status);
          await updateAction(form);
        } else {
          await createAction(form);
        }
        onDone();
      } catch {
        setError(tr('common.saveFailed'));
      } finally {
        onPendingChange(false);
      }
    });
  }

  return (
    <form
      id="gateway-account-form"
      className="flex flex-col gap-6"
      aria-busy={isPending}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <SectionTitle>{tr('admin.editor.basic')}</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">{tr('admin.editor.basicDescription')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-name">{tr('admin.editor.name')}</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={tr('admin.editor.namePlaceholder')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-base-url">Base URL</Label>
          <Input
            id="account-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={
              provider === 'anthropic'
                ? 'https://api.anthropic.com'
                : provider === 'gemini'
                  ? 'https://generativelanguage.googleapis.com'
                  : 'https://api.openai.com'
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-provider">{tr('admin.editor.provider')}</Label>
          <Select
            id="account-provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            {PROTOCOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">{tr('admin.editor.providerHelp')}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-api-key">{tr('admin.editor.apiKey')}</Label>
          <Input
            id="account-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editing ? tr('admin.editor.apiKeyKeep') : 'sk-...'}
          />
        </div>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-status">{tr('admin.editor.status')}</Label>
            <Select
              id="account-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="ACTIVE">{tr('common.enabled')}</option>
              <option value="DISABLED">{tr('common.disabled')}</option>
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-3 gap-3 sm:col-span-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-priority">{tr('admin.editor.priority')}</Label>
            <Input
              id="account-priority"
              type="number"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-weight">{tr('admin.editor.weight')}</Label>
            <Input
              id="account-weight"
              type="number"
              min={1}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-concurrency">{tr('admin.editor.maxConcurrency')}</Label>
            <Input
              id="account-concurrency"
              type="number"
              min={0}
              value={maxConcurrency}
              onChange={(event) => setMaxConcurrency(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <SectionTitle>{tr('admin.editor.availableModels')}</SectionTitle>
          <p className="text-xs text-muted-foreground">
            {tr('admin.editor.availableModelsHelp', { count: selected.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={clearSelected}>
            {tr('admin.editor.clear')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchModels()}
            disabled={fetching}
          >
            {fetching ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {tr('admin.editor.fetchFromUpstream')}
          </Button>
        </div>
      </div>

      {candidates.length > 0 ? (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr('admin.editor.filterModels')}
                className="pl-8"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={selectAllVisible}>
              {tr('admin.editor.selectAll')}
            </Button>
          </div>
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2">
            {filtered.map((model) => {
              const checked = selected.includes(model);
              return (
                <label
                  key={model}
                  className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    checked
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'bg-background hover:bg-muted'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={checked}
                    onChange={() => toggle(model)}
                  />
                  {model}
                </label>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{tr('admin.editor.modelsEmpty')}</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addManual();
            }
          }}
          placeholder={tr('admin.editor.manualPlaceholder')}
        />
        <Button type="button" variant="outline" size="sm" onClick={addManual}>
          {tr('admin.editor.add')}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export const adminPages = {
  'admin/overview': GatewayAdminOverview,
  'admin/accounts': GatewayAdminAccounts,
  'admin/account-editor': GatewayAdminAccountEditor,
  'admin/price-editor': GatewayAdminPriceEditor,
} as const;
