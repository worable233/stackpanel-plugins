# 企业微信邮箱 (wecom-mail)

用**企业微信「应用发送邮件」接口**投递邮件，和 [`smtp`](../smtp) 提供同样的两个内核扩展点：

- `notification.channel` → 把站内通知投影成邮件（业务提醒）；
- `identity.challengeSender` → 投递注册邮箱验证码（身份挑战）。

官方文档：<https://developer.work.weixin.qq.com/document/path/97445>（发送普通邮件
`POST /cgi-bin/exmail/app/compose_send`）。

**零外部依赖**：token 交换与发信都只是两个 HTTPS `POST`，用全局 `fetch` 就够，不引入任何 SDK。

## 什么时候选它而不是 SMTP

| 场景 | 建议 |
| --- | --- |
| 企业已全员使用企业微信、且开通企业邮箱 | **本插件**：不用自建发信域名、不用维护 SMTP 账号与发信 IP 信誉 |
| 已有独立邮件服务（Postmark、SES、自建 Postfix…） | [`smtp`](../smtp) |
| 两者都装 | **会重复发信**：内核把同一条通知分发给每个 `wants()` 通过的渠道（`notifications/dispatcher.ts`），不是二选一。只留一个发信渠道，或在其中一个里用 `excludeTypes` 排除对应类型；设置页会就此给出警告 |

`compose_send` 的收件人也接受企业微信成员 `userids`；本插件统一走**邮箱地址**，因为内核的投递
目标本来就是用户邮箱，多一层 userid 映射只会在用户改邮箱时出错。

## 职责边界

内核负责**事件契约、收件人授权、渠道分发、投递记录、幂等键、退避重试与失败重投**
（`apps/api/src/notifications/dispatcher.ts`）。本插件只负责「怎么把这一封信交给企业微信」：

- `deliver()` / `send()` **成功返回即已受理**，**抛错即请求内核指数退避重试**——绝不静默成功。
- 验证码走**独立身份挑战流**，不进站内消息 / SSE / 事件 / 审计 / 日志。

## 启用前提（三条，缺一条都表现为「发送失败」）

1. 企业微信管理后台 → 应用管理，创建**自建应用**，记下 `corpid`（我的企业 → 企业信息）
   与该应用的 `Secret`；
2. 该应用必须被授予**企业邮箱（邮件）**权限；
3. 若企业开启了**可信 IP**，把本服务的出口 IP 加进白名单，否则接口返回 `60020`。

设置页里把这三条写死在提示框里，因为它们的失败现象都是同一句 `errcode`，看日志才知道要改哪里。

## 一键接入（`POST /wecom-mail/admin/connect`）

第 1、3 条检查不该由人肉完成，所以设置页的主路径是**粘贴一次、其余自动**：

1. 管理员从企业微信后台把「企业 ID」和「Secret」一起复制（两行、一段 JSON、一条带
   `corpid`/`corpsecret` 的链接都认，见 `src/credential-parser.ts`）；
2. 插件**先用真实接口换一次 `access_token`**——这一步同时验证了 corpid、Secret 与可信 IP；
3. 换取成功才落盘（换失败什么都不写，避免留下半套凭据），并顺手把 token 预热进缓存；
4. 默认给当前管理员发一封测试邮件，于是「接通」和「收到信」在同一次点击里完成；
5. `publicBaseUrl` 从请求头（`x-forwarded-proto` + `x-forwarded-host`/`host`）自动推断，
   管理员不用再手填一次自己正在访问的地址。

失败不静默：解析缺口答 `wecom-mail.missing_corp_id` / `wecom-mail.missing_secret`，上游拒绝答
`wecom.ip_not_allowed` 等稳定码 + 502，设置页按码给出「去后台做哪一件事」。
测试信失败**不回滚配置**（凭据已验过，邮件没到是另一件事），单独以 `test.code` 报告。

做不到的只有一件：**Secret 必须由人复制一次**。企业微信没有「读取应用 Secret」的接口；
零输入的方案要么是服务商代开发应用（`suite_id` + 永久授权码），要么就是把厂商凭据塞进了客户端。

## 配置（`ctx.secrets` 加密存储）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `corpId` | 是 | 企业 ID |
| `corpSecret` | 首次必填 | 自建应用 Secret；**更新时留空＝沿用已保存的** |
| `from` | 否 | 发件邮箱，仅用于后台核对（实际发件人由企业微信按应用绑定邮箱决定） |
| `baseUrl` | 否 | 默认 `https://qyapi.weixin.qq.com`，可指向内网代理/镜像 |
| `publicBaseUrl` | 否 | 把通知里的相对链接补成绝对链接；一键接入时自动取请求头推断值 |
| `excludeTypes` | 否 | 逗号分隔的通知 `type` 前缀，命中则**不发邮件**（如 `security.`） |
| `timeoutMs` | 否 | 单次 HTTP 超时，默认 15000；应小于内核投递租约，避免重复投递 |

未配置加密密钥存储时 `POST` 返回 503（`wecom-mail.no_secrets`），不落明文。

## access_token 处理

`access_token` 由 `corpid` + 应用 Secret 换取，有效期 7200 秒，企业微信对 `gettoken` 本身有限频：

- **缓存并提前 60 秒刷新**——每封信都换 token 会先撞 `45009`；
- 发送遇到 `40014` / `42001` / `41001`（token 失效）时**清缓存重试一次**；其它错误一律不重试，
  因为收件人非法、应用无邮箱权限、IP 不在白名单重试只会把一次失败变三次日志；
- 保存新配置时**立即作废缓存**（换企业/换 Secret 后旧 token 属于旧企业）。

## HTTP 契约

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/wecom-mail/admin/config` | `wecom-mail.admin` | 返回脱敏状态（含 token 缓存状态） |
| POST | `/wecom-mail/admin/config` | `wecom-mail.admin` | 写入配置（凭据加密存储） |
| POST | `/wecom-mail/admin/test` | `wecom-mail.admin` | 向指定地址发送测试邮件 |

三条路由同时以 Capability 形式投影到 Open Platform / MCP
（`wecom-mail.admin.config.read` / `.write` / `.test`），分发到**同一个 handler**，不会放宽鉴权。

## 设置页数据

manifest 里写作 `data: [{ "fetch": { "path": "/wecom-mail/admin/config" }, "as": "status" }]`。`fetch`
由**宿主**在渲染前发一个内核 GET（带当前管理员会话），所以**不需要任何服务端执行准入**，也不需要导出
finder——装上就有数据。

## 错误码

上游 `errcode` 统一翻译成稳定错误码（状态码 502，内核据此决定是否重试），前端只做本地化：

| errcode | 稳定错误码 | 含义 |
| --- | --- | --- |
| `40013` | `wecom.invalid_corp_id` | corpid 不对 |
| `40001` | `wecom.invalid_secret` | Secret 不对或已重置 |
| `60020` | `wecom.ip_not_allowed` | 出口 IP 不在可信 IP 名单 |
| `48002` / `60011` | `wecom.mail_forbidden` | 应用没有企业邮箱权限 |
| `45009` / `45033` | `wecom.rate_limited` | 触发企业微信限频 |
| `40014` / `42001` / `41001` | `wecom.token_invalid` | token 失效（自动换一次后仍失败） |
| 其它 | `wecom.send_failed` | 保留原始 `errcode` 与 `errmsg` |

网络异常为 `wecom.network_error`，应答不是 JSON 为 `wecom.bad_response`（例如反代返回 HTML 502）。

## 测试

- `src/wecom-client.test.ts`：token 复用、临期刷新、失效重试**恰好一次**、业务错误不重试、
  错误码映射、非 JSON 应答、网络异常包装、`compose_send` 请求体字段、收件人去重与 50 人上限、
  自定义 `baseUrl`。
- `src/template.test.ts`：中英文验证码邮件、通知模板的 HTML 转义（防注入）、段落保留。
- `src/credential-parser.test.ts`：四种粘贴形态（两行 / 带中文标签 / `key=value` / JSON 嵌套）都
  认得出来，只给一半时**说清缺哪个**，不会把企业 ID 误当 Secret；站点地址只从可信请求头推。
- `src/plugin.test.ts`：路由表（admin + 权限）与 Capability 镜像、两个扩展点接线、未配置时的
  行为、Secret 加密存储且不回显、留空沿用旧 Secret、首次无 Secret 被拒、验证码投递请求体、
  排除类型、相对链接补全、无邮箱用户不触发重试、测试发信与上游错误翻译；一键接入的
  **成功 / 只发信失败 / 凭据被拒（不落盘）/ 保留既有设置 / 双发警告** 五条路径。

未覆盖：真实企业微信联调（本轮无真实企业账号与出口 IP 白名单）。

## 已知取舍

- **不支持附件**：`attachment_list` 需要 base64 内联（单请求上限 50M、200 个），而内核的通知负载
  本来就不带附件；需要发附件时应该在业务侧生成下载链接，而不是把二进制塞进通知。
- **不支持 `enable_id_trans`**（成员 ID 模板翻译）：它只对第三方应用有效，且模板语法会把用户可见
  文案变成另一套 DSL；本插件直接写最终文本。
- **收件人上限 50**：企业微信对单次 `to`/`cc`/`bcc` 合并有上限，超出直接失败而不是让服务商截断。
