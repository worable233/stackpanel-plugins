# 商品分类（catalog）

`catalog` 为 `store` 增加一棵商品分类树。插件只保存分类、商品归属、展示顺序和上架状态；商品名称、价格和库存的权威数据仍由商店插件提供。

## 依赖与权限

- 版本：`0.4.0`
- 依赖：`store`，并消费商店商品读写 Extension Point。
- 管理权限：`catalog.admin`。
- 自定义模型：`catalog/category`、`catalog/product`。数据由 Extension 引擎建表，插件不使用裸数据库。

未归类的商品默认不出现在公开分类浏览结果中。停用插件不会删除商店商品，但分类关联和前台分类入口不再可用。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/catalog/categories` | public | 获取公开分类树及可展示商品。 |
| GET | `/catalog/products` | public | 按分类读取公开商品。 |
| GET/POST | `/catalog/admin/categories` | admin + `catalog.admin` | 分类列表和新建。 |
| PATCH/DELETE | `/catalog/admin/categories/:id` | admin + `catalog.admin` | 修改或删除分类。 |
| POST | `/catalog/admin/categories/reorder` | admin + `catalog.admin` | 批量重排或跨父级移动。 |
| GET | `/catalog/admin/products` | admin + `catalog.admin` | 查看商品分类和上架状态。 |
| PATCH | `/catalog/admin/products/:productId` | admin + `catalog.admin` | 设置分类、顺序、上架状态和库存。 |

## 约束

- 分类不能移动到自身或其子分类。
- `slug` 在插件内唯一；重复返回 409。
- 有子分类时删除父分类会被拒绝。
- 分类和商品读写依赖 `store` 已激活；未就绪时返回插件定义的 503 错误。

## 扩展建议

其他插件若需要读取商品目录，应通过公开路由或商店定义的商品 Extension Point，不应查询 `catalog` 的扩展模型。`catalog` 当前未声明 Open Platform Capability，因此不会自动出现在 MCP 或 Agent 工具列表中。
