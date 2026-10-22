# 发票（invoice）

`invoice` 面向客户或商店订单开具发票。明细行、税率和折扣由服务端计算小计、税额和合计，前端只负责编辑、预览和浏览器打印。

## 依赖与扩展

- 版本：`0.1.0`；依赖 `store`。
- 权限：`invoice.admin` 用于管理，`invoice.view` 用于查看与自己相关的发票。
- 自定义模型：`invoice/invoice`。
- 激活时注册发票通知类型和管理端仪表盘摘要组件。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/invoice/admin/invoices` | admin + `invoice.admin` | 列出发票。 |
| POST | `/invoice/admin/invoices` | admin + `invoice.admin` | 创建发票。 |
| GET | `/invoice/admin/invoices/:id` | admin + `invoice.admin` | 读取单张发票。 |
| PATCH | `/invoice/admin/invoices/:id` | admin + `invoice.admin` | 修改发票。 |
| DELETE | `/invoice/admin/invoices/:id` | admin + `invoice.admin` | 删除发票。 |

编辑器可通过内核商店订单 finder 带入订单明细。不要在调用方计算金额后把合计当作权威值；应提交明细、税率和折扣，让插件计算结果。

## 集成状态

`invoice` 当前不声明 Open Platform Capability，也没有独立 MCP 工具。若未来公开读取或创建能力，需先定义数据可见性、写操作幂等与 Agent 审批语义，再把现有 route 映射为 Capability。
