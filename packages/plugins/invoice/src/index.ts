import { definePlugin, EXTENSION_POINTS, PluginError } from '@stackpanel/sdk';
import type { AdminDashboardWidgetMeta, HttpReply, HttpRequest } from '@stackpanel/sdk';
import { invoiceModel } from './data.js';
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  updateInvoice,
} from './invoices.js';
import {
  bindExtensions,
  clearExtensions,
  InvoiceError,
  INVOICE_NOTIFICATION_TYPES,
} from './context.js';

/**
 * 发票插件。
 *
 * 按客户或商店订单开具发票：管理端录入客户、明细行、税率与折扣，服务端权威
 * 计算小计 / 税额 / 合计；前台 account 端可查看与打印自己的发票。
 *
 * 数据经 Extension 引擎（`ctx.extensions`）读写，插件不接触裸 DB；关联订单时
 * 经内核 `commerce` 出口或 store 管理接口读取订单，插件不直读商店表。
 */

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof InvoiceError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

export const invoicePlugin = definePlugin({
  manifest: {
    id: 'invoice',
    name: '发票插件',
    version: '0.1.0',
    description: '按订单/客户开具发票，支持税费、折扣与打印导出。',
    requires: ['store'],
    permissions: [
      {
        key: 'invoice.admin',
        name: '管理发票',
        description: '创建、编辑与删除发票。',
      },
      {
        key: 'invoice.view',
        name: '查看发票',
        description: '查看与自己相关的发票。',
      },
    ],
    roleTemplates: [
      { role: 'USER', permissions: ['invoice.view'] },
      { role: 'ADMIN', permissions: ['invoice.admin', 'invoice.view'] },
    ],
  },
  customModels: [invoiceModel],
  routes: [
    {
      method: 'GET',
      path: '/invoice/admin/invoices',
      auth: 'admin',
      permission: 'invoice.admin',
      handler: handle(listInvoices),
    },
    {
      method: 'POST',
      path: '/invoice/admin/invoices',
      auth: 'admin',
      permission: 'invoice.admin',
      handler: handle(createInvoice),
    },
    {
      method: 'GET',
      path: '/invoice/admin/invoices/:id',
      auth: 'admin',
      permission: 'invoice.admin',
      handler: handle(getInvoice),
    },
    {
      method: 'PATCH',
      path: '/invoice/admin/invoices/:id',
      auth: 'admin',
      permission: 'invoice.admin',
      handler: handle(updateInvoice),
    },
    {
      method: 'DELETE',
      path: '/invoice/admin/invoices/:id',
      auth: 'admin',
      permission: 'invoice.admin',
      handler: handle(deleteInvoice),
    },
  ],
  onActivate: (ctx) => {
    bindExtensions(ctx.extensions, ctx.tx, ctx);
    // 声明本插件发出的通知类型，供内核偏好目录展示（未声明 = 永远投递、不可关闭）。
    for (const definition of INVOICE_NOTIFICATION_TYPES) {
      ctx.registerExtension(EXTENSION_POINTS.notificationType, definition);
    }
    ctx.registerExtension<AdminDashboardWidgetMeta>(EXTENSION_POINTS.adminDashboard, {
      id: 'invoice-summary',
      title: '发票',
      description: '按订单或客户开具发票，支持打印导出。',
    });
    ctx.logger.info('invoice: activated (v0.1.0 extension engine)');
  },
  onDeactivate: (ctx) => {
    clearExtensions();
    ctx.logger.info('invoice: deactivated');
  },
});

export { INVOICE_KIND, invoiceModel } from './data.js';
export default invoicePlugin;
