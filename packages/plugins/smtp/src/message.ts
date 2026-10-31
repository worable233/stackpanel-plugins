/**
 * RFC 5322 报文构造与内置模板（零依赖）。
 *
 * 只提供邮件通道真正需要的：主题/地址头编码（RFC 2047）、UTF-8 正文、
 * text+html 的 `multipart/alternative`，以及注册验证码的信封渲染。
 */

export interface MailContent {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  html?: string;
}

/** 编码 Word（RFC 2047 B 编码，base64）用于非 ASCII 头字段。 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** 折叠长头字段：按 78 字符软换行（仅 ASCII 安全处）。 */
function foldHeader(name: string, value: string): string {
  const prefix = `${name}: `;
  if (prefix.length + value.length <= 78) return `${prefix}${value}`;
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > 76) {
    chunks.push(remaining.slice(0, 76));
    remaining = remaining.slice(76);
  }
  chunks.push(remaining);
  return `${prefix}${chunks[0]}\n${chunks
    .slice(1)
    .map((chunk) => ` ${chunk}`)
    .join('\n')}`;
}

function formatAddress(address: string, name?: string): string {
  return name ? `${encodeHeader(name)} <${address}>` : `<${address}>`;
}

function boundary(): string {
  return `=_stackpanel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/** 构造一封可直接交给 SMTP DATA 的完整报文。 */
export function buildMessage(content: MailContent): string {
  const headers: string[] = [];
  headers.push(foldHeader('From', formatAddress(content.from, content.fromName)));
  headers.push(foldHeader('To', formatAddress(content.to)));
  headers.push(foldHeader('Subject', encodeHeader(content.subject)));
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-ID: <${boundary()}@stackpanel>`);
  headers.push('MIME-Version: 1.0');
  if (content.html) {
    const mixed = boundary();
    headers.push(`Content-Type: multipart/alternative; boundary="${mixed}"`);
    const parts = [
      `--${mixed}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(content.text, 'utf8').toString('base64')),
      `--${mixed}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(content.html, 'utf8').toString('base64')),
      `--${mixed}--`,
    ];
    return `${headers.join('\n')}\n\n${parts.join('\n')}`;
  }
  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: base64');
  return `${headers.join('\n')}\n\n${wrapBase64(Buffer.from(content.text, 'utf8').toString('base64'))}`;
}

/** base64 每 76 字符换行，满足 SMTP 行长限制。 */
function wrapBase64(value: string): string {
  return value.replace(/(.{76})/g, '$1\n');
}

export interface CodeTemplateInput {
  code: string;
  expiresInMinutes: number;
  /** 站点/平台名，用于文案。 */
  brand?: string;
  locale?: string;
}

/** 注册/重置验证码邮件（纯文本 + 简易 HTML）。 */
export function renderCodeEmail(input: CodeTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const brand = input.brand ?? 'StackPanel';
  const isEnglish = (input.locale ?? '').toLowerCase().startsWith('en');
  if (isEnglish) {
    const subject = `${brand} verification code`;
    // "Use the newest one" matters: a resend retires the previous code, but the
    // older mail is still sitting in the inbox and looks equally valid.
    const text = `Your ${brand} verification code is ${input.code}.\n\nIt expires in ${input.expiresInMinutes} minutes. If you requested several codes, use the newest one — older ones no longer work. If you did not request this, you can ignore this email.\n`;
    const html = htmlShell(
      subject,
      `<p>Your <strong>${escapeHtml(brand)}</strong> verification code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${escapeHtml(input.code)}</p>
<p>It expires in ${input.expiresInMinutes} minutes. If you requested several codes, use the newest one — older ones no longer work. If you did not request this, you can ignore this email.</p>`,
    );
    return { subject, text, html };
  }
  const subject = `${brand} 验证码`;
  const text = `你的 ${brand} 验证码是 ${input.code}。\n\n验证码将在 ${input.expiresInMinutes} 分钟后失效。如收到多封验证码邮件，请使用最新一封（旧验证码已失效）。如非本人操作，请忽略本邮件。\n`;
  const html = htmlShell(
    subject,
    `<p>你的 <strong>${escapeHtml(brand)}</strong> 验证码是：</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${escapeHtml(input.code)}</p>
<p>验证码将在 ${input.expiresInMinutes} 分钟后失效。如收到多封验证码邮件，请使用最新一封（旧验证码已失效）。如非本人操作，请忽略本邮件。</p>`,
  );
  return { subject, text, html };
}

export interface NoticeTemplateInput {
  title: string;
  body: string;
  link?: string;
  brand?: string;
}

/** 站内通知的外部邮件投影（标题 + 正文 + 可选深链）。 */
export function renderNoticeEmail(input: NoticeTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const brand = input.brand ?? 'StackPanel';
  const lines = [input.body, input.link ? `\n查看详情：${input.link}` : ''].filter(Boolean);
  const text = `${input.title}\n\n${lines.join('\n')}\n`;
  const html = htmlShell(
    input.title,
    `<h2 style="margin:0 0 12px">${escapeHtml(input.title)}</h2>
<p>${escapeHtml(input.body)}</p>${input.link ? `\n<p><a href="${escapeHtml(input.link)}">查看详情</a></p>` : ''}`,
    brand,
  );
  return { subject: `[${brand}] ${input.title}`, text, html };
}

function htmlShell(title: string, inner: string, brand = 'StackPanel'): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.6">
<div style="max-width:520px;margin:0 auto;padding:24px">
${inner}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0" />
<p style="color:#64748b;font-size:12px">本邮件由 ${escapeHtml(brand)} 自动发送，请勿直接回复。</p>
</div></body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
