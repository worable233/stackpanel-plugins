'use client';

import { useState, useTransition } from 'react';
import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { z } from 'zod';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  Select,
} from '@stackpanel/ui';
import { History, Pencil, Plus, RefreshCw, Search, Server, Tags, Trash2, TrendingUp } from 'lucide-react';
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
  priceSchema,
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
type PriceRow = z.infer<typeof priceSchema>;

const MODEL_LIMIT = 500;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function GatewayAdminOverview(props: AdminPageComponentProps): ReactElement {
  const data = props.data as { overview?: z.infer<typeof adminOverviewSchema> };
  const overview = data.overview;
  return (
    <main className="space-y-8">
      <PageHeader title="API 中转 · 概览" description="近 30 天。" />
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
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {shortTime(log.createdAt)}
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

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [editingPrice, setEditingPrice] = useState<PriceRow | null>(null);
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [upstreamOptions, setUpstreamOptions] = useState<string[]>(() =>
    Array.from(new Set(accounts.flatMap((account) => asStringArray(account.models)))).sort(),
  );

  const createAction = props.actions['llm-gateway.create-account'];
  const updateAction = props.actions['llm-gateway.update-account'];
  const savePriceAction = props.actions['llm-gateway.save-price'];

  async function loadUpstreamCatalog(): Promise<void> {
    setLoadingCatalog(true);
    setPriceError(null);
    try {
      const response = await fetch(
        '/api/plugins/llm-gateway/admin/upstream-model-catalog',
        { headers: { accept: 'application/json' } },
      );
      const json = (await response.json().catch(() => null)) as { models?: unknown } | null;
      if (!response.ok || !json || !Array.isArray(json.models)) {
        setPriceError(`拉取失败（${response.status}）`);
        return;
      }
      const models = json.models.filter((item): item is string => typeof item === 'string');
      if (models.length === 0) {
        setPriceError('上游未返回任何模型');
        return;
      }
      setUpstreamOptions((current) => Array.from(new Set([...current, ...models])).sort());
    } catch {
      setPriceError('拉取失败');
    } finally {
      setLoadingCatalog(false);
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="中转账号与定价"
        description="管理上游账号池与模型定价，账号池用于调度请求，定价决定用户端计费。"
      />
      <Section
        icon={<Server />}
        title="上游账号池"
        description="每个账号独立配置可用模型；同优先级内按权重随机调度，maxConcurrency 为 0 表示不限并发。"
        action={
          <Button
            type="button"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
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
                      onClick={() => {
                        setEditing(account);
                        setOpen(true);
                      }}
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
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                      >
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
            onClick={() => {
              setEditingPrice(null);
              setPriceOpen(true);
            }}
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
                    onClick={() => {
                      setEditingPrice(price);
                      setPriceOpen(true);
                    }}
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

      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingPrice ? `编辑定价：${editingPrice.model}` : '新增定价'}</DialogTitle>
            <DialogDescription>
              用户模型名可自定义（对用户展示与调用），并绑定到上游真实存在的模型。价格为「分 /
              百万 token」；model 填 * 作为兜底价，缓存价留 0 表示按输入价格计。
            </DialogDescription>
          </DialogHeader>
          <form
            key={editingPrice?.id ?? 'new'}
            action={async (formData) => {
              setPriceError(null);
              try {
                await savePriceAction(formData);
                setPriceOpen(false);
              } catch {
                setPriceError('保存失败，请重试');
              }
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="price-model">用户模型名（对外展示 / 调用）</Label>
              <Input
                id="price-model"
                name="model"
                required
                readOnly={editingPrice !== null}
                defaultValue={editingPrice?.model ?? ''}
                placeholder="例如 deepseek-chat 或 *"
                className={editingPrice ? 'bg-muted/40' : undefined}
              />
              <p className="text-xs text-muted-foreground">
                用户在密钥白名单、模型列表与账单里看到的名称。填 * 作为兜底价。
              </p>
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="price-upstream-model">绑定上游模型（实际转发）</Label>
              <div className="flex gap-2">
                <Input
                  id="price-upstream-model"
                  name="upstreamModel"
                  list="upstream-model-options"
                  defaultValue={editingPrice?.upstreamModel ?? ''}
                  placeholder="留空 = 与用户模型名相同"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadUpstreamCatalog()}
                  disabled={loadingCatalog}
                >
                  <RefreshCw className={`size-4 ${loadingCatalog ? 'animate-spin' : ''}`} />
                  从上游拉取
                </Button>
              </div>
              <datalist id="upstream-model-options">
                {upstreamOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                必须填上游账号真实存在的模型名（如 deepseek-v4-flash）。用户调用上面的名称时，网关改写成这里绑定的模型再转发。
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="price-input">输入价（分 / 1M token）</Label>
              <Input
                id="price-input"
                name="inputPrice"
                type="number"
                required
                min={0}
                defaultValue={editingPrice?.inputPrice ?? 0}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="price-output">输出价（分 / 1M token）</Label>
              <Input
                id="price-output"
                name="outputPrice"
                type="number"
                required
                min={0}
                defaultValue={editingPrice?.outputPrice ?? 0}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="price-cache-read">缓存读价（分 / 1M，0=按输入价）</Label>
              <Input
                id="price-cache-read"
                name="cacheReadPrice"
                type="number"
                min={0}
                defaultValue={editingPrice?.cacheReadPrice ?? 0}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="price-cache-write">缓存写价（分 / 1M，0=按输入价）</Label>
              <Input
                id="price-cache-write"
                name="cacheWritePrice"
                type="number"
                min={0}
                defaultValue={editingPrice?.cacheWritePrice ?? 0}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="price-multiplier">倍率（%）</Label>
              <Input
                id="price-multiplier"
                name="multiplier"
                type="number"
                min={0}
                defaultValue={editingPrice?.multiplier ?? 100}
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>模型能力</Label>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {CAPABILITY_OPTIONS.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="capabilities"
                      value={option.value}
                      defaultChecked={editingPrice?.capabilities.includes(option.value) ?? false}
                      className="size-4 rounded border"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
            {priceError ? (
              <p className="text-sm text-destructive sm:col-span-2" role="alert">
                {priceError}
              </p>
            ) : null}
            <DialogFooter className="sm:col-span-2">
              <Button type="submit">{editingPrice ? '保存修改' : '保存定价'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑账号：${editing.name}` : '新增上游账号'}</DialogTitle>
            <DialogDescription>
              每个账号独立配置可用模型，可从上游 API 一键拉取并勾选。
            </DialogDescription>
          </DialogHeader>
          <AccountForm
            key={editing?.id ?? 'new'}
            editing={editing}
            createAction={createAction}
            updateAction={updateAction}
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AccountForm({
  editing,
  createAction,
  updateAction,
  onDone,
}: {
  editing: AccountRow | null;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
  onDone: () => void;
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
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
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

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">可用模型</p>
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
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button type="button" onClick={submit} disabled={isPending}>
          {isPending ? '保存中…' : editing ? '保存修改' : '创建账号'}
        </Button>
      </DialogFooter>
    </div>
  );
}

export const adminPages = {
  'admin/overview': GatewayAdminOverview,
  'admin/accounts': GatewayAdminAccounts,
} as const;
