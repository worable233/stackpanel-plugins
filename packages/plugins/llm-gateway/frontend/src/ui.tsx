import type { ReactElement, ReactNode } from 'react';
import { SectionTitle } from '@stackpanel/ui';
import { Boxes } from 'lucide-react';
import { z } from 'zod';

/**
 * llm-gateway 前端共享层。
 *
 * 被两个入口复用：
 * - `index.tsx`（服务端前端包：finders / 用户账户页）
 * - `admin.tsx`（客户端管理页：交互式 admin 组件）
 *
 * 这里只放纯展示件、格式化函数与 zod schema，禁止 React hooks，
 * 以保证既可进 Node 服务端 bundle，也可进浏览器客户端 bundle。
 */

/* --------------------------------- schema -------------------------------- */

export const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  status: z.string(),
  models: z.array(z.string()),
  rpmLimit: z.number(),
  concurrencyLimit: z.number(),
  quotaLimit: z.number().nullable(),
  quotaUsed: z.number(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const keysSchema = z.object({
  revealedKey: z.string().nullable(),
  keys: z.array(keySchema),
});

export const usageLogSchema = z.object({
  id: z.string(),
  model: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  amount: z.number(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  createdAt: z.string(),
});

export const modelUsageSchema = z.object({
  model: z.string(),
  amount: z.number(),
  tokens: z.number(),
  requests: z.number(),
});

export const usagePointSchema = z.object({
  /** X 轴标签：今日为 `0:00`，按天为 `9/28`。 */
  label: z.string(),
  amount: z.number(),
  tokens: z.number(),
});

export const rangeUsageSchema = z.object({
  summary: z.object({
    requests: z.number(),
    amount: z.number(),
    totalTokens: z.number(),
  }),
  /** 按时间聚合的曲线数据。 */
  series: z.array(usagePointSchema).default([]),
  /** 按模型聚合并按消费降序。 */
  byModel: z.array(modelUsageSchema).default([]),
});

export const USAGE_RANGES = ['today', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const usageSchema = z.object({
  ranges: z.object({
    today: rangeUsageSchema,
    '7d': rangeUsageSchema,
    '30d': rangeUsageSchema,
  }),
  logs: z.array(usageLogSchema),
});

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string(),
  models: z.unknown(),
  status: z.string(),
  priority: z.number(),
  weight: z.number(),
  maxConcurrency: z.number(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  /** 额外 key 元数据（A1）：只含 id/label/weight，永不回显 secret。 */
  keys: z.array(z.object({ id: z.string(), label: z.string(), weight: z.number() })).default([]),
  keyCount: z.number().default(1),
  /** 上游余额快照（A2）；null = 未探测 / 该厂商不支持。 */
  balance: z.number().nullable().default(null),
  balanceCurrency: z.string().default(''),
  balanceUpdatedAt: z.string().nullable().default(null),
  /** 最近一次上游失败摘要（自动摘号证据，A7）。 */
  lastError: z.string().nullable().default(null),
  lastErrorAt: z.string().nullable().default(null),
});

/** 上游协议选项（与后端 PROTOCOLS 对齐）。 */
export const PROTOCOL_OPTIONS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'gemini', label: 'Google Gemini' },
] as const;

/**
 * 概览页时间范围选项。
 *
 * Labels are message ids resolved against the package catalog by the caller, so
 * the shared layer stays free of a translator instance and can live in both the
 * server and client bundles.
 */
export const RANGE_OPTIONS = [
  { value: 'today', labelKey: 'common.rangeToday' },
  { value: '7d', labelKey: 'common.range7d' },
  { value: '30d', labelKey: 'common.range30d' },
] as const;

export function protocolLabel(value: string): string {
  return PROTOCOL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/** 模型能力标记（自由文本，与后端 capabilities 对齐）。 */
export const CAPABILITY_OPTIONS = [
  { value: 'reasoning', labelKey: 'capability.reasoning' },
  { value: 'image', labelKey: 'capability.image' },
  { value: 'pdf', labelKey: 'capability.pdf' },
  { value: 'tools', labelKey: 'capability.tools' },
  { value: 'text', labelKey: 'capability.text' },
] as const;

export function capabilityLabel(value: string, tr: Translator): string {
  const key = CAPABILITY_OPTIONS.find((option) => option.value === value)?.labelKey;
  return key ? tr(key) : value;
}

/** Package translator shape (`createPackageTranslator`), kept structural here. */
export type Translator = (key: string, params?: Record<string, string | number>) => string;

export function rangeLabel(value: UsageRange, tr: Translator): string {
  const key = RANGE_OPTIONS.find((option) => option.value === value)?.labelKey;
  return key ? tr(key) : '';
}

/** The fallback row `*` display name. */
export function modelDisplayName(model: string, tr: Translator): string {
  return model === '*' ? tr('pricing.fallbackModel') : model;
}

export const priceSchema = z.object({
  id: z.string(),
  model: z.string(),
  /** 实际转发上游的模型名；空串表示与 `model` 相同。 */
  upstreamModel: z.string().default(''),
  inputPrice: z.number(),
  outputPrice: z.number(),
  cacheReadPrice: z.number(),
  cacheWritePrice: z.number(),
  /** 成本价（A3）：只用于毛利核算。 */
  costInputPrice: z.number().default(0),
  costOutputPrice: z.number().default(0),
  costCacheReadPrice: z.number().default(0),
  costCacheWritePrice: z.number().default(0),
  /** 该模型输出上限（token），用于预授权估算（A8）。 */
  maxOutputTokens: z.number().default(0),
  /** 是否叠加用户权限组折扣（A4）。 */
  groupDiscount: z.boolean().default(true),
  /** 计费模式（B2）：flat / tiered / expr；空串 = 自动推断。 */
  strategy: z.string().default(''),
  /** 受限算术表达式（B2）。 */
  expr: z.string().default(''),
  /** 阶梯价（A4）：按输入 token 选阶，未填字段继承基础价。 */
  tiers: z
    .array(
      z.object({
        from: z.number(),
        inputPrice: z.number().optional(),
        outputPrice: z.number().optional(),
        cacheReadPrice: z.number().optional(),
        cacheWritePrice: z.number().optional(),
        reasoningPrice: z.number().optional(),
      }),
    )
    .default([]),
  /** 时段价（峰谷）：按请求到达时刻命中第一个窗口。 */
  windows: z
    .array(
      z.object({
        timezone: z.string().default(''),
        weekdays: z.array(z.number()).default([]),
        hours: z.string(),
        percent: z.number().default(0),
        inputPrice: z.number().optional(),
        outputPrice: z.number().optional(),
        cacheReadPrice: z.number().optional(),
        cacheWritePrice: z.number().optional(),
        reasoningPrice: z.number().optional(),
        costInputPrice: z.number().optional(),
        costOutputPrice: z.number().optional(),
        costCacheReadPrice: z.number().optional(),
        costCacheWritePrice: z.number().optional(),
      }),
    )
    .default([]),
  /** 公开参考价（minor/百万 token）：只给管理员对照，不参与计费。 */
  refInputPrice: z.number().default(0),
  refOutputPrice: z.number().default(0),
  refCacheReadPrice: z.number().default(0),
  refSource: z.string().default(''),
  refFetchedAt: z.string().default(''),
  multiplier: z.number(),
  capabilities: z.array(z.string()),
  enabled: z.boolean(),
});

export const adminOverviewSchema = z.object({
  accounts: z.number(),
  keys: z.number(),
  summary: z.object({
    requests: z.number(),
    amount: z.number(),
    totalTokens: z.number(),
    /** 成本与毛利（A3）；旧数据没有坐标时为 0。 */
    cost: z.number().default(0),
    margin: z.number().default(0),
    /** 成本覆盖率（已填成本价的请求占比）。 */
    costCoverage: z.number().default(1),
    /** 应用了权限组折扣的请求数。 */
    discounted: z.number().default(0),
  }),
  topModels: z.array(
    z.object({
      model: z.string(),
      requests: z.number(),
      amount: z.number(),
      totalTokens: z.number(),
    }),
  ),
  logs: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      totalTokens: z.number(),
      amount: z.number(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const adminUsageLogRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  apiKeyId: z.string(),
  accountId: z.string().nullable().default(null),
  upstreamKeyId: z.string().default(''),
  model: z.string(),
  protocol: z.string(),
  endpoint: z.string(),
  totalTokens: z.number(),
  amount: z.number(),
  costAmount: z.number().default(0),
  discountPercent: z.number().default(0),
  status: z.string(),
  estimated: z.boolean().default(false),
  aborted: z.boolean().default(false),
  httpStatus: z.number().nullable().default(null),
  latencyMs: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const adminUsageLogsSchema = z.object({
  logs: z.array(adminUsageLogRowSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export const adminAccountsSchema = z.object({ accounts: z.array(accountSchema) });
export const adminPricesSchema = z.object({ prices: z.array(priceSchema) });

/* ------------------------------ 运营面（B） ------------------------------ */

export const modelMapSchema = z.object({
  id: z.string(),
  from: z.string(),
  mode: z.string(),
  targets: z.array(z.object({ model: z.string(), weight: z.number() })).default([]),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
  note: z.string().default(''),
});

export const adminModelMapsSchema = z.object({
  maps: z.array(modelMapSchema).default([]),
});

export const budgetLimitSchema = z.object({
  id: z.string(),
  userId: z.string().default(''),
  period: z.string(),
  amountLimit: z.number(),
  warnPercent: z.number().default(80),
  action: z.string().default('warn'),
  enabled: z.boolean().default(true),
});

export const adminBudgetLimitsSchema = z.object({
  limits: z.array(budgetLimitSchema).default([]),
});

export const entitlementSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().default(''),
  source: z.string().default('admin'),
  quotaAmount: z.number(),
  usedAmount: z.number(),
  /** 不限量套餐为 null。 */
  remaining: z.number().nullable().default(null),
  models: z.array(z.string()).default([]),
  startsAt: z.string().default(''),
  expiresAt: z.string().nullable().default(null),
  status: z.string().default('ACTIVE'),
  /** 派生状态（含过期/用尽）。 */
  liveStatus: z.string().default('ACTIVE'),
  priority: z.number().default(0),
  createdAt: z.string().default(''),
});

export const adminEntitlementsSchema = z.object({
  entitlements: z.array(entitlementSchema).default([]),
});

export const billingSchema = z.object({
  enabled: z.boolean(),
  balance: z.number(),
  currency: z.string(),
});

/** 用户可见的模型定价（已把倍率折算进单价，minor / 百万 token）。 */
export const publicPricesSchema = z.object({
  currency: z.string(),
  unitTokens: z.number(),
  prices: z.array(
    z.object({
      model: z.string(),
      inputPrice: z.number(),
      outputPrice: z.number(),
      cacheReadPrice: z.number(),
      cacheWritePrice: z.number(),
      multiplier: z.number(),
      capabilities: z.array(z.string()),
    }),
  ),
});

/** 单位：minor / 百万 token → 「¥x.xx / 百万」。 */
export function unitPrice(minorPerMillion: number, tr: Translator): string {
  return `${money(minorPerMillion)} / ${tr('unit.perMillion')}`;
}

/* -------------------------------- 格式化 -------------------------------- */

export function money(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

export function shortTime(value: string | null, locale: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(locale, { hour12: false });
}

/** 紧凑数字：1200 → 1.2k，3_400_000 → 3.4M。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function modelsText(value: unknown, tr: Translator): string {
  if (Array.isArray(value) && value.length > 0) return value.join(', ');
  return tr('common.unlimited');
}

/* ------------------------------- 通用样式件 ------------------------------ */

/** Small leading icon badge used by section titles and lists. */
export function IconBadge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span
      className={`flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ${className ?? ''}`}
      aria-hidden="true"
    >
      {/* 与 /account/balance 的 Icon 一致：内层用 em 尺寸，图标随标题字号缩放。 */}
      <span className="inline-flex size-[1.15em] shrink-0 items-center justify-center leading-none [&_svg]:size-full">
        {children}
      </span>
    </span>
  );
}

/**
 * A titled content section: optional icon badge + title + description on the
 * left, optional action on the right, then the content. The content is not
 * wrapped in another card — sections compose plain surfaces so cards only
 * appear where they carry meaning.
 */
export function Section({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <SectionTitle icon={icon}>{title}</SectionTitle>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A single metric tile. Top-level surface, never nested inside a card. */
export function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
    </div>
  );
}

export function Empty({ text, icon }: { text: string; icon?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
        {icon ?? <Boxes />}
      </span>
      <p className="mt-3 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export function Stats({ items }: { items: Array<{ label: string; value: string }> }): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => (
        <Stat key={item.label} label={item.label} value={item.value} />
      ))}
    </div>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  defaultValue,
  placeholder,
  required,
  min,
  max,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
}): ReactElement {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        min={min}
        max={max}
        step={step}
        className="h-10 rounded-lg border bg-background px-3 outline-none focus-visible:border-ring"
      />
    </label>
  );
}

/**
 * 内联错误 / 提示条。
 *
 * 宿主 `@stackpanel/ui` 契约中没有这两个组件（其他插件各写各的），客户端
 * admin bundle 又确实需要它们：从 `@stackpanel/ui` 导入会在运行期解析为
 * `undefined`（ABI 适配器按名重导，宿主命名空间缺名），React 直接抛
 * 「Element type is invalid」。因此定义在插件本地，随 bundle 自带。
 */
export function InlineError({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return (
    <p
      role="alert"
      className={`rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive ${className}`.trim()}
    >
      {children}
    </p>
  );
}

export function InlineNotice({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return (
    <p
      className={`rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground ${className}`.trim()}
    >
      {children}
    </p>
  );
}
