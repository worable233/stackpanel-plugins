/**
 * 从管理员粘贴的**任意一段文本**里认出 `corpid` 与自建应用 `secret`。
 *
 * 为什么需要它：企业微信从来不会给你一条干净的 `corpid, secret` 两元组。管理员
 * 实际拿到的是这些东西之一，而且是复制粘贴来的：
 *
 *   - 后台「我的企业 → 企业信息」里的一串 `ww…`；
 *   - 应用详情页的 `Secret`（43 位，点了「查看」还要扫码）；
 *   - 一段 `?corpid=ww…&corpsecret=…` 的链接；
 *   - 别的系统导出的 JSON（`{"corp_id": "ww…", "corpsecret": "…"}`）；
 *   - 把上面几样混在一起的一坨文字，中间夹着中文标签。
 *
 * 所以这里不要求格式，只做「先按标签找，再按形状找」。找不到就明确说缺哪一个，
 * 让界面能直接指出还差什么，而不是丢一句"参数无效"。
 *
 * 纯函数、无 IO，因此可以单测覆盖各种粘贴形态。
 */

export interface ParsedCredentials {
  corpId?: string;
  corpSecret?: string;
}

/** 缺什么，用稳定码表达（界面按码本地化，不解析中英文）。 */
export type ParseGap = 'wecom-mail.missing_corp_id' | 'wecom-mail.missing_secret';

export interface ParseResult extends ParsedCredentials {
  gaps: ParseGap[];
}

/** 企业 ID 的实际形状：`ww` + 16 位字母数字。放宽到 10–32 位以兼容老企业。 */
const CORP_ID_SHAPE = /(?:^|[^0-9A-Za-z])(ww[0-9A-Za-z]{10,32})(?![0-9A-Za-z])/g;
/** 应用 Secret 的实际形状：43 位 base64url。放宽是为了容忍换行/截断后的粘贴。 */
const SECRET_SHAPE = /(?:^|[^0-9A-Za-z_-])([0-9A-Za-z_-]{20,128})(?![0-9A-Za-z_-])/g;

/** 标签 → 字段。全部小写比较，冒号也做了全角兼容。 */
const CORP_ID_LABELS = [
  'corpid',
  'corp_id',
  'corp-id',
  'corp id',
  '企业id',
  '企业 id',
  '企业编号',
  '企业号',
];
const SECRET_LABELS = [
  'corpsecret',
  'corp_secret',
  'corp-secret',
  'corp secret',
  'secret',
  'appsecret',
  'app_secret',
  '应用secret',
  '应用密钥',
  '应用秘钥',
  '密钥',
  'secretkey',
  'secret_key',
];

/** 把 JSON 里的嵌套键拍平成 `lowercased key → value`。 */
function flatten(value: unknown, out: Map<string, string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    // 数组里只可能是重复项，取第一个非空即可。
    if (value.length > 0) flatten(value[0], out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalised = key.trim().toLowerCase();
    if (typeof child === 'string' || typeof child === 'number') {
      const text = String(child).trim();
      if (text && !out.has(normalised)) out.set(normalised, text);
      continue;
    }
    flatten(child, out, depth + 1);
  }
}

function clean(value: string): string {
  return value
    .trim()
    .replace(/^["'`“”‘’「」]+|["'`“”‘’「」]+$/g, '')
    .replace(/[，,;；]+$/, '')
    .trim();
}

/** `key = value` / `key: value` / `key：value` 逐段扫描（含 `&`、换行分隔）。 */
function labelled(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const labelledPair = /([\p{L}\p{N}_\- ]{1,24})\s*[:=：]\s*([^\s&,;，；]+)/gu;
  for (const match of text.matchAll(labelledPair)) {
    const key = (match[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const value = clean(match[2] ?? '');
    if (!key || !value) continue;
    if (!found.has(key)) found.set(key, value);
  }
  return found;
}

function pick(
  labels: string[],
  sources: Array<Map<string, string>>,
  accept: RegExp,
): string | undefined {
  for (const source of sources) {
    for (const label of labels) {
      const value = source.get(label);
      if (value && accept.test(value)) return value;
    }
  }
  return undefined;
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of text.matchAll(global)) {
    const value = clean(match[1] ?? '');
    if (value) return value;
  }
  return undefined;
}

/**
 * 解析一段粘贴文本。`corpId` 优先取带标签的，其次取 `ww…` 形状；
 * `corpSecret` 同理，但会排除掉已被认作 `corpId` 的那个 token。
 */
export function parseCredentials(raw: string | null | undefined): ParseResult {
  const text = (raw ?? '').trim();
  if (!text) return { gaps: ['wecom-mail.missing_corp_id', 'wecom-mail.missing_secret'] };

  const sources: Array<Map<string, string>> = [];

  // 1) 整段就是 JSON（也容忍 "凭据 = {…}" 这种前面有标签的写法）。
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    const slice = text.slice(jsonStart);
    try {
      const flat = new Map<string, string>();
      flatten(JSON.parse(slice), flat);
      if (flat.size > 0) sources.push(flat);
    } catch {
      // 不是合法 JSON：继续按文本找，不当错误。
    }
  }

  // 2) 文本里的 `key=value` / `key:value`。
  sources.push(labelled(text));
  // 3) 兜底：整段文本当作一个键（例如只粘了 `ww1234…` 或只粘了 secret）。
  sources.push(new Map([['', text]]));

  const corpIdAccept = /^ww[0-9A-Za-z]{10,32}$/;
  const secretAccept = /^[0-9A-Za-z_-]{20,128}$/;

  let corpId = pick(CORP_ID_LABELS, sources.slice(0, 2), corpIdAccept);
  if (!corpId) corpId = firstMatch(text, CORP_ID_SHAPE);
  if (!corpId && corpIdAccept.test(text)) corpId = text;

  let corpSecret = pick(SECRET_LABELS, sources.slice(0, 2), secretAccept);
  if (!corpSecret) {
    // 形状兜底：取第一个像 secret 的 token，且不能是已经认出来的 corpId 或 URL。
    for (const token of text.matchAll(SECRET_SHAPE)) {
      const candidate = clean(token[1] ?? '');
      if (!candidate || candidate === corpId) continue;
      if (/^https?$/i.test(candidate)) continue;
      corpSecret = candidate;
      break;
    }
  }
  if (corpSecret && corpId && corpSecret === corpId) corpSecret = undefined;

  const gaps: ParseGap[] = [];
  if (!corpId) gaps.push('wecom-mail.missing_corp_id');
  if (!corpSecret) gaps.push('wecom-mail.missing_secret');
  return {
    ...(corpId ? { corpId } : {}),
    ...(corpSecret ? { corpSecret } : {}),
    gaps,
  };
}

/**
 * 从请求头推断站点的对外 origin，用作 `publicBaseUrl` 的默认值 —— 管理员不应该
 * 为了"通知里的链接能点开"再手填一次自己正在访问的地址。
 *
 * 与内核 `x-forwarded-proto` 的判断口径一致：只有明确 `https` 才当 https。
 */
export function originFromHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | null {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const host = first(headers?.['x-forwarded-host']) ?? first(headers?.['host']);
  if (!host) return null;
  const proto = (first(headers?.['x-forwarded-proto']) ?? '').split(',')[0]?.trim().toLowerCase();
  const scheme = proto === 'https' ? 'https' : proto === 'http' ? 'http' : null;
  if (!scheme) return null;
  // 只接受 host[:port]：挡住把路径/凭据拼进 host 的构造。
  if (!/^[A-Za-z0-9.\-[\]:]{1,255}$/.test(host)) return null;
  return `${scheme}://${host}`;
}
