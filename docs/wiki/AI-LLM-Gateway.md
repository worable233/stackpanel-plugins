# 模型服务（llm-gateway）

`llm-gateway` 是面向终端用户的模型服务和计费插件：用户可开关计费、创建网关 key、查看模型价格和用量；运行时将兼容协议请求路由到上游账号池，并按实际用量结算钱包余额。

## 权限、模型和扩展

- 版本：`0.1.0`
- 用户权限：`llm-gateway.use`，声明 refined scope `gateway`。
- 管理权限：`llm-gateway.admin`。
- 使用自定义模型保存上游账号、key 策略、用户设置、用量、价格、账单条目、任务和 Agent provider 配置。
- 激活时注册模型提供者和通知类型；管理端可配置 Agent 使用的 provider。

不要把网关 key、上游 token 或账号池凭据写进前端、日志和 Capability 响应。

## 用户路由和 Capability

| Capability | 内部 route | `/api/v1` alias | scope | 写入 |
| --- | --- | --- | --- | --- |
| `gateway.billing.read` | `GET /llm-gateway/billing` | `GET /api/v1/gateway/billing` | `gateway:read` | 否 |
| `gateway.billing.write` | `POST /llm-gateway/billing` | `POST /api/v1/gateway/billing` | `gateway:write` | 是 |
| `gateway.prices.read` | `GET /llm-gateway/prices` | `GET /api/v1/gateway/prices` | `gateway:read` | 否 |
| `gateway.models.read` | `GET /llm-gateway/models` | `GET /api/v1/gateway/models` | `gateway:read` | 否 |
| `gateway.usage.read` | `GET /llm-gateway/usage` | `GET /api/v1/gateway/usage` | `gateway:read` | 否 |
| `gateway.keys.read` | `GET /llm-gateway/keys` | `GET /api/v1/gateway/keys` | `gateway:read` | 否 |
| `gateway.keys.create` | `POST /llm-gateway/keys` | `POST /api/v1/gateway/keys` | `gateway:write` | 是 |
| `gateway.keys.update` | `PATCH /llm-gateway/keys/:id` | `PATCH /api/v1/gateway/keys/:id` | `gateway:write` | 是 |
| `gateway.keys.delete` | `DELETE /llm-gateway/keys/:id` | `DELETE /api/v1/gateway/keys/:id` | `gateway:write` | 是 |

写入 Capability 经 MCP 使用时必须提供 `idempotencyKey`，并要求平台 Token 具备 `mcp.write`。这些 alias 与普通 route 复用同一权限和资源归属校验。

## 协议网关面

插件还注册 `POST`、`GET`、`DELETE /llm-gateway/*` raw 路由，用于转发 OpenAI 兼容及相关协议请求。常用的模型发现入口为 `GET /llm-gateway/v1/models`；其余请求由 relay 根据路径和方法匹配支持的 endpoint 和上游适配器。

raw relay 路由不是 Capability，也不会自动成为 MCP 工具。调用方必须使用用户网关 key 或受支持的用户认证方式；不得把内部管理 token 当作模型调用凭据。

## 管理面

管理员使用 `llm-gateway.admin` 管理上游账号、路由、模型价格、用户 key 策略、用量和 Agent provider。Agent provider 配置路由为：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/llm-gateway/admin/agent-provider` | 读取 Agent provider 配置。 |
| PUT | `/llm-gateway/admin/agent-provider` | 写入 Agent provider 配置。 |
| DELETE | `/llm-gateway/admin/agent-provider` | 删除 Agent provider 配置。 |

管理员路由的完整字段和上游适配器行为随插件版本演进较快。扩展适配器时应实现既有 adaptor contract、正确声明协议能力、保留用量计量和余额预授权/结算链路，并为 endpoint 匹配和计费写测试。

## 集成边界

外部系统应优先使用用户级 `/api/v1/gateway/*` Capability 管理自己可见的 key 和计费状态；不要调用管理端 route 修改其他用户配置。需要新增自动化写操作时，先定义是否可逆、如何幂等、是否需要 Agent 审批，再扩展 manifest Capability。
