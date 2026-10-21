import { describe, expect, it } from "vitest";
import {
  buildMessage,
  encodeHeader,
  escapeHtml,
  renderCodeEmail,
  renderNoticeEmail,
} from "../src/message.js";
import { dotStuff } from "../src/smtp-client.js";

describe("message encoding", () => {
  it("leaves ASCII headers untouched and RFC2047-encodes non-ASCII", () => {
    expect(encodeHeader("Hello World")).toBe("Hello World");
    expect(encodeHeader("验证码")).toBe("=?UTF-8?B?6aqM6K+B56CB?=");
  });

  it("escapes HTML in rendered templates (no injection from user data)", () => {
    const { html } = renderNoticeEmail({
      title: "<script>alert(1)</script>",
      body: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("dot-stuffs leading dots so a body line cannot terminate DATA", () => {
    expect(dotStuff("a\r\n.\r\nb")).toBe("a\r\n..\r\nb");
    expect(dotStuff(".start")).toBe("..start");
  });

  it("builds a multipart/alternative message with base64 text+html", () => {
    const raw = buildMessage({
      to: "user@example.com",
      from: "noreply@example.com",
      fromName: "平台",
      subject: "订单支付成功",
      text: "plain body",
      html: "<p>html body</p>",
    });
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");
    // Non-ASCII subject is encoded, body is base64.
    expect(raw).toContain("=?UTF-8?B?");
    expect(raw).toContain(Buffer.from("plain body", "utf8").toString("base64"));
  });

  it("builds a plain-text-only message when no html is given", () => {
    const raw = buildMessage({
      to: "user@example.com",
      from: "noreply@example.com",
      subject: "Notice",
      text: "only text",
    });
    expect(raw).not.toContain("multipart/alternative");
    expect(raw).toContain("text/plain");
  });

  it("renders a Chinese code email by default and English when locale is en", () => {
    const zh = renderCodeEmail({ code: "123456", expiresInMinutes: 10 });
    expect(zh.subject).toContain("验证码");
    expect(zh.text).toContain("123456");

    const en = renderCodeEmail({
      code: "654321",
      expiresInMinutes: 5,
      locale: "en-US",
    });
    expect(en.subject).toContain("verification code");
    expect(en.text).toContain("654321");
  });

  it("escapeHtml covers the five XML entities", () => {
    expect(escapeHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
  });
});
