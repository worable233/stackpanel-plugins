# 智简魔方上游（zjmf-upstream）

`zjmf-upstream` 将智简魔方 V1/V10 上游商品接入商店。它不会自动创建本地商品：管理员先建立上游账号，再在商店中建立和关联本地商品。插件负责上游目录、配置读取、成本和库存同步以及履约。

## 依赖和提供能力

- 版本：`0.3.0`；依赖 `store ^0.3.0`。
- 消费商店 commerce、商品读写 Extension Point。
- 提供履约 provider、`upstream.product.source` 与 `upstream.service.source`。
- 管理权限：`zjmf-upstream.admin`。
- 激活时注册周期同步任务，并立刻发起一次到期同步检查。

## 管理路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/zjmf-upstream/admin/instances` | 读取实例与库存概览。 |
| GET/POST | `/zjmf-upstream/admin/upstreams` | 列出或创建上游账号。 |
| POST | `/zjmf-upstream/admin/upstreams/sync` | 通过请求体中的上游 ID 同步。 |
| PATCH/DELETE | `/zjmf-upstream/admin/upstreams/:id` | 修改或删除上游账号。 |
| PATCH | `/zjmf-upstream/admin/upstreams/:id/enabled` | 启用或停用上游账号。 |
| POST | `/zjmf-upstream/admin/upstreams/:id/sync` | 同步该账号关联商品的成本和库存。 |
| GET | `/zjmf-upstream/admin/upstreams/:id/products` | 查看本地商品映射。 |
| GET | `/zjmf-upstream/admin/upstreams/:id/sync-runs` | 查看同步运行记录。 |
| POST | `/zjmf-upstream/admin/mappings/remap` | 将本地商品改映射到另一个上游商品。 |

所有上述路由要求 admin 身份和 `zjmf-upstream.admin`。

## Capability

十项管理路由已映射为 `/api/v1/zjmf/*`：`zjmf.upstreams.list/create/update/enabled/delete/sync/syncByBody/products/syncRuns` 和 `zjmf.mappings.remap`。除 `list`、`products`、`syncRuns` 外均为写入 Capability；MCP 调用写入项必须带 `mcp.write` 与 `idempotencyKey`，Agent 应按上游账号变更、同步和删除的风险配置审批。

## 集成建议

其他插件若需要搜索上游商品或读取上游服务，应消费插件注册的 source，而不是调用管理接口或依赖 ZJMF client 内部实现。同步、映射和履约具有外部副作用，调用方必须记录业务关联并处理上游失败。
