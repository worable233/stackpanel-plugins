/**
 * 计费模式抽象（B2）：`flat` / `tiered` / `expr`。
 *
 * ## 为什么要表达式
 *
 * 固定单价 + 阶梯价能覆盖 90% 的 token 计费，但覆盖不了：
 * 「首 10 万 token 免费，之后按 0.8 倍价」「图片按 1024×1024 与 512×512 不同价」
 * 「前 3 秒按秒计费、之后按分钟」这类真实报价。new-api 用 JS 表达式解决，
 * 但**执行任意 JS** 等于把管理端的脚本能力塞进请求热路径（原型污染、死循环、
 * 访问 `process`）。这里的取舍是：允许表达式，但只认一个极小的算术语言。
 *
 * ## 允许的语言
 *
 * ```
 * expr    := term (('+' | '-') term)*
 * term    := unary (('*' | '/') unary)*
 * unary   := ('-' | '+') unary | primary
 * primary := number | variable | func '(' expr (',' expr)* ')' | '(' expr ')'
 * ```
 *
 * - 数字：十进制（可带小数），科学计数法不支持（没有业务场景，且更容易写错）。
 * - 变量：{@link EXPR_VARIABLES} 里的白名单，未知标识符在**写入时**就报错。
 * - 函数：{@link EXPR_FUNCTIONS} 里的白名单。
 * - 结果单位为 minor（分）。表达式自己决定乘不乘 `multiplier`，不再二次套倍率。
 *
 * ## 安全边界
 *
 * - 词法/语法阶段就拒绝一切非法字符（没有 `[`、`.`、`;`、`=>`），因此不存在
 *   「借标识符链访问对象」的路径；
 * - 节点数与求值步数都有上限，除法按 0 处理不抛错；
 * - 结果被夹到 `[0, MAX_AMOUNT]`，写错一个量级不会把用户余额扣穿。
 */

/** 表达式可用的变量。 */
export const EXPR_VARIABLES = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'image_count',
  'audio_seconds',
  'multiplier',
] as const;

export type ExprVariable = (typeof EXPR_VARIABLES)[number];

/** 允许的函数：名字 → [最少参数, 最多参数]。 */
export const EXPR_FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
  min: [2, 2],
  max: [2, 2],
  round: [1, 1],
  ceil: [1, 1],
  floor: [1, 1],
  abs: [1, 1],
};

/** 语法树节点上限：防止一个「能跑但极大」的表达式拖慢热路径。 */
export const EXPR_MAX_NODES = 200;
/** 单次求值的最大步数（与节点数同源，留一点函数展开余量）。 */
const EXPR_MAX_STEPS = 2_000;
/** 单次计费金额上限（minor），写错量级的兜底。 */
export const EXPR_MAX_AMOUNT = 100_000_000_000;

export type ExprNode =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: ExprVariable }
  | { kind: 'negate'; operand: ExprNode }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: ExprNode; right: ExprNode }
  | { kind: 'call'; name: string; args: ExprNode[] };

export interface ExprProgram {
  /** 原始表达式（快照里保留，便于事后复算与审计）。 */
  source: string;
  root: ExprNode;
  nodes: number;
}

export type CompileResult = { ok: true; program: ExprProgram } | { ok: false; error: string };

interface Token {
  kind: 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  text: string;
  value?: number;
}

const OPERATORS = new Set(['+', '-', '*', '/']);

/** 词法分析。遇到任何白名单外的字符都直接失败（不做「跳过」）。 */
function tokenize(source: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen', text: char });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen', text: char });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma', text: char });
      index += 1;
      continue;
    }
    if (OPERATORS.has(char)) {
      tokens.push({ kind: 'op', text: char });
      index += 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let end = index;
      let dots = 0;
      while (end < source.length) {
        const next = source[end] as string;
        if (next >= '0' && next <= '9') {
          end += 1;
          continue;
        }
        if (next === '.') {
          dots += 1;
          if (dots > 1) return { ok: false, error: '数字格式不合法（多个小数点）' };
          end += 1;
          continue;
        }
        break;
      }
      const text = source.slice(index, end);
      const value = Number(text);
      if (!Number.isFinite(value)) return { ok: false, error: `数字不合法：${text}` };
      tokens.push({ kind: 'number', text, value });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'ident', text: source.slice(index, end) });
      index = end;
      continue;
    }
    // `[`、`.`、`;`、`$`、引号、中文…… 一律视为非法字符。
    return { ok: false, error: `表达式包含不允许的字符：${JSON.stringify(char)}` };
  }
  return { ok: true, tokens };
}

/**
 * 递归下降语法分析（+ 优先级）。
 *
 * 故意不做「容错解析」：表达式由管理员手写，报错要精确到位置，否则写错了也
 * 只会在第一次真实计费时才暴露。
 */
function parse(
  tokens: Token[],
): { ok: true; root: ExprNode; nodes: number } | { ok: false; error: string } {
  let position = 0;
  let nodes = 0;

  const peek = (): Token | undefined => tokens[position];

  const fail = (message: string): { ok: false; error: string } => ({
    ok: false,
    error: `${message}（第 ${position + 1} 个记号）`,
  });

  function count(node: ExprNode): ExprNode {
    nodes += 1;
    return node;
  }

  function parsePrimary(): ExprNode | string {
    const token = peek();
    if (!token) return '表达式意外结束';
    if (token.kind === 'number') {
      position += 1;
      return count({ kind: 'number', value: token.value ?? 0 });
    }
    if (token.kind === 'lparen') {
      position += 1;
      const inner = parseExpression();
      if (typeof inner === 'string') return inner;
      const close = peek();
      if (!close || close.kind !== 'rparen') return '缺少右括号';
      position += 1;
      return inner;
    }
    if (token.kind === 'ident') {
      position += 1;
      const next = peek();
      if (next && next.kind === 'lparen') {
        const name = token.text;
        const arity = EXPR_FUNCTIONS[name];
        if (!arity) return `未知函数：${name}`;
        position += 1;
        const args: ExprNode[] = [];
        if (peek() && peek()?.kind !== 'rparen') {
          for (;;) {
            const arg = parseExpression();
            if (typeof arg === 'string') return arg;
            args.push(arg);
            const separator = peek();
            if (separator && separator.kind === 'comma') {
              position += 1;
              continue;
            }
            break;
          }
        }
        const close = peek();
        if (!close || close.kind !== 'rparen') return '函数调用缺少右括号';
        position += 1;
        if (args.length < arity[0] || args.length > arity[1]) {
          return `函数 ${name} 需要 ${arity[0] === arity[1] ? arity[0] : `${arity[0]}~${arity[1]}`} 个参数`;
        }
        return count({ kind: 'call', name, args });
      }
      if (!(EXPR_VARIABLES as readonly string[]).includes(token.text)) {
        return `未知变量：${token.text}（可用：${EXPR_VARIABLES.join(', ')}）`;
      }
      return count({ kind: 'variable', name: token.text as ExprVariable });
    }
    return `意外的记号：${token.text}`;
  }

  function parseUnary(): ExprNode | string {
    const token = peek();
    if (token && token.kind === 'op' && (token.text === '-' || token.text === '+')) {
      position += 1;
      const operand = parseUnary();
      if (typeof operand === 'string') return operand;
      return token.text === '-' ? count({ kind: 'negate', operand }) : operand;
    }
    return parsePrimary();
  }

  function parseTerm(): ExprNode | string {
    let left = parseUnary();
    if (typeof left === 'string') return left;
    for (;;) {
      const token = peek();
      if (!token || token.kind !== 'op' || (token.text !== '*' && token.text !== '/')) break;
      position += 1;
      const right = parseUnary();
      if (typeof right === 'string') return right;
      left = count({ kind: 'binary', op: token.text as '*' | '/', left, right });
    }
    return left;
  }

  function parseExpression(): ExprNode | string {
    let left = parseTerm();
    if (typeof left === 'string') return left;
    for (;;) {
      const token = peek();
      if (!token || token.kind !== 'op' || (token.text !== '+' && token.text !== '-')) break;
      position += 1;
      const right = parseTerm();
      if (typeof right === 'string') return right;
      left = count({ kind: 'binary', op: token.text as '+' | '-', left, right });
    }
    return left;
  }

  if (tokens.length === 0) return { ok: false, error: '表达式为空' };
  const root = parseExpression();
  if (typeof root === 'string') return fail(root);
  if (position !== tokens.length) return fail('表达式存在多余内容');
  if (nodes > EXPR_MAX_NODES) {
    return { ok: false, error: `表达式过于复杂（${nodes} 个节点 > ${EXPR_MAX_NODES}）` };
  }
  return { ok: true, root, nodes };
}

/**
 * 编译表达式（管理端写入时校验一次、热路径再编译一次，命中下面的缓存）。
 *
 * 只接受纯算术；编译失败返回结构化的中文错误，直接回给管理端。
 */
export function compileExpr(source: string): CompileResult {
  const text = source.trim();
  if (!text) return { ok: false, error: '表达式为空' };
  if (text.length > 1_000) return { ok: false, error: '表达式过长（上限 1000 字符）' };
  const tokens = tokenize(text);
  if (!tokens.ok) return tokens;
  const parsed = parse(tokens.tokens);
  if (!parsed.ok) return parsed;
  return { ok: true, program: { source: text, root: parsed.root, nodes: parsed.nodes } };
}

/**
 * 编译缓存：表达式来自定价行，取值集合很小但每请求都要用。
 * 有界（64 条）避免管理员反复试错导致进程内无界增长。
 */
const CACHE_LIMIT = 64;
const cache = new Map<string, ExprProgram>();

function programOf(source: string): ExprProgram | null {
  const hit = cache.get(source);
  if (hit) {
    // LRU：命中后挪到末尾
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  const compiled = compileExpr(source);
  if (!compiled.ok) return null;
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(source, compiled.program);
  return compiled.program;
}

/** 求值用的变量表（数字，缺省 0）。 */
export type ExprVars = Partial<Record<ExprVariable, number>>;

function evaluateNode(node: ExprNode, vars: ExprVars, steps: { left: number }): number {
  steps.left -= 1;
  if (steps.left < 0) throw new Error('表达式求值步数超限');
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable':
      return vars[node.name] ?? 0;
    case 'negate':
      return -evaluateNode(node.operand, vars, steps);
    case 'binary': {
      const left = evaluateNode(node.left, vars, steps);
      const right = evaluateNode(node.right, vars, steps);
      if (node.op === '+') return left + right;
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      // 除以 0：配置错误不该让请求 500。返回 0（这一项不收费）。
      return right === 0 ? 0 : left / right;
    }
    case 'call': {
      const values = node.args.map((arg) => evaluateNode(arg, vars, steps));
      const first = values[0] ?? 0;
      switch (node.name) {
        case 'min':
          return Math.min(first, values[1] ?? first);
        case 'max':
          return Math.max(first, values[1] ?? first);
        case 'round':
          return Math.round(first);
        case 'ceil':
          return Math.ceil(first);
        case 'floor':
          return Math.floor(first);
        case 'abs':
          return Math.abs(first);
        default:
          return 0;
      }
    }
    default:
      return 0;
  }
}

/**
 * 按表达式算钱（minor，未四舍五入由调用方决定）。
 *
 * 编译失败（理论上写入时已拦）返回 `null`，调用方据此回退到 flat 价——
 * 宁可少收一次差价，也不要因为一条坏定价行把请求打成 500。
 */
export function evaluateExpr(source: string, vars: ExprVars): number | null {
  const program = programOf(source);
  if (!program) return null;
  try {
    const raw = evaluateNode(program.root, vars, { left: EXPR_MAX_STEPS });
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, EXPR_MAX_AMOUNT);
  } catch {
    return null;
  }
}

/** 定价行的计费模式（显式声明优先，其次按是否配了阶梯/表达式推断）。 */
export type PricingStrategyKind = 'flat' | 'tiered' | 'expr';

export function strategyOf(price: {
  strategy?: string | null;
  expr?: string | null;
  tiers?: readonly unknown[] | undefined;
}): PricingStrategyKind {
  const declared = price.strategy;
  if (declared === 'expr' || declared === 'tiered' || declared === 'flat') return declared;
  if (typeof price.expr === 'string' && price.expr.trim()) return 'expr';
  if ((price.tiers?.length ?? 0) > 0) return 'tiered';
  return 'flat';
}
