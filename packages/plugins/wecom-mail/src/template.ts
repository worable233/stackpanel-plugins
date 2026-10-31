/**
 * 邮件正文渲染（企业微信 `compose_send` 收的是 JSON，不需要构造 MIME 报文）。
 *
 * 因此这里只做三件事：按语言给主题/正文、转义用户可控片段、套一层极简 HTML 外壳。
 * 保留 text 版本是因为收件端（尤其是邮件客户端的安全预览）经常只显示纯文本。
 */

export interface CodeTemplateInput {
  code: string;
  expiresInMinutes: number;
  locale?: string | undefined;
  brand?: string | undefined;
}

export interface NoticeTemplateInput {
  title: string;
  body: string;
  link?: string | null | undefined;
  locale?: string | undefined;
  brand?: string | undefined;
}

export interface RenderedMail {
  subject: string;
  /** HTML 版本（`content_type: 'html'`）。 */
  html: string;
  /** 纯文本版本，供 `content_type: 'text'` 或兜底使用。 */
  text: string;
}

function isEnglish(locale: string | undefined): boolean {
  return (locale ?? '').toLowerCase().startsWith('en');
}

function htmlShell(title: string, inner: string, brand = 'StackPanel'): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#111827">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:28px">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:18px">${escapeHtml(brand)}</div>
    ${inner}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">${escapeHtml(brand)}</div>
  </div>
</body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 注册 / 重置密码 / 校验邮箱用的验证码邮件。 */
export function renderCodeEmail(input: CodeTemplateInput): RenderedMail {
  const brand = input.brand ?? 'StackPanel';
  const minutes = input.expiresInMinutes;
  if (isEnglish(input.locale)) {
    const subject = `${brand} verification code`;
    const text = `Your ${brand} verification code is ${input.code}.\n\nIt expires in ${minutes} minutes. If you requested several codes, use the newest one — older ones no longer work. If you did not request this, you can ignore this email.\n`;
    const html = htmlShell(
      subject,
      `<p style="margin:0 0 8px">Your <strong>${escapeHtml(brand)}</strong> verification code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${escapeHtml(input.code)}</p>
<p style="margin:0;color:#4b5563">It expires in ${minutes} minutes. If you requested several codes, use the newest one — older ones no longer work. If you did not request this, you can ignore this email.</p>`,
      brand,
    );
    return { subject, html, text };
  }
  const subject = `${brand} 验证码`;
  const text = `你的 ${brand} 验证码是 ${input.code}。\n\n${minutes} 分钟内有效。如收到多封验证码邮件，请使用最新一封（旧验证码已失效）。如非本人操作，请忽略本邮件。\n`;
  const html = htmlShell(
    subject,
    `<p style="margin:0 0 8px">你的 <strong>${escapeHtml(brand)}</strong> 验证码是：</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${escapeHtml(input.code)}</p>
<p style="margin:0;color:#4b5563">${minutes} 分钟内有效。如收到多封验证码邮件，请使用最新一封（旧验证码已失效）。如非本人操作，请忽略本邮件。</p>`,
    brand,
  );
  return { subject, html, text };
}

/** 站内通知的邮件版本（安全提醒、订单通知等）。 */
export function renderNoticeEmail(input: NoticeTemplateInput): RenderedMail {
  const brand = input.brand ?? 'StackPanel';
  const title = input.title;
  const body = input.body;
  const link = input.link ?? null;
  const linkHtml = link
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${isEnglish(input.locale) ? 'Open' : '查看详情'}</a></p>`
    : '';
  const paragraphs = body
    .split(/\n{2,}/)
    .map(
      (chunk) =>
        `<p style="margin:0 0 12px;line-height:1.6">${escapeHtml(chunk).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
  const html = htmlShell(
    title,
    `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>${paragraphs}${linkHtml}`,
    brand,
  );
  const text = [title, '', body, link ? `\n${link}` : ''].join('\n').trim();
  return { subject: `[${brand}] ${title}`, html, text };
}
