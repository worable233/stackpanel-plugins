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

const MODEL_LIMIT = 500;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function GatewayAdminOverview(props: AdminPageComponentProps): ReactElement {
  const data = props.data as { overview?: z.infer<typeof adminOverviewSchema> };
  const overview = data.overview;
  return (
    <main className="space-y-8">
      <PageHeader title="概览" />
      {overview ? (
        <Stats
          items={[
            { label: '上游账号', value: String(overview.accounts) },
            { label: '用户密钥', value: String(overview.keys) },
            { label: '请求数', value: String(overview.summary.requests) },
            { label: '营收', value: money(overview.summary.amount) },
          ]}
        />
      ) : null}

      <Section icon={<TrendingUp />} title="模型消耗 Top 10">
        {overview?.topModels.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {overview.topModels.map((row) => (
              <li
                key={row.model}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
              >
                <span className="min-w-0 truncate font-medium">{row.model}</span>
                <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                  <span className="tabular-nums">{row.requests} 次</span>
                  <span className="hidden tabular-nums sm:inline">{row.totalTokens} token</span>
                  <span className="font-mono text-sm font-semibold text-foreground tabular-nums">
                    {money(row.amount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="暂无数据。" icon={<TrendingUp />} />
        )}
      </Section>

      <Section icon={<History />} title="最近请求" description="最近 100 条请求流水。">
        {overview?.logs.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {overview.logs.map((log) => (
              <li
                key={log.id}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{log.model}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{shortTime(log.createdAt)}</p>
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
                    {log.status === 'SUCCESS' ? '成功' : '失败'}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{money(log.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="暂无请求。" icon={<History />} />
        )}
      </Section>
    </main>
  );
}

function GatewayAdminAccounts(props: AdminPageComponentProps): ReactElement {
  const data = props.data as {
    accounts?: z.infer<typeof adminAccountsSchema>;
    prices?: z.infer<typeof adminPricesSchema>;
  };
  const accounts = data.accounts?.accounts ?? [];
  const prices = data.prices?.prices ?? [];

  return (
    <div className="grid gap-6">
      <PageHeader title="上游账号与定价" />
      <Section
        icon={<Server />}
        title="上游账号池"
        description="每个账号独立配置可用模型；同优先级内按权重随机调度，maxConcurrency 为 0 表示不限并发。"
        action={
          <Button
            type="button"
            nativeButton={false}
            render={<Link href="/admin/plugin/llm-gateway/accounts/new" />}
          >
            <Plus className="size-4" />
            新增账号
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
                        {account.status === 'ACTIVE' ? '启用' : '停用'}
                      </span>
                      <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        {protocolLabel(account.provider)}
                      </span>
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {account.baseUrl}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {models.length ? `${models.length} 个模型` : '全部模型'} · 优先级{' '}
                      {account.priority} · 权重 {account.weight} · 并发{' '}
                      {account.maxConcurrency || '∞'}
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
                      编辑
                    </Button>
                    <form action={props.actions['llm-gateway.set-account-status']}>
                      <input type="hidden" name="id" value={account.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={account.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        {account.status === 'ACTIVE' ? '停用' : '启用'}
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
          <Empty text="还没有上游账号。点击右上角「新增账号」添加一个。" icon={<Server />} />
        )}
      </Section>

      <Section
        icon={<Tags />}
        title="模型定价"
        description="用户模型名可自定义，并可绑定到上游真实存在的模型；价格为「分 / 百万 token」，model 填 * 作为兜底价。缓存价留 0 表示按输入价计，倍率 100 = 1x。能力标记用于用户端展示。"
        action={
          <Button
            type="button"
            nativeButton={false}
            render={<Link href="/admin/plugin/llm-gateway/prices/new" />}
          >
            <Plus className="size-4" />
            新增定价
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
                        → 上游 {price.upstreamModel}
                      </span>
                    ) : null}
                    <span
                      className={
                        price.enabled
                          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                          : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                      }
                    >
                      {price.enabled ? '启用' : '停用'}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    输入 {money(price.inputPrice)} · 输出 {money(price.outputPrice)} · 缓存读{' '}
                    {price.cacheReadPrice ? money(price.cacheReadPrice) : '—'} · 缓存写{' '}
                    {price.cacheWritePrice ? money(price.cacheWritePrice) : '—'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {price.capabilities.length
                      ? price.capabilities.map((item) => capabilityLabel(item)).join(' / ')
                      : '—'}{' '}
                    · 倍率 {price.multiplier}%
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
                    编辑
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
          <Empty text="还没有定价。添加一条开始计费。" icon={<Tags />} />
        )}
      </Section>
    </div>
  );
}

function GatewayAdminPriceEditor(props: AdminPageComponentProps): ReactElement {
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
        throw new Error(`拉取失败（${response.status}）`);
      const next = json.models.filter((item): item is string => typeof item === 'string');
      if (!next.length) throw new Error('上游未返回任何模型');
      setModels((current) => Array.from(new Set([...current, ...next])).sort());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '拉取失败');
    } finally {
      setLoadingCatalog(false);
    }
  }

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        backHref="/admin/plugin/llm-gateway/accounts"
        backLabel="返回账号与定价"
        title={priceId ? '编辑模型定价' : '新增模型定价'}
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push('/admin/plugin/llm-gateway/accounts')}
              disabled={saving}
            >
              取消
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
              {saving ? '保存中…' : '保存定价'}
            </Button>
          </>
        }
      />
      {priceId && !editing ? (
        <p role="alert" className="text-sm text-muted-foreground">
          该模型定价不存在或已被删除，请返回列表。
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
                setError(cause instanceof Error ? cause.message : '保存失败，请重试');
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
                <SectionTitle>模型配置</SectionTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <Label htmlFor="price-model-page">用户模型名（对外展示 / 调用）</Label>
                    <Input
                      id="price-model-page"
                      name="model"
                      required
                      readOnly={editing !== null}
                      defaultValue={editing?.model ?? ''}
                      placeholder="例如 deepseek-chat 或 *"
                    />
                    <FieldDescription>填 * 作为兜底价；编辑时模型名不可修改。</FieldDescription>
                  </Field>
                  <Field>
                    <Label htmlFor="price-upstream-page">绑定上游模型（实际转发）</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="price-upstream-page"
                        name="upstreamModel"
                        list="upstream-model-options-page"
                        value={upstreamModel}
                        onChange={(event) => setUpstreamModel(event.target.value)}
                        placeholder="留空 = 与用户模型名相同"
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
                        从上游拉取
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
                <SectionTitle>计费设置</SectionTitle>
                <CardDescription>价格单位为分 / 百万 token。</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <div className="grid gap-5 sm:grid-cols-2">
                    {(
                      [
                        ['inputPrice', '输入价（分 / 1M token）', editing?.inputPrice ?? 0],
                        ['outputPrice', '输出价（分 / 1M token）', editing?.outputPrice ?? 0],
                        [
                          'cacheReadPrice',
                          '缓存读价（分 / 1M，0=按输入价）',
                          editing?.cacheReadPrice ?? 0,
                        ],
                        [
                          'cacheWritePrice',
                          '缓存写价（分 / 1M，0=按输入价）',
                          editing?.cacheWritePrice ?? 0,
                        ],
                        ['multiplier', '倍率（%）', editing?.multiplier ?? 100],
                      ] as const
                    ).map(([name, label, value]) => (
                      <Field key={name}>
                        <Label htmlFor={`price-${name}-page`}>{label}</Label>
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
                <SectionTitle>模型能力</SectionTitle>
              </CardHeader>
              <CardContent>
                <FieldSet>
                  <FieldLegend className="sr-only">模型能力</FieldLegend>
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
                        {option.label}
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
              <SectionTitle>定价说明</SectionTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                倍率 100% 表示原价。缓存价格设为 0
                时按输入价计费。修改仅影响后续请求，不改变历史账单。
              </p>
              {editing ? <p className="mt-4 break-all font-mono text-sm">{editing.model}</p> : null}
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

function GatewayAdminAccountEditor(props: AdminPageComponentProps): ReactElement {
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
        backLabel="返回账号列表"
        title={editing ? '编辑账号' : '新增上游账号'}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={returnToList} disabled={saving}>
              取消
            </Button>
            <Button type="submit" form="gateway-account-form" disabled={saving}>
              {saving ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {saving ? '保存中…' : '保存账号'}
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
          />
        </div>
        <aside className="rounded-xl border bg-card p-5 xl:sticky xl:top-24">
          <SectionTitle>账号概览</SectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">配置完成后用于模型请求转发。</p>
          <dl className="mt-5 flex flex-col gap-4 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">状态</dt>
              <dd>{editing?.status === 'DISABLED' ? '停用' : '启用'}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">协议</dt>
              <dd>{editing ? protocolLabel(editing.provider) : '待配置'}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">模型</dt>
              <dd>{editing ? asStringArray(editing.models).length || '全部' : '待配置'}</dd>
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
}: {
  editing: AccountRow | null;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
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
      setError('请先填写 Base URL');
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError('请先填写上游 API Key');
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
      if (!response.ok) throw new Error(json.error ?? `拉取失败（${response.status}）`);
      const models = Array.isArray(json.models) ? json.models : [];
      if (models.length === 0) {
        setError('上游未返回任何模型');
        return;
      }
      setAvailable((current) => Array.from(new Set([...current, ...models])).sort());
      setSelected(models.slice(0, MODEL_LIMIT));
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '拉取失败');
    } finally {
      setFetching(false);
    }
  }

  function submit() {
    if (isPending) return;
    if (!name.trim()) {
      setError('请填写名称');
      return;
    }
    if (!baseUrl.trim()) {
      setError('请填写 Base URL');
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError('请填写上游 API Key');
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
        setError('保存失败，请重试');
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
        <SectionTitle>基础配置</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">填写上游连接信息和调度参数。</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-name">名称</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="OpenAI 主账号"
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
          <Label htmlFor="account-provider">上游协议</Label>
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
          <p className="text-xs text-muted-foreground">
            入口协议不同时会自动做协议转换；同协议优先直通。
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-api-key">上游 API Key</Label>
          <Input
            id="account-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editing ? '留空则保持原密钥' : 'sk-...'}
          />
        </div>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-status">状态</Label>
            <Select
              id="account-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="ACTIVE">启用</option>
              <option value="DISABLED">停用</option>
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-3 gap-3 sm:col-span-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-priority">优先级</Label>
            <Input
              id="account-priority"
              type="number"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-weight">权重</Label>
            <Input
              id="account-weight"
              type="number"
              min={1}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-concurrency">最大并发（0=不限）</Label>
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
          <SectionTitle>可用模型</SectionTitle>
          <p className="text-xs text-muted-foreground">
            留空表示不限制；已选 {selected.length} 个。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={clearSelected}>
            清空
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
            从上游拉取
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
                placeholder="筛选模型"
                className="pl-8"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={selectAllVisible}>
              全选
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
        <p className="text-xs text-muted-foreground">
          还没有模型清单。填好 Base URL / API Key 后点「从上游拉取」，或直接手动添加。
        </p>
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
          placeholder="手动添加模型（逗号分隔）"
        />
        <Button type="button" variant="outline" size="sm" onClick={addManual}>
          添加
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
