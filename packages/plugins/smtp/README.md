# SMTP 邮件通道 (smtp)

把站内通知与注册验证码投递到邮箱的**通知渠道插件**。同一插件、同一份配置同时提供内核的两个
扩展点：

- `notification.channel` → 把站内通知投影成邮件（业务提醒）；
- `identity.challengeSender` → 投递注册邮箱验证码（身份挑战）。

**零外部依赖**：用 Node 内置的 `node:net` / `node:tls` 手写 SMTP，不引入 `nodemailer`。
（插件包经 esbuild 打包、`node_modules` 由内核工作区共享，重型依赖不可靠。）

## 职责边界

内核负责**事件契约、收件人授权、渠道分发、投递记录、幂等键、退避重试与失败重投**
（`apps/api/src/notifications/dispatcher.ts`）。本插件只负责「怎么把邮件发出去」：

- `deliver()` / `send()` **成功返回即已投递**，**抛错即请求内核指数退避重试**——绝不静默成功。
- 验证码走**独立身份挑战流**，不进站内消息 / SSE / 事件 / 审计 / 日志。

## 传输能力

| 能力     | 说明                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 接入方式 | 隐式 TLS（465，`secure`）/ STARTTLS（587，`requireStartTls`）/ 明文（需 `allowInsecure`）            |
| 认证     | `AUTH PLAIN` / `AUTH LOGIN`（缺省自动）                                                              |
| 超时     | `connectionTimeoutMs`（建连）/ `commandTimeoutMs`（单命令、静默读）/ `sendTimeoutMs`（整条消息）     |
| 连接池   | `maxConnections`：空闲连接复用，失败即丢弃；`maxQueue`：池满时的**有界**排队上限，超出即快速失败    |
| 限速     | `ratePerMinute`：令牌桶，`0` 关闭                                                                    |
| 报文     | RFC 5322；非 ASCII 头走 RFC 2047 B 编码；`multipart/alternative`（text+html）base64；DATA 阶段点转义 |

### 为什么不「卡住」

- **真实读超时**：Node 的 `socket.setTimeout()` 只**触发** `'timeout'` 事件、不会断开连接；本实现监听
  `'timeout'` 后主动 `destroy()` 并拒绝待读 Promise。服务端在会话中途安静掉（不关连接也不回响应）会
  **超时抛错**，而不是永久挂起占用连接池槽位。
- **整条消息时限** `sendTimeoutMs`：作为命令级超时的兜底，且**默认小于内核投递租约（60s）**，保证一次卡死的
  发送会在内核把它判为失败并重投之前先自行失败，**避免重复投递**。
- **有界排队（背压）**：池满且排队数达 `maxQueue` 时**快速失败**，交由内核退避重试，避免请求在内存里无界堆积。

### 队列在哪一层

持久化、幂等、退避重试与死信是**内核**的职责（`NotificationDelivery` 表 + `notifications.sweep-deliveries`
任务）：`dispatcher` 先落投递记录再调用 `deliver()`。因此插件**不再叠一层队列**——`deliver()` 成功返回即已投递、
抛错即请求内核重试；插件只当一个「有硬超时、有背压的发送器」，队列语义继续归内核。

## 配置（`ctx.secrets` 加密存储）

`GET /smtp/admin/config` 只回显非敏感字段；`POST /smtp/admin/config` 写入完整配置。

| 字段                                       | 必填 | 说明                                                             |
| ------------------------------------------ | ---- | ---------------------------------------------------------------- |
| `host` / `port`                            | 是   | SMTP 服务器                                                      |
| `secure`                                   | 否   | 隐式 TLS（默认 `true`）                                          |
| `requireStartTls`                          | 否   | 明文连接后 STARTTLS 升级                                         |
| `allowInsecure`                            | 否   | 显式允许明文发送（默认 `false`，安全优先）                       |
| `rejectUnauthorized`                       | 否   | 校验证书（默认 `true`；仅自签测试才关）                          |
| `user` / `password`                        | 否   | 认证凭据（配了 `user` 必须给 `password`）                        |
| `authMethod`                               | 否   | `plain` / `login`                                                |
| `from` / `fromName`                        | 是   | 发件地址与显示名                                                 |
| `publicBaseUrl`                            | 否   | 把通知里的相对链接补成绝对链接                                   |
| `excludeTypes`                             | 否   | 逗号分隔的通知 `type` 前缀，命中则**不发邮件**（如 `progress.`） |
| `maxConnections` / `ratePerMinute`         | 否   | 连接池上限 / 每分钟上限                                          |
| `maxQueue`                                 | 否   | 池满时的有界排队上限（默认 100），超出即快速失败                 |
| `connectionTimeoutMs` / `commandTimeoutMs` / `sendTimeoutMs` | 否 | 建连 / 单命令 / 整条消息超时（毫秒）            |

## HTTP 契约

| 方法 | 路径                 | 权限         | 说明                     |
| ---- | -------------------- | ------------ | ------------------------ |
| GET  | `/smtp/admin/config` | `smtp.admin` | 读取非敏感配置与状态     |
| POST | `/smtp/admin/config` | `smtp.admin` | 写入配置（凭据加密存储） |
| POST | `/smtp/admin/test`   | `smtp.admin` | 向指定地址发送测试邮件   |

未配置加密密钥存储时 `POST` 返回 503（`smtp.no_secrets`），不落明文。

## 测试

- `src/message.test.ts`：头编码、模板 HTML 转义（防注入）、点转义、multipart 结构。
- `src/smtp-client.test.ts`：内存 SMTP 服务器端到端——命令序列、点转义、`AUTH PLAIN`、
  收件人被拒（不静默成功）、认证失败、强制 STARTTLS 拒绝明文、连接池复用；以及
  **服务端中途静默时超时而非永久挂起**、一次卡死不会拖垮后续发送、池满时按 `maxQueue` 快速失败。

未覆盖：真实 SMTP 服务商联调（本轮无真实网关）。
