# 商品分类 (catalog)

为商店商品建立单棵无限层级分类树。后台可建分类、拖拽排序、把商品挂到分类上并设置
上下架与库存；前台按分类树浏览商品，未挂到任何分类的商品默认不出现。

## 存储：Extension 模型，零迁移

插件通过 `defineModel` 声明两个模型，内核在激活时生成真实表与索引：

| kind               | 用途                            | 关键索引（可查询字段）                   |
| ------------------ | ------------------------------- | ---------------------------------------- |
| `catalog/category` | 分类节点，`parentId` 自引用成树 | `parentId`、`slug`、`sortOrder`          |
| `catalog/product`  | 商品与分类的关联、上下架与排序  | `productId`、`shelfStatus`、`sortOrder`  |

数据落在插件自有表中（`ext_catalog_*`），不需要 Prisma schema 变更或迁移：建表、
索引与增量演进由 Extension 引擎在 `onActivate` 前完成。

商品本身的名称、价格与库存来自内核商店，插件只保存关联与展示顺序；库存写入经内核
商店服务完成。

## HTTP 契约

### 公开读（auth: public）

| 方法 | 路径                  | 说明                             |
| ---- | --------------------- | -------------------------------- |
| GET  | `/catalog/categories` | 分类树（含每个分类下的商品）     |
| GET  | `/catalog/products`   | 按分类浏览商品，未分类商品不返回 |

### 编辑（auth: admin）

| 方法   | 路径                                 | 说明                     |
| ------ | ------------------------------------ | ------------------------ |
| GET    | `/catalog/admin/categories`          | 分类列表（树形）         |
| POST   | `/catalog/admin/categories`          | 新建分类                 |
| PATCH  | `/catalog/admin/categories/:id`      | 改名、图标、父分类、排序 |
| POST   | `/catalog/admin/categories/reorder`  | 批量重排（含跨父级移动） |
| DELETE | `/catalog/admin/categories/:id`      | 删除分类，有子分类时拒绝 |
| GET    | `/catalog/admin/products`            | 商品挂载与上架状态列表   |
| PATCH  | `/catalog/admin/products/:productId` | 设置分类、上下架、排序、库存 |

## 管理界面

`frontend/` 提供「商品分类」页（`/categories`，权限 `catalog.admin`），含分类树拖拽
排序、商品指派与上下架开关，配套 5 个 manifest actions 覆盖上述写操作。

## 校验规则

- 分类不能移动到自身或其子分类下；排序列表的父分类必须已存在。
- `slug` 在插件内唯一，重复返回 409。
- 删除有子分类的分类返回 409，需先删除或移动子分类。

## 错误码

`catalog.category.params_invalid`(400)、`catalog.category.id_required`(400)、
`catalog.category.move_into_self`(400)、`catalog.category.move_into_descendant`(400)、
`catalog.category.parent_missing`(400)、`catalog.category.not_found`(404)、
`catalog.category.slug_taken`(409)、`catalog.category.has_children`(409)、
`catalog.product.not_found`(404)、`catalog.listing.params_invalid`(400)、
`catalog.not_ready`(503)、`catalog.store_data_unavailable`(503)、
`catalog.store_stock_unavailable`(503)。
