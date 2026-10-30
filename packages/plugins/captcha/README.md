# captcha — 人机验证

在**登录、注册、发送注册验证码、修改密码、修改邮箱、创建 API 密钥**这些敏感操作
之前，插入一道人机验证。

它只做一件事：把浏览器拿到的 token 送去厂商的 `siteverify`，把布尔结果交回内核。
「要不要验证、验收多严」由内核的 `captcha.provider` 扩展点与 `ctx.captcha` 决定，
本插件只提供 `verify()` 与 `policyFor()`。

## 为什么是插件

内核不认识任何厂商：`packages/sdk` 里只有 `CaptchaProvider` / `CaptchaService` 两个
接口，厂商名、站点 key、校验地址、字段名全在本插件里。因此：

- **卸载本插件 = 完全回到安装前的行为。** 没有 provider 时内核回落到
  `AUTH_CAPTCHA_MODE`（默认 `off`），前端拿不到 `clientConfig` 就不渲染任何控件，
  页面 CSP 也不多一条来源。不会“登录页要求验证但没人能解”。
- **换厂商改配置，不改代码。** Turnstile → Cap → 私有化校验地址都是一次后台操作。

## 内置预设

| 预设 | 控件协议 | 说明 |
| --- | --- | --- |
| `turnstile` | script | Cloudflare Turnstile（托管挑战，官方测试 key 可用） |
| `hcaptcha` | script | hCaptcha |
| `recaptcha` | script | Google reCAPTCHA v2/v3 |
| `cap` | element | Cap（自托管 PoW，自定义元素） |
| `generic` | script | 任意「POST token + secret → 返回 success 布尔」的接口，含私有化部署 |

`generic` 是兜底：校验地址自填，字段名可用 `fieldMap` 覆盖。新增厂商只需要在
`src/presets.ts` 里加一个纯数据对象。

## 控件协议（宿主侧的契约）

`clientConfig()` 返回两类对象之一，宿主（`apps/web/src/components/captcha-field.tsx`）
只认这两类，不认识厂商：

```jsonc
// 工厂 + iframe 系（Turnstile / hCaptcha / reCAPTCHA）
{
  "kind": "script",
  "script": "https://challenges.cloudflare.com/turnstile/v0/api.js",
  "globalFn": "turnstile",
  "siteKey": "0x4AAAA...",
  "sources": { "script": ["https://challenges.cloudflare.com"],
               "frame":  ["https://challenges.cloudflare.com"],
               "connect":["https://challenges.cloudflare.com"] }
}

// 自定义元素系（Cap 等）
{
  "kind": "element",
  "tag": "cap-widget",
  "attributes": { "data-cap-api-endpoint": "https://cap.example.com/" },
  "tokenAttribute": "data-cap-token",
  "event": "solve",
  "sources": { "connect": ["https://cap.example.com"] }
}
```

`sources` 是**给宿主 CSP 用的**：内核把它消毒成绝对 `https:` origin 后，Web 侧会把
`frame`/`connect` 合并进 `frame-src`/`connect-src`。生产环境的 `script-src` 保持
`'nonce-…' 'strict-dynamic'` 不动 —— 由带 nonce 的 Next chunk 注入的脚本继承信任。

## 策略

配置里的 `actions` 声明「哪个操作要多严」：

```jsonc
{ "actions": { "login": "required", "register": "required", "change_password": "optional" } }
```

- 未列出的操作 → 回落到内核 `AUTH_CAPTCHA_MODE`。
- 全局 `AUTH_CAPTCHA_MODE=off` 是**总闸**：无论本插件声明什么，一律不验证。
  运维可以一键关停，不必卸载插件。

## 配置

后台「设置 → 人机验证」（权限 `captcha.admin`）：

- 预设、Site Key、Secret Key（只写不回显）、可选的自定义校验地址、控件主题；
- 每个受保护操作的策略；
- 「校验一次」：拿一个真实 token 试校验，确认 key 与地址可用。

密钥存在 `ctx.secrets`（AES-256-GCM）。`GET /captcha/admin/config` 永远不返回 secret；
前端只拿得到 Site Key。

## 安全

| 面 | 措施 |
| --- | --- |
| 密钥 | 只在 `ctx.secrets`；响应与日志都不含 secret |
| SSRF | 校验地址必须是公网 `https:`（`@stackpanel/net-guard`）；请求前再解析一次主机名，关闭 DNS rebinding 窗口 |
| 重定向 | `redirect: 'error'` —— 已校验的地址不能被 30x 带去内网主机 |
| 失败关闭 | 超时（8s）、网络错误、非 2xx、无法解析、字段缺失 **一律视为未通过**，绝不当作放过 |
| 顺序 | 内核在**密码校验之前**执行验证，被拒的挑战不会顺带回答「当前密码对不对」 |

## 开发

```bash
pnpm install          # 插件仓；内核需先 pnpm install + build
pnpm --filter @stackpanel/plugin-captcha build
pnpm --filter @stackpanel/plugin-captcha test
node scripts/install-into-kernel.mjs captcha
```
