import { describe, expect, it } from 'vitest';
import { escapeHtml, renderCodeEmail, renderNoticeEmail } from './template.js';

describe('mail templates', () => {
  it('renders a Chinese verification-code email by default', () => {
    const mail = renderCodeEmail({ code: '426913', expiresInMinutes: 10 });
    expect(mail.subject).toBe('StackPanel 验证码');
    expect(mail.text).toContain('426913');
    expect(mail.html).toContain('426913');
    expect(mail.html).toContain('10 分钟');
  });

  it('switches to English for en-* locales', () => {
    const mail = renderCodeEmail({ code: '111222', expiresInMinutes: 5, locale: 'en-US' });
    expect(mail.subject).toBe('StackPanel verification code');
    expect(mail.html).toContain('verification code');
    expect(mail.html).not.toContain('验证码');
  });

  it('escapes user-controlled notification content', () => {
    const mail = renderNoticeEmail({
      title: '<script>alert(1)</script>',
      body: 'a < b & c > d',
      link: 'https://example.com/?x=1&y="2"',
    });
    expect(mail.html).not.toContain('<script>alert(1)</script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('a &lt; b &amp; c &gt; d');
    expect(mail.html).toContain('&quot;2&quot;');
    // Subject/plain-text paths are not HTML: they keep the raw text.
    expect(mail.subject).toContain('<script>alert(1)</script>');
  });

  it('keeps paragraph breaks in the HTML body and text fallback', () => {
    const mail = renderNoticeEmail({ title: '订单已支付', body: '第一段\n\n第二段' });
    expect(mail.html).toContain('第一段');
    expect(mail.html).toContain('第二段');
    expect(mail.text).toContain('第一段');
    expect(mail.text).toContain('第二段');
  });

  it('escapeHtml covers the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
