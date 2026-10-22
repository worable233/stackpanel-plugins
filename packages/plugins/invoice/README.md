# 发票插件（invoice）

按客户或商店订单开具发票的管理插件：录入客户、明细行、税率与折扣，服务端权威计算
小计 / 税额 / 合计，管理端提供实时预览与浏览器打印（导出 PDF）。

- 数据：经 Extension 引擎声明自定义模型 `invoice/invoice`，不接触裸 DB。
- 关联：`requires: ['store']`，管理端编辑器经 `invoice.orders` finder 读取
  `/store/admin/orders` 以「一键带入订单明细」。
- 权限：`invoice.admin`（ADMIN）。
- 路由：`/invoice/admin/invoices`（GET/POST）、`/invoice/admin/invoices/:id`（GET/PATCH/DELETE）。

## 开发

```bash
pnpm install
pnpm --filter @stackpanel/plugin-invoice build
```

前端 `frontend/` 由内核 `scripts/build-frontend.mjs` 或本仓库同等 esbuild 流程编译。
