# 智简魔方兼容（zjmf-compat）

`zjmf-compat` 将旧版智简魔方客户端协议翻译为 StackPanel 商店能力。它依赖 `store ^0.3.0` 并消费 `commerce.operations`，维护自己的连接账号模型。

## 两个接口面

### 兼容协议面

这些 route 是 `raw` 路由，用于旧客户端协议，不会投影为 Open Platform、MCP 或 Agent 工具：

- `POST /zjmf_api_login`
- `GET /api/product/list`、`GET /api/v1/product`
- `GET /api/product/:id`、`GET /api/v1/product/:id`
- `GET /cart/set_config`
- `POST /cart/get_total`、`/cart/add_to_shop`、`/cart/settle`、`/cart/clear`
- `GET /host/list`、`/host/header`、`/host/monitor`
- `POST /provision/default`

该面使用协议指定的 bearer/form 参数和响应格式。接入前必须以真实旧客户端验证，不应把这些返回体视作新的公开 REST 契约。

### 管理面

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET/POST | `/zjmf-compat/admin/connections` | `zjmf-compat.admin` | 列出和创建连接账号。 |
| PATCH/DELETE | `/zjmf-compat/admin/connections/:id` | `zjmf-compat.admin` | 修改或删除连接账号。 |

## 安全和发布

连接凭据属于敏感配置。管理客户端不得读取明文凭据，兼容协议面也不得绕开商店的授权、价格或库存校验。由于所有协议路由是 raw，新增 MCP 或 Agent 自动化时必须另建经验证的普通 route 与 Capability，不能直接标注现有 raw route。
