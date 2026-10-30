/**
 * 模型名映射（B4）：对外模型名 → 上游模型名。
 *
 * ## 为什么在定价行之外再做一张表
 *
 * 定价行自带 `upstreamModel`（一对一），够用于「对外卖 A、上游叫 B」。真实运营
 * 还需要：
 * - **一对多**：同名对外模型在多个上游账号上分别叫 `gpt-4o-2024-08` /
 *   `gpt-4o` / `azure-gpt4o`，按权重分流；
 * - **前缀/正则**：`claude-3-5-*` 全部映射到一个聚合上游；
 * - 灰度：把 10% 流量导到新上游验证质量。
 *
 * 这里只做「名字解析」这一件事（纯函数），账号选择仍由 `routing.ts`/relay 负责，
 * 两者解耦：映射不会改变权限、计费与限流口径。
 *
 * ## 优先级
 *
 * 1. 定价行显式 `upstreamModel`（管理员对一个模型写的死绑定）最优先；
 * 2. 然后是映射表：`priority` 降序 → 精确 > 前缀（更长优先）> 正则；
 * 3. 都没有 → 原样透传。
 */

export const MODEL_MAP_MODES = ['exact', 'prefix', 'regex'] as const;

export type ModelMapMode = (typeof MODEL_MAP_MODES)[number];

export interface ModelMapTarget {
  /** 上游模型名。 */
  model: string;
  /** 分流权重；<= 0 表示该目标停用。 */
  weight: number;
}

export interface ModelMapRule {
  /** 匹配模式：精确名、前缀、或正则源码。 */
  from: string;
  mode: string;
  /** 命中后的候选上游模型（按权重挑一个）。 */
  targets: ModelMapTarget[];
  /** 越大越先匹配。 */
  priority: number;
  enabled: boolean;
}

/** 模式的特异性排序：数值越小越优先。 */
function modeRank(mode: string): number {
  if (mode === 'exact') return 0;
  if (mode === 'prefix') return 1;
  return 2;
}

/** 该规则是否命中模型名。正则非法视为不命中（写入时应已校验）。 */
export function ruleMatches(rule: ModelMapRule, model: string): boolean {
  if (!rule.enabled) return false;
  if (!rule.from) return false;
  if (rule.mode === 'exact') return rule.from === model;
  if (rule.mode === 'prefix') return model.startsWith(rule.from);
  if (rule.mode === 'regex') {
    try {
      return new RegExp(rule.from).test(model);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 在候选目标里按权重挑一个。
 *
 * `random` 可注入，测试里给定值即可断言分流结果；生产用 `Math.random`。
 * 全部权重 <= 0 时返回 `null`（规则配错了不该静默把请求打到错误的模型上，
 * 调用方据此回退到原模型名）。
 */
export function pickTarget(
  targets: readonly ModelMapTarget[],
  random: () => number = Math.random,
): string | null {
  const usable = targets.filter((target) => target.model && target.weight > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, target) => sum + target.weight, 0);
  let roll = random() * total;
  for (const target of usable) {
    roll -= target.weight;
    if (roll < 0) return target.model;
  }
  // 浮点边界：落到最后一个可用目标。
  return usable[usable.length - 1]?.model ?? null;
}

/**
 * 解析上游模型名。未命中返回 `null`（调用方保留原模型名）。
 */
export function resolveModelMap(
  rules: readonly ModelMapRule[],
  model: string,
  options: { random?: () => number } = {},
): { model: string; rule: ModelMapRule } | null {
  if (!model) return null;
  const matched = rules.filter((rule) => ruleMatches(rule, model));
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const rank = modeRank(a.mode) - modeRank(b.mode);
    if (rank !== 0) return rank;
    // 同模式内，更长的匹配串更具体（`gpt-4` 不如 `gpt-4o` 具体）。
    return b.from.length - a.from.length;
  });
  for (const rule of matched) {
    const target = pickTarget(rule.targets, options.random);
    if (target) return { model: target, rule };
  }
  return null;
}

/** 写入时校验规则（管理端 schema 之外的第二道防线）。 */
export function validateModelMapRule(rule: {
  from: string;
  mode: string;
  targets: readonly ModelMapTarget[];
}): string | null {
  if (!rule.from.trim()) return '匹配串不能为空';
  if (!(MODEL_MAP_MODES as readonly string[]).includes(rule.mode)) {
    return `不支持的匹配模式：${rule.mode}`;
  }
  if (rule.mode === 'regex') {
    try {
      new RegExp(rule.from);
    } catch (error) {
      return `正则不合法：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (rule.targets.length === 0) return '至少需要一个目标模型';
  if (rule.targets.some((target) => !target.model.trim())) return '目标模型名不能为空';
  if (rule.targets.every((target) => !(target.weight > 0))) return '至少一个目标权重要大于 0';
  return null;
}
