# SMTP 邮件通道（smtp）

`smtp` 同时提供通知邮件与注册验证码邮件。内核负责授权、投递记录、幂等、退避和死信；插件只完成一次有超时和背压的 SMTP 投递，失败时抛错让内核重试。

## 提供的 Extension Point

| Extension Point | 用途 |
| --- | --- |
| `notification.channel` | 将站内通知投影为邮件。 |
| `identity.challengeSender` | 发送身份挑战和注册验证码，不进入站内通知流。 |

## 配置

配置保存在 `ctx.secrets`。必填项为 `host`、`port`、`from` 和 `fromName`；认证可使用 `user`/`password` 与 `plain` 或 `login`。支持：隐式 TLS、STARTTLS、显式明文开关、证书校验、连接池、每分钟限速、有界队列和建连/命令/整封邮件超时。

管理员不应关闭证书校验或启用明文，除非在受控测试环境。未配置密钥存储时，写配置会返回 503。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/smtp/admin/config` | admin + `smtp.admin` | 返回脱敏状态。 |
| POST | `/smtp/admin/config` | admin + `smtp.admin` | 保存 SMTP 配置。 |
| POST | `/smtp/admin/test` | admin + `smtp.admin` | 向 `to` 指定地址发送测试邮件。 |

## 设置页数据

设置页的初始值由声明式数据提供，manifest 里写作 `data: [{ "fetch": { "path": "/smtp/admin/config" }, "as": "status" }]`。`fetch` 由**宿主**在渲染前发一个内核 GET（带当前管理员的会话），所以**不需要任何执行准入**，也不需要导出 finder——装上就有数据。

空表单里的 `host` / `from` 是必填项，不会把配置存成空值，但运维会误以为没配过；所以数据必须能拿到。若把这条声明改成 `finder`（例如以后需要在服务端读插件 secrets 做聚合），就要在后台「设置 → 运行期配置 → 插件服务端执行准入」里授权 `smtp`，否则页面会缺数据（管理员会看到提示，不再是静默空表单）。

## 集成规则

不要在业务插件里重新实现邮件队列或把 SMTP 凭据暴露给前端。业务插件应先创建站内通知；内核根据用户偏好选择已配置的 `notification.channel`。`smtp` 没有 Capability，配置写操作也不应直接开放到 MCP。
