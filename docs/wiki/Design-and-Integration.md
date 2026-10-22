# 插件设计与集成

本页说明可选插件对其他开发者开放接口时的边界。不要把业务对象、配置字段或调用示例写进内核 Wiki；它们应随本仓对应插件页面维护。

## 三类接口

| 层 | 用途 | 例子 |
| --- | --- | --- |
| 插件 HTTP 路由 | 供前端、后端或已授权客户端直接调用 | `GET /tickets`、`POST /smtp/admin/test` |
| Extension Point | 供内核或其他插件在进程内按类型消费 | `payment.provider`、`notification.channel` |
| Capability | 已有 HTTP 路由的公开别名，可投影到 Open Platform、MCP 和 Agent | `/api/v1/tickets`、`/api/v1/gateway/keys` |

普通路由不会自动公开到 Open Platform。`kind: 'raw'` 的协议兼容或流式路由也不能声明 Capability。

## Capability、Open Platform、MCP、Agent

插件在 manifest 中把一个已有 route 映射到 `/api/v1` 路径后，内核使用同一 handler、鉴权、权限和审计链路：

```text
plugin route -> manifest.capabilities -> /api/v1 alias
                                      -> capability discovery
                                      -> MCP tool / Agent platform tool
```

写入 Capability 必须标记 `mutating: true`。经 MCP 调用时还需要 Token 具备 `mcp.write`，并提供 `idempotencyKey`；Agent 是否自动执行则由 Agent Surface、调用者权限和审批策略决定。不要为同一业务操作另写 MCP server 或复制 handler。

当前已声明 Capability 的可选插件：

| 插件 | 能力范围 | 说明 |
| --- | --- | --- |
| `ticket` | 读取当前调用者工单 | `ticket.list`、`ticket.read` |
| `llm-gateway` | 当前用户的计费、价格、模型、用量和 API key | 读写分为 `gateway:read` 与 `gateway:write` |
| `zjmf-upstream` | 上游账号、同步、映射与同步记录 | 管理级读写操作 |

## Extension Point 依赖和提供

| 插件 | 消费 | 提供 |
| --- | --- | --- |
| `catalog` | 商店商品读写 | 无 |
| `invoice` | `store` | 通知类型、管理端仪表盘组件 |
| `epay` | 无 | `payment.provider` |
| `cms` | 无 | `seo.provider` |
| `smtp` | 无 | `notification.channel`、`identity.challengeSender` |
| `ticket` | 无 | 通知类型、管理端仪表盘组件 |
| `zjmf-compat` | `commerce.operations` | 无 |
| `zjmf-upstream` | 商店 commerce、商品读写 | 履约 provider、上游商品源、上游服务源 |
| `wowid` | 无 | `auth.provider` |
| `llm-gateway` | 内核钱包、凭证等服务 | LLM provider、通知类型 |

插件之间必须只依赖 manifest 中声明的插件和 Extension Point，不能导入另一个插件的内部文件或直接访问其数据表。

## 维护要求

1. 新增或修改 route 时，更新对应插件页面的路由表。
2. 新增 Capability 时，写明 alias、scope、是否写入和对应的 Agent 审批影响。
3. 新增提供/消费的 Extension Point 时，写明服务所有权、数据方向与停用后的行为。
4. 涉及外部回调、上游 API 或密钥时，记录配置来源、签名验证、超时和重试边界。
5. 更新前在目标内核版本上跑插件的聚焦测试与构建；发布包前按内核打包规范验证 manifest。
