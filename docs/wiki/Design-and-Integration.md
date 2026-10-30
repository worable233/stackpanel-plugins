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

## 前端页面数据：只能用 finder

页面（`pages` / `adminRoutes` / `accountRoutes`）的 `data` 声明必须写成 finder 引用：

```json
"data": [{ "finder": "smtp.status", "as": "status" }]
```

页面数据有两种形态（ADR-0027），**先选 `fetch`，确实需要插件代码才用 `finder`**：

```jsonc
// 宿主代发内核 GET：不执行插件代码，因此不需要执行准入
{ "fetch": { "path": "/smtp/admin/config", "select": "relay" }, "as": "status" }

// 插件自己的代码在 web 进程里跑：必须经内核授权
{ "finder": "smtp.status", "as": "status", "input": {} }
```

两者**互斥**（同时写会被安装校验拒绝）。`fetch` 只能 `GET`，`path` 必须是内核相对路径
（`/` 开头；拒绝绝对 URL、`//`、`..`、`\`、控制字符与 `/api/` 前缀），`select` 是点路径投影。
请求携带**当前访问者**的会话，所以内核路由自身的权限判定依然生效。

### 用 `fetch` 的条件与写法

把设置页/列表页的数据直接用 `fetch` 声明即可，不需要写 finder、也不需要任何授权：

```json
"data": [{ "fetch": { "path": "/smtp/admin/config" }, "as": "status" }]
```

- `manifest.json` 的 `finders` 数组**不要**再列它；
- 页面收到的是接口 JSON 原样（或用 `select` 投影后的值）；
- 路由参数可写进 path：`"path": "/store/orders/:id"`，页面自己的查询串（如 `?page=2`）会自动带上；
- 拿不到数据时页面照常渲染，**管理员**会看到一条说明原因的提示（未准入/未注册/无权限/失败/路径非法）。

### 用 `finder` 的条件与写法

只有这些情况才值得付出准入成本：需要读插件自己的 secrets 或做服务端聚合，宿主代发 GET 做不到。

写 finder 的三条要求：

1. 在 `frontend/src/index.tsx` 的 `frontend.finders` 里实现同名函数，用 `ctx.api.get(path, schema)` 调自己的路由；
2. `frontend/manifest.json` 的 `finders` 数组必须列出同一个 id（内核只认 manifest 里声明过的 finder）；
3. 路由参数用 `ctx.params` 取，需要投影就在 handler 里自己做。

```ts
finders: {
  'smtp.status': {
    handler: async (_input, ctx) => ctx.api.get('/smtp/admin/config', responseSchema),
  },
},
```

### finder 需要服务端执行授权（三个入口）

finder 在 web 进程执行，非内置包（`builtin: false`）默认**不**被允许：

1. **安装时**：上传对话框勾选「允许该插件在网站进程执行服务端代码」；
2. **插件列表**：每行显示「服务端执行：已允许/未允许」与原因，就地开关；
3. **设置 → 运行期配置 → 插件服务端执行准入**：批量改名单或紧急放行（`admitAll`）。

未被准入时 `props.data` 为空，但**不再是静默的**：插件列表会标出状态，管理员在该页面会
看到缺数据提示。denylist 命中时任何开关都不生效（`admitAll` 也一样）。

前端构建同样只有一处配置：各包 `tsup.config.ts` 只调用共享预设，宿主依赖清单在 `scripts/tsup-preset.mjs`。手写清单漂移过一次（漏掉 `next/navigation`，`smtp` 前端直接构建失败），不要再按包复制。

## 维护要求

1. 新增或修改 route 时，更新对应插件页面的路由表。
2. 新增 Capability 时，写明 alias、scope、是否写入和对应的 Agent 审批影响。
3. 新增提供/消费的 Extension Point 时，写明服务所有权、数据方向与停用后的行为。
4. 涉及外部回调、上游 API 或密钥时，记录配置来源、签名验证、超时和重试边界。
5. 更新前在目标内核版本上跑插件的聚焦测试与构建；发布包前按内核打包规范验证 manifest。
6. 改页面数据、`adminRoutes.data` 或 `finders` 时跑 `pnpm manifests:check`（它会校验 `data[].finder` 必须在 `finders` 里声明）；改前端依赖时只改 `scripts/tsup-preset.mjs`。
7. 页面数据优先用 `fetch`（无需授权）；确需 `finder` 的，在插件页面写明需要授权，并同时说明安装时可勾选授权。
