# altcha — 自托管人机验证

一句话：**不需要任何第三方服务、不需要申请站点密钥、不需要域名白名单、不放宽 CSP**
的人机验证。插件自己签发工作量证明（proof-of-work）挑战，自己校验；控件脚本随包分发，
经内核同源 BFF 吐给浏览器。装完即生效。

```text
浏览器                      内核（BFF）                 altcha 插件
  │  GET /api/plugins/altcha/widget.js ─┼────────────────────►│ 内联的 altcha.min.js
  │  GET …/challenge?action=login ──────┼────────────────────►│ createChallenge()（HMAC 签名）
  │  （本地算 PoW，把 solution 填进隐藏字段 altcha）
  │  POST /login { captchaToken } ──────┼──► dispatcher ─────►│ verifySolution()（签名 + 时效 + 一次性）
```

## 为什么是插件

内核只认**能力**与**策略语义**，不认识任何厂商（ADR-0020/0021）：`ctx.captcha` 是扩展点，
`AUTH_CAPTCHA_MODE` 是总闸，`off/optional/required` 的判定只在内核里实现一次。厂商知识
（密钥、挑战算法、控件形状）全部在这个插件里。所以：

- 卸掉本插件 → 系统照常运行，只是不再有人机验证，不会 500、不会白屏；
- 装回本插件 → 策略与密钥都回来（密钥存在内核 `Secret` 表，不随插件目录丢失）；
- 内核里搜不到 `altcha` 这个名字（除了这条插件自己的产物）。

## 装即生效

首次激活时插件在 `ctx.secrets` 里生成一把 64 位十六进制 HMAC 密钥（key
`altcha-hmac-key`），日志打印 `altcha: generated a local HMAC key`。没有任何必填配置项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `actions` | 7 个动作全 `required` | `login` `register` `register_send_code` `password_reset` `change_password` `change_email` `api_token_create` |
| `maxNumber` | `100000` | PoW 搜索上界。越大越难解，普通机器 10 万次哈希约 0.1–0.3 秒 |
| `expiresMinutes` | `10` | 挑战有效期；`0` = 永不过期（不推荐） |
| `singleUse` | `true` | 同一个 solution 只能通过一次（`ctx.state` 原子读删） |
| `language` / `theme` | 空 | 控件外观，留空跟随浏览器 |

后台页在「设置 → 系统设置 → 自托管人机验证」（`/admin/plugin/altcha/settings`，
权限 `altcha.admin`，ADMIN 角色模板自动带上），带一个「自测」按钮：本地解一次挑战 +
重放一次，直接告诉你签名、时效、一次性三条链路是否都通。

## 端点

| 方法 | 路径 | 鉴权 | 作用 |
| --- | --- | --- | --- |
| `GET` | `/altcha/widget.js` | public | 内联的控件脚本（`content-type: text/javascript`，`max-age=86400`） |
| `GET` | `/altcha/challenge?action=<动作>` | public | 签发挑战 `{algorithm,challenge,maxnumber,salt,signature}` |
| `GET` | `/altcha/admin/config` | `altcha.admin` | 读当前配置与状态（含密钥指纹，不含密钥） |
| `POST` | `/altcha/admin/config` | `altcha.admin` | 写配置（**整体替换**，未给的字段回落默认值） |
| `POST` | `/altcha/admin/test` | `altcha.admin` | 自测：解一次 + 重放一次 |

前两条是插件自己声明的 `auth: 'public'` 且无 `permission` 路由，因此登录**之前**的
浏览器也能取到（内核 `GET /plugins/:id/public-routes` 会如实列出这两条，BFF 据此转发）。

## 挑战是什么

与上游 ALTCHA 协议一致，能被官方控件直接消费：

```text
salt       = <12 字节随机 hex> + "?expires=<unix>&"
challenge  = SHA-256(salt + number)     // 客户端要找到的 number
signature  = HMAC-SHA256(challenge, key)
token      = base64(JSON.stringify({algorithm, challenge, number, salt, signature}))
```

校验方（本插件）只做四件事，任何一步失败都返回 `success: false` 并带原因：

1. `algorithm === 'SHA-256'`（否则 `unsupported_algorithm`）；
2. `SHA-256(salt + number) === challenge`（否则 `solution_mismatch`）；
3. `HMAC(challenge) === signature`（否则 `signature_mismatch`）——这才是防伪造的那一步，
   没有密钥就无法凭空造出一个能过验的 challenge；
4. 未过期（`expired`）、未被用过（`singleUse` → `replayed_or_unknown`）。

第 4 条依赖 `ctx.state`：同一 solution 的记录只在**首次校验成功**时被原子读删，所以并发
重放也只有一个能过。

## 与 CSP 的关系

控件把解题器跑在 `new Worker(URL.createObjectURL(blob))` 里，所以 `worker-src` 需要
`blob:`。插件通过 `clientConfig().sources.worker = ['blob:']` 声明这一点，内核
（`/captcha/policy` → `sanitizeCspOrigins`）与 Web（`lib/captcha-csp.ts` → `buildCsp`）
都**原样透传** `blob:` 这个 scheme source（它不是 origin，`new URL('blob:')` 会抛）；
`data:` 明确不放行——那会把任意 HTML 注入升级成脚本执行。

脚本本身**不需要** `script-src` 放宽：它由同源 BFF 提供。`style-src` 也不需要：
控件自带样式表由脚本注入内联 style，落在既有的 `'unsafe-inline'` 里。

## 安全边界

- **失败关闭**：`verify` 拿不到密钥 / 解析失败 / 算法不符一律 `success: false`，内核
  `enforce()` 随后抛 `auth.captcha_failed`。不会「校验出错就放行」。
- **惰性初始化**：`ctx.secrets` 不可用（未配 `SETTINGS_ENCRYPTION_KEY`）时
  `isConfigured()` 为 `false`，`policyFor`/`clientConfig` 都返回 `null` → 前端不渲染控件、
  后端不接受 token（`auth.captcha_required`）。宁可挡住，也不静默放行。
- **无用户数据外流**：挑战与校验都在本进程内完成，不发任何出网请求（对比第三方厂商：要把
  访客 IP、站点密钥、甚至页面上下文发给厂商）。
- **它不是万能的**：PoW 抬高的是批量脚本的成本，不是「证明你是人」。家用 IP 的定向攻击、
  真人众包打码都绕得过；需要强保证时叠加邮箱验证码、登录限速与风控（本插件与它们正交）。

## 开发

```bash
# 单元测试（挑战算法 + 服务）
PATH="$PWD/../../../node_modules/.bin:$PATH" npx vitest run

# 类型检查 / 构建（dist 需要内核的 tsc，光有 pnpm 不够）
PATH="/Users/worable/Documents/StackPanel-main/node_modules/.bin:$PATH" node ../../../scripts/build-plugin.mjs

# 前端（后台设置页）
cd frontend && PATH="$PWD/../../../../node_modules/.bin:$PATH" npx tsup

# 装进内核（必须在插件包目录内跑）
node ../../../scripts/install-into-kernel.mjs
```

`prepare`/`build` 会先跑两个脚本：`scripts/sync-messages.mjs`（把 `frontend/messages/*.json`
序列化进 `frontend/manifest.json` —— 宿主只从 manifest 读文案）与 `scripts/embed-widget.mjs`
（把 `assets/altcha.min.js` 内联成 `src/widget-asset.ts`，让 isolated 插件不必读文件系统）。

控件脚本的来源与升级方法见 [`assets/NOTICE.md`](./assets/NOTICE.md)。
