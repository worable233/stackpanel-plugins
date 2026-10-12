import { defineFrontend } from '@stackpanel/sdk';
import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  FinderProvider,
  FrontendPackage,
} from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import Link from 'next/link';
import {
  Activity,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  History,
  Image as ImageIcon,
  KeyRound,
  Pencil,
  PieChart,
  Plus,
  Search,
  Tags,
  Terminal,
  Trash2,
  Type,
  Wallet,
} from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  PageHeader,
} from '@stackpanel/ui';
import type { z } from 'zod';
import {
  AreaChart,
  Empty,
  IconBadge,
  RANGE_OPTIONS,
  Section,
  Stat,
  USAGE_RANGES,
  adminAccountsSchema,
  adminOverviewSchema,
  adminPricesSchema,
  billingSchema,
  capabilityLabel,
  formatTokens,
  keysSchema,
  modelsText,
  money,
  publicPricesSchema,
  shortTime,
  unitPrice,
  usageSchema,
} from './ui';
import type { UsageRange } from './ui';

/**
 * API 中转（llm-gateway）前端包（服务端 bundle）。
 *
 * - 用户：账户中心「API 中转」——创建/管理密钥、查看用量。
 * - finders：提供账户页与 admin 页所需的数据。
 *
 * 管理端交互页面在 `admin.tsx`（客户端 bundle，构建为 dist/admin.js）。
 */

const finders: Record<string, FinderProvider> = {
  'llmGateway.keys': {
    handler: async (_input, ctx) => ctx.api.get('/llm-gateway/keys', keysSchema),
  },
  'llmGateway.billing': {
    handler: async (_input, ctx) => ctx.api.get('/llm-gateway/billing', billingSchema),
  },
  'llmGateway.prices': {
    handler: async (_input, ctx) => ctx.api.get('/llm-gateway/prices', publicPricesSchema),
  },
  'llmGateway.usage': {
    handler: async (_input, ctx) => ctx.api.get('/llm-gateway/usage', usageSchema),
  },
  'llmGateway.adminOverview': {
    handler: async (_input, ctx) => ctx.api.get('/llm-gateway/admin/overview', adminOverviewSchema),
  },
  'llmGateway.adminAccounts': {
    handler: async (_input, ctx) =>
      ctx.api.get('/llm-gateway/admin/accounts', adminAccountsSchema),
  },
  'llmGateway.adminPrices': {
    handler: async (_input, ctx) => ctx.api.get('/llm-gateway/admin/prices', adminPricesSchema),
  },
};

/* --------------------------------- 用户页 --------------------------------- */

export function GatewayOverviewPage(props: AccountPageComponentProps): ReactElement {
  const data = props.data as {
    billing?: z.infer<typeof billingSchema>;
    usage?: z.infer<typeof usageSchema>;
  };
  const billing = data.billing;
  const usage = data.usage;
  const setBilling = props.actions['llm-gateway.set-billing'];

  // 时间范围与指标都由 URL 驱动（服务端渲染无状态）：
  // ?range=today|7d|30d&metric=cost|tokens
  const range = USAGE_RANGES.includes(props.searchParams['range'] as UsageRange)
    ? (props.searchParams['range'] as UsageRange)
    : '30d';
  const metric = props.searchParams['metric'] === 'tokens' ? 'tokens' : 'cost';
  const active = usage?.ranges[range];
  const series = active?.series ?? [];
  const byModel = active?.byModel ?? [];
  const modelCount = byModel.length;
  const base = '/account/gateway';

  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === range)?.label ?? '';

  const href = (next: { range?: UsageRange; metric?: 'cost' | 'tokens' }): string => {
    const params = new URLSearchParams();
    params.set('range', next.range ?? range);
    params.set('metric', next.metric ?? metric);
    return `${base}?${params.toString()}`;
  };

  const chartTitle = range === 'today' ? '今日用量' : `${rangeLabel}用量`;
  const chartDesc = range === 'today' ? '按小时统计的消费与 token 用量。' : '按天统计的消费与 token 用量。';
  const labelEvery = range === 'today' ? 2 : range === '7d' ? 1 : 3;

  return (
    <main className="space-y-8">
      <PageHeader
        title="概览"
        description="一个地址即可调用多种大模型，按实际用量计费，费用从账户余额扣除。"
        actions={<RangePicker range={range} href={href} />}
      />

      {billing && !billing.enabled ? (
        <form
          action={setBilling}
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-3.5 text-sm"
        >
          <input type="hidden" name="enabled" value="true" />
          <span className="text-amber-700 dark:text-amber-400">
            API 计费尚未开启，开启后才能通过接口调用模型。
          </span>
          <button
            type="submit"
            className="h-9 rounded-lg bg-foreground px-3 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            开启计费
          </button>
        </form>
      ) : null}

      {usage ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="可用余额" value={money(billing?.balance ?? 0)} />
            <Stat label={`${rangeLabel}消费`} value={money(active?.summary.amount ?? 0)} />
            <Stat label={`${rangeLabel}请求`} value={String(active?.summary.requests ?? 0)} />
            <Stat
              label={`${rangeLabel} Token`}
              value={formatTokens(active?.summary.totalTokens ?? 0)}
            />
          </div>

          <Section
            icon={<Activity />}
            title={chartTitle}
            description={chartDesc}
            action={
              <div className="inline-flex rounded-lg border p-0.5 text-sm">
                <Link
                  href={href({ metric: 'cost' })}
                  className={
                    metric === 'cost'
                      ? 'rounded-md bg-primary/10 px-3 py-1 font-medium text-primary'
                      : 'rounded-md px-3 py-1 text-muted-foreground hover:bg-muted'
                  }
                >
                  消费
                </Link>
                <Link
                  href={href({ metric: 'tokens' })}
                  className={
                    metric === 'tokens'
                      ? 'rounded-md bg-primary/10 px-3 py-1 font-medium text-primary'
                      : 'rounded-md px-3 py-1 text-muted-foreground hover:bg-muted'
                  }
                >
                  Token
                </Link>
              </div>
            }
          >
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <AreaChart
                series={series.map((point) =>
                  metric === 'tokens' ? point.tokens : point.amount,
                )}
                labels={series.map((point) => point.label)}
                formatValue={metric === 'tokens' ? formatTokens : money}
                labelEvery={labelEvery}
              />
            </div>
          </Section>

          <Section
            icon={<PieChart />}
            title="按模型用量"
            description={`${rangeLabel}各模型的请求、token 与消费。`}
            action={
              <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground tabular-nums">
                {modelCount} 个模型
              </span>
            }
          >
            {byModel.length ? (
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
                {byModel.map((row) => (
                  <li
                    key={row.model}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{modelLabel(row.model)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {row.requests} 次请求 · {formatTokens(row.tokens)} token
                      </p>
                    </div>
                    <span className="shrink-0 font-mono font-semibold tabular-nums">
                      {money(row.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text={`${rangeLabel}还没有模型用量。`} icon={<PieChart />} />
            )}
          </Section>

          <Section icon={<History />} title="最近用量" description="最近 100 条请求流水。">
            {usage.logs.length ? (
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
                {usage.logs.map((log) => (
                  <li
                    key={log.id}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{modelLabel(log.model)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {shortTime(log.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatTokens(log.totalTokens)} token
                      </span>
                      {log.latencyMs !== null ? (
                        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                          {log.latencyMs}ms
                        </span>
                      ) : null}
                      <span
                        className={
                          log.status === 'SUCCESS'
                            ? 'text-xs text-emerald-600'
                            : 'text-xs text-destructive'
                        }
                      >
                        {log.status === 'SUCCESS' ? '成功' : '失败'}
                      </span>
                      <span className="font-mono font-semibold tabular-nums">
                        {money(log.amount)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="暂无用量记录。" icon={<History />} />
            )}
          </Section>
        </>
      ) : null}
    </main>
  );
}

/**
 * 时间范围选择器：纯 `<details>` 折叠，无 JS。选项是链接，切换后整页重渲染。
 */
function RangePicker({
  range,
  href,
}: {
  range: UsageRange;
  href: (next: { range: UsageRange }) => string;
}): ReactElement {
  const current = RANGE_OPTIONS.find((option) => option.value === range) ?? RANGE_OPTIONS[0];
  return (
    <details className="group relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
        <CalendarDays className="size-4 text-muted-foreground" />
        {current.label}
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-40 rounded-xl border bg-popover p-1 shadow-md">
        {RANGE_OPTIONS.map((option) => {
          const activeOption = option.value === range;
          return (
            <Link
              key={option.value}
              href={href({ range: option.value })}
              className={
                activeOption
                  ? 'flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm font-medium'
                  : 'flex items-center justify-between rounded-lg px-3 py-1.5 text-sm hover:bg-muted/60'
              }
            >
              {option.label}
              {activeOption ? <Check className="size-4 text-primary" /> : null}
            </Link>
          );
        })}
      </div>
    </details>
  );
}

/** 模型定价：搜索 + 行选中 + 右侧详情（全部 URL 驱动，服务端渲染）。 */
export function GatewayPricingPage(props: AccountPageComponentProps): ReactElement {
  const data = props.data as { prices?: z.infer<typeof publicPricesSchema> };
  const prices = data.prices?.prices ?? [];
  const query = (props.searchParams['q'] ?? '').trim().toLowerCase();
  const selectedId = props.searchParams['model'] ?? '';

  // 兜底行 `*` 固定排在最后，避免抢占第一行/默认选中。
  const ordered = [...prices].sort((a, b) => {
    if (a.model === '*') return 1;
    if (b.model === '*') return -1;
    return a.model.localeCompare(b.model);
  });
  const filtered = query
    ? ordered.filter((price) => price.model.toLowerCase().includes(query))
    : ordered;
  // 默认选中第一个真实模型（有兜底行时才退到它）。
  const selected =
    prices.find((price) => price.model === selectedId) ??
    filtered.find((price) => price.model !== '*') ??
    filtered[0] ??
    null;

  const base = '/account/gateway/pricing';

  return (
    <main className="space-y-8">
      <PageHeader
        title="模型定价"
        description="按 token 后付费，单价已含倍率，单位为人民币 / 百万 token（1M）。"
        actions={
          <>
            <form method="get" action={base} className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                name="q"
                defaultValue={props.searchParams['q'] ?? ''}
                placeholder="搜索模型"
                className="h-9 w-56 rounded-lg border bg-background pl-8 pr-3 text-sm outline-none focus-visible:border-ring"
              />
            </form>
            <span className="text-xs text-muted-foreground tabular-nums">共 {prices.length} 个</span>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0">
          {filtered.length ? (
            <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">模型</th>
                    <th className="px-3 py-2">能力</th>
                    <th className="px-3 py-2 whitespace-nowrap">输入 / 1M</th>
                    <th className="px-3 py-2 whitespace-nowrap">输出 / 1M</th>
                    <th className="px-3 py-2 whitespace-nowrap">缓存读 / 1M</th>
                    <th className="px-3 py-2 whitespace-nowrap">缓存写 / 1M</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((price) => {
                    const active = selected?.model === price.model;
                    return (
                      <tr
                        key={price.model}
                        className={
                          active
                            ? 'border-b bg-primary/5 last:border-0'
                            : 'border-b last:border-0'
                        }
                      >
                        <td className="px-3 py-2">
                          <Link
                            href={`${base}?model=${encodeURIComponent(price.model)}${
                              query ? `&q=${encodeURIComponent(query)}` : ''
                            }`}
                            className="font-medium whitespace-nowrap hover:underline"
                          >
                            {modelLabel(price.model)}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <CapabilityIcons value={price.capabilities} />
                        </td>
                        <td className="px-3 py-2 tabular-nums">{money(price.inputPrice)}</td>
                        <td className="px-3 py-2 tabular-nums">{money(price.outputPrice)}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {money(price.cacheReadPrice)}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {money(price.cacheWritePrice)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty text={query ? '没有匹配的模型。' : '暂无可售模型定价。'} icon={<Tags />} />
          )}
        </section>

        <aside className="h-fit lg:sticky lg:top-6">
          {selected ? (
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <IconBadge>
                  <Tags />
                </IconBadge>
                <h2 className="min-w-0 truncate font-semibold">{modelLabel(selected.model)}</h2>
              </div>
              {selected.model === '*' ? (
                <p className="mt-1.5 text-xs text-muted-foreground">未单独定价的模型按此价计费</p>
              ) : (
                <p className="mt-1.5 font-mono text-xs text-muted-foreground">{selected.model}</p>
              )}
              <div className="mt-4">
                <CapabilityIcons value={selected.capabilities} />
              </div>
              <dl className="mt-4 grid gap-2 text-sm">
                <PriceRow label="输入" value={unitPrice(selected.inputPrice)} />
                <PriceRow label="输出" value={unitPrice(selected.outputPrice)} />
                <PriceRow label="缓存读" value={unitPrice(selected.cacheReadPrice)} />
                <PriceRow label="缓存写" value={unitPrice(selected.cacheWritePrice)} />
                <PriceRow label="倍率" value={`${selected.multiplier}%`} />
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                缓存价仅在命中提示缓存时生效；其余输入按「输入」价计。
              </p>
            </div>
          ) : (
            <Empty text="选择左侧模型查看详情。" icon={<Tags />} />
          )}
        </aside>
      </div>
    </main>
  );
}

function PriceRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 border-b pb-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** 兜底行 `*` 的展示名。 */
function modelLabel(model: string): string {
  return model === '*' ? '其他模型（兜底价）' : model;
}

const CAPABILITY_ICONS: Record<string, { icon: typeof Brain; label: string }> = {
  reasoning: { icon: Brain, label: '推理' },
  image: { icon: ImageIcon, label: '图像' },
  pdf: { icon: FileText, label: 'PDF' },
  tools: { icon: Terminal, label: '工具' },
  text: { icon: Type, label: '文本' },
};

/** 能力图标行（无能力时不渲染）。 */
function CapabilityIcons({ value }: { value: string[] }): ReactElement | null {
  if (!value.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((capability) => {
        const entry = CAPABILITY_ICONS[capability];
        const Icon = entry?.icon ?? Type;
        return (
          <span
            key={capability}
            title={entry?.label ?? capabilityLabel(capability)}
            className="inline-flex size-6 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
          >
            <Icon className="size-3.5" />
          </span>
        );
      })}
    </div>
  );
}

/**
 * 「创建密钥」对话框。抽成独立组件以便放进 `PageHeader` 的 actions 槽，
 * 避免把创建入口埋在内容区里。
 */
function CreateKeyDialog({
  action,
}: {
  action: (formData: FormData) => void;
}): ReactElement {
  return (
    <Dialog>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" />
        创建密钥
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建 API 密钥</DialogTitle>
          <DialogDescription>完整密钥仅在创建后展示一次，请及时保存。</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">名称</Label>
            <Input id="key-name" name="name" required placeholder="例如：生产环境" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-models">模型白名单（逗号分隔，留空=不限）</Label>
            <Input id="key-models" name="models" placeholder="gpt-4o-mini" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="key-expires">有效期（天，留空=长期）</Label>
              <Input id="key-expires" name="expiresInDays" type="number" min={1} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="key-rpm">每分钟请求上限（0=不限）</Label>
              <Input id="key-rpm" name="rpmLimit" type="number" min={0} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="key-concurrency">并发上限（0=不限）</Label>
              <Input id="key-concurrency" name="concurrencyLimit" type="number" min={0} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">创建密钥</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * API 计费开关（页面级设置）。服务端表单提交相反状态；
 * 未开启时网关对所有调用返回 403 `billing_disabled`。
 */
function BillingToggle({
  enabled,
  action,
}: {
  enabled: boolean;
  action: (formData: FormData) => void;
}): ReactElement {
  return (
    <form action={action}>
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <Button type="submit" variant={enabled ? 'outline' : 'default'} size="sm">
        {enabled ? '关闭计费' : '开启计费'}
      </Button>
    </form>
  );
}

/** API 密钥：创建、启停、删除。 */
export function GatewayKeysPage(props: AccountPageComponentProps): ReactElement {
  const data = props.data as {
    keys?: z.infer<typeof keysSchema>;
    billing?: z.infer<typeof billingSchema>;
  };
  const keys = data.keys;
  const billing = data.billing;
  const createKey = props.actions['llm-gateway.create-key'];
  const setBilling = props.actions['llm-gateway.set-billing'];

  return (
    <main className="space-y-8">
      <PageHeader
        title="API 密钥"
        description="密钥由平台统一签发，一个账号可创建多把，分别设置模型白名单与限额。完整值仅在创建时展示一次。"
        actions={<CreateKeyDialog action={createKey} />}
      />

      <Section
        icon={<Wallet />}
        title="API 计费"
        description="开启后密钥才能调用模型；费用按实际 token 用量从账户余额扣除。"
        action={<BillingToggle enabled={billing?.enabled ?? false} action={setBilling} />}
      >
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          <li className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
            <span className="text-muted-foreground">当前状态</span>
            <span
              className={
                billing?.enabled
                  ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                  : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
              }
            >
              {billing?.enabled ? '已开启' : '未开启'}
            </span>
          </li>
          <li className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
            <span className="text-muted-foreground">可用余额</span>
            <span className="font-mono font-semibold tabular-nums">
              {money(billing?.balance ?? 0)}
            </span>
          </li>
        </ul>
      </Section>

      {keys?.revealedKey ? (
        <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            <IconBadge className="bg-emerald-500/15 text-emerald-600">
              <KeyRound />
            </IconBadge>
            新密钥已生成（仅显示一次，请立即保存）
          </div>
          <code className="mt-3 block break-all rounded-lg bg-background px-3 py-2 font-mono text-sm">
            {keys.revealedKey}
          </code>
        </div>
      ) : null}

      <Section
        icon={<KeyRound />}
        title="我的密钥"
        description="密钥只显示前缀，完整值仅在创建时展示一次。"
      >
        {keys?.keys?.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {keys.keys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 text-sm"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    {key.name}
                    <span
                      className={
                        key.status === 'ACTIVE'
                          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                          : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                      }
                    >
                      {key.status === 'ACTIVE' ? '启用' : '停用'}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{key.keyPrefix}…</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {modelsText(key.models)} · 已用 {money(key.quotaUsed)}
                    {key.quotaLimit !== null ? ` / ${money(key.quotaLimit)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Dialog>
                    <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
                      <Pencil className="size-3.5" />
                      编辑
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-lg">
                      <DialogHeader>
                        <DialogTitle>编辑密钥：{key.name}</DialogTitle>
                        <DialogDescription>
                          修改名称、模型白名单与限额。完整密钥不可再次查看。
                        </DialogDescription>
                      </DialogHeader>
                      <form action={props.actions['llm-gateway.update-key']} className="grid gap-4">
                        <input type="hidden" name="id" value={key.id} />
                        <div className="grid gap-1.5">
                          <Label htmlFor={`key-name-${key.id}`}>名称</Label>
                          <Input
                            id={`key-name-${key.id}`}
                            name="name"
                            required
                            defaultValue={key.name}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`key-models-${key.id}`}>
                            模型白名单（逗号分隔，留空=不限）
                          </Label>
                          <Input
                            id={`key-models-${key.id}`}
                            name="models"
                            defaultValue={key.models.join(', ')}
                          />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="grid gap-1.5">
                            <Label htmlFor={`key-rpm-${key.id}`}>每分钟请求上限（0=不限）</Label>
                            <Input
                              id={`key-rpm-${key.id}`}
                              name="rpmLimit"
                              type="number"
                              min={0}
                              defaultValue={key.rpmLimit}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor={`key-concurrency-${key.id}`}>
                              并发上限（0=不限）
                            </Label>
                            <Input
                              id={`key-concurrency-${key.id}`}
                              name="concurrencyLimit"
                              type="number"
                              min={0}
                              defaultValue={key.concurrencyLimit}
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button type="submit">保存修改</Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                  <form action={props.actions['llm-gateway.update-key']}>
                    <input type="hidden" name="id" value={key.id} />
                    <input
                      type="hidden"
                      name="status"
                      value={key.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}
                    />
                    <Button type="submit" variant="ghost" size="sm">
                      {key.status === 'ACTIVE' ? '停用' : '启用'}
                    </Button>
                  </form>
                  <form action={props.actions['llm-gateway.delete-key']}>
                    <input type="hidden" name="id" value={key.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="还没有密钥，创建一个开始使用。" icon={<KeyRound />} />
        )}
      </Section>
    </main>
  );
}

export function GatewayAccountWidget(_props: AccountWidgetProps): ReactElement {
  return (
    <Link
      href="/account/gateway"
      className="group block rounded-2xl border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Brain className="size-5" />
      </span>
      <p className="mt-4 text-sm font-semibold">大模型 API</p>
      <p className="mt-1.5 text-sm text-muted-foreground">查看用量、模型定价与 API 密钥。</p>
    </Link>
  );
}

/* --------------------------------- 导出 --------------------------------- */

const frontend: FrontendPackage = {
  finders,
  ui: {
    actions: [
      {
        id: 'llm-gateway.set-billing',
        method: 'POST',
        path: '/llm-gateway/billing',
        permission: 'llm-gateway.use',
        input: [{ name: 'enabled', type: 'boolean', required: true }],
      },
      {
        id: 'llm-gateway.create-key',
        method: 'POST',
        path: '/llm-gateway/keys',
        permission: 'llm-gateway.use',
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 64 },
          { name: 'models', type: 'string', maxLength: 500 },
          { name: 'expiresInDays', type: 'integer', min: 1, max: 3650 },
          { name: 'rpmLimit', type: 'integer', min: 0 },
          { name: 'concurrencyLimit', type: 'integer', min: 0 },
        ],
      },
      {
        id: 'llm-gateway.update-key',
        method: 'PATCH',
        path: '/llm-gateway/keys/:id',
        permission: 'llm-gateway.use',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', maxLength: 64 },
          { name: 'status', type: 'string', maxLength: 16 },
          { name: 'models', type: 'string', maxLength: 500 },
          { name: 'rpmLimit', type: 'integer', min: 0 },
          { name: 'concurrencyLimit', type: 'integer', min: 0 },
        ],
      },
      {
        id: 'llm-gateway.delete-key',
        method: 'DELETE',
        path: '/llm-gateway/keys/:id',
        permission: 'llm-gateway.use',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'llm-gateway.create-account',
        method: 'POST',
        path: '/llm-gateway/admin/accounts',
        permission: 'llm-gateway.admin',
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 64 },
          { name: 'baseUrl', type: 'string', required: true, maxLength: 500 },
          { name: 'apiKey', type: 'string', required: true, maxLength: 500 },
          { name: 'provider', type: 'string', maxLength: 32 },
          { name: 'models', type: 'ids', maxLength: 128, max: 500 },
          { name: 'priority', type: 'integer' },
          { name: 'weight', type: 'integer', min: 1 },
          { name: 'maxConcurrency', type: 'integer', min: 0 },
        ],
      },
      {
        id: 'llm-gateway.update-account',
        method: 'PATCH',
        path: '/llm-gateway/admin/accounts/:id',
        permission: 'llm-gateway.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', maxLength: 64 },
          { name: 'baseUrl', type: 'string', maxLength: 500 },
          { name: 'apiKey', type: 'string', maxLength: 500 },
          { name: 'provider', type: 'string', maxLength: 32 },
          { name: 'models', type: 'ids', maxLength: 128, max: 500 },
          { name: 'priority', type: 'integer' },
          { name: 'weight', type: 'integer', min: 1 },
          { name: 'maxConcurrency', type: 'integer', min: 0 },
          { name: 'status', type: 'string', maxLength: 16 },
        ],
      },
      {
        id: 'llm-gateway.set-account-status',
        method: 'PATCH',
        path: '/llm-gateway/admin/accounts/:id',
        permission: 'llm-gateway.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'status', type: 'string', required: true, maxLength: 16 },
        ],
      },
      {
        id: 'llm-gateway.delete-account',
        method: 'DELETE',
        path: '/llm-gateway/admin/accounts/:id',
        permission: 'llm-gateway.admin',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'llm-gateway.save-price',
        method: 'POST',
        path: '/llm-gateway/admin/prices',
        permission: 'llm-gateway.admin',
        input: [
          { name: 'model', type: 'string', required: true, maxLength: 128 },
          { name: 'upstreamModel', type: 'string', maxLength: 128 },
          { name: 'inputPrice', type: 'integer', required: true, min: 0 },
          { name: 'outputPrice', type: 'integer', required: true, min: 0 },
          { name: 'cacheReadPrice', type: 'integer', min: 0 },
          { name: 'cacheWritePrice', type: 'integer', min: 0 },
          { name: 'capabilities', type: 'ids', maxLength: 32, max: 8 },
          { name: 'multiplier', type: 'integer', min: 0 },
          { name: 'enabled', type: 'boolean' },
        ],
      },
      {
        id: 'llm-gateway.delete-price',
        method: 'DELETE',
        path: '/llm-gateway/admin/prices/:id',
        permission: 'llm-gateway.admin',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/overview',
        permission: 'llm-gateway.admin',
        nav: { label: 'API 中转', group: '商店插件' },
        data: [{ finder: 'llmGateway.adminOverview', as: 'overview' }],
      },
      {
        path: '/accounts',
        component: 'admin/accounts',
        permission: 'llm-gateway.admin',
        nav: { label: '中转账号与定价', group: '商店插件' },
        data: [
          { finder: 'llmGateway.adminAccounts', as: 'accounts' },
          { finder: 'llmGateway.adminPrices', as: 'prices' },
        ],
      },
    ],
    accountRoutes: [
      {
        path: '/gateway',
        component: 'account/gateway-overview',
        permission: 'llm-gateway.use',
        nav: { label: '概览', group: '大模型' },
        data: [
          { finder: 'llmGateway.billing', as: 'billing' },
          { finder: 'llmGateway.usage', as: 'usage' },
        ],
      },
      {
        path: '/gateway/pricing',
        component: 'account/gateway-pricing',
        permission: 'llm-gateway.use',
        nav: { label: '模型定价', group: '大模型' },
        data: [{ finder: 'llmGateway.prices', as: 'prices' }],
      },
      {
        path: '/gateway/keys',
        component: 'account/gateway-keys',
        permission: 'llm-gateway.use',
        nav: { label: 'API 密钥', group: '大模型' },
        data: [
          { finder: 'llmGateway.billing', as: 'billing' },
          { finder: 'llmGateway.keys', as: 'keys' },
        ],
      },
    ],
    accountWidgets: [
      {
        id: 'llm-gateway',
        title: 'API 中转',
        component: 'account/gateway',
        permission: 'llm-gateway.use',
      },
    ],
    accountPages: {
      'account/gateway-overview': GatewayOverviewPage,
      'account/gateway-pricing': GatewayPricingPage,
      'account/gateway-keys': GatewayKeysPage,
    },
    accountWidgetComponents: { 'account/gateway': GatewayAccountWidget },
  },
};

export default defineFrontend(frontend);
