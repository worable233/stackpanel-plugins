# 企业微信邮箱（wecom-mail）

`wecom-mail` 通过企业微信「应用发送邮件」接口投递通知邮件与注册验证码，和 [`smtp`](Notifications-SMTP) 提供同样的两个扩展点。内核负责授权、投递记录、幂等、退避和死信；插件只完成一次有超时的发信请求，失败时抛错让内核重试。

官方接口文档：[发送普通邮件](https://developer.work.weixin.qq.com/document/path/97445)。

## 提供的 Extension Point

| Extension Point | 用途 |
| --- | --- |
| `notification.channel` | 将站内通知投影为邮件。 |
| `identity.challengeSender` | 发送身份挑战和注册验证码，不进入站内通知流。 |

## 启用前提

1. 企业微信管理后台创建**自建应用**，取得 `corpid`（我的企业 → 企业信息）与 `Secret`；
2. 该应用需具备**企业邮箱（邮件）**权限；
3. 若企业启用了**可信 IP**，把本服务出口 IP 加入白名单，否则接口返回 `60020`。

## 配置

配置保存在 `ctx.secrets`（加密）。必填 `corpId` 与 `corpSecret`（首次）；`corpSecret` 在后续保存时留空表示沿用已保存值。可选：`from`（发件邮箱，仅显示用）、`baseUrl`（默认为官方域名，可指向内网代理）、`publicBaseUrl`（把站内相对链接补成绝对链接）、`excludeTypes`（逗号分隔的通知 `type` 前缀，命中不发邮件）、`timeoutMs`（默认 15000）。未配置密钥存储时写配置返回 503。

`access_token` 会缓存并提前 60 秒刷新；发送遇到 token 失效（`40014` / `42001` / `41001`）时清缓存重试一次，其它错误不重试。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/wecom-mail/admin/config` | admin + `wecom-mail.admin` | 返回脱敏状态与 token 缓存状态。 |
| POST | `/wecom-mail/admin/config` | admin + `wecom-mail.admin` | 保存企业微信配置。 |
| POST | `/wecom-mail/admin/test` | admin + `wecom-mail.admin` | 向 `to` 指定地址发送测试邮件。 |

## Capability

| Capability | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| `wecom-mail.admin.config.read` | GET | `/wecom-mail/admin/config` | 读取脱敏配置。 |
| `wecom-mail.admin.config.write` | POST | `/wecom-mail/admin/config` | 写入配置（mutating、destructive）。 |
| `wecom-mail.admin.test` | POST | `/wecom-mail/admin/test` | 发送测试邮件（mutating、destructive）。 |

三者都分发到与内部路由**同一个 handler**，投影不会放宽鉴权。

## 设置页数据

设置页的初始值由声明式数据提供，manifest 里写作 `data: [{ "fetch": { "path": "/wecom-mail/admin/config" }, "as": "status" }]`。`fetch` 由**宿主**在渲染前发一个内核 GET（带当前管理员的会话），因此**不需要任何服务端执行准入**，也不需要导出 finder——装上就有数据。

若以后把这条声明改成 `finder`（例如需要在服务端读插件 secrets 做聚合），就要在后台「设置 → 运行期配置 → 插件服务端执行准入」里授权 `wecom-mail`，否则页面会缺数据（管理员会看到提示，不再是静默空表单）。

## 错误码

上游 `errcode` 翻译为稳定错误码并返回 502（内核据此决定是否重试）：`wecom.invalid_corp_id`（40013）、`wecom.invalid_secret`（40001）、`wecom.ip_not_allowed`（60020）、`wecom.mail_forbidden`（48002 / 60011）、`wecom.rate_limited`（45009 / 45033）、`wecom.token_invalid`（40014 / 42001 / 41001）、`wecom.send_failed`（其它，保留原始 errcode）、`wecom.network_error`、`wecom.bad_response`。

## 集成规则

不要在业务插件里重新实现邮件队列或把企业微信凭据暴露给前端。业务插件应先创建站内通知；内核根据用户偏好选择已配置的 `notification.channel`。发附件、成员 ID 模板翻译（`enable_id_trans`）都不在本插件范围内：需要给人看的东西写成链接，而不是把二进制塞进通知。
