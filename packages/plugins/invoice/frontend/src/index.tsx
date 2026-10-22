import type { FinderProvider, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';
import { messages } from './i18n.js';

const invoiceItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  lineTotal: z.number(),
});

const invoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  referenceNumber: z.string().nullable(),
  status: z.string(),
  orderId: z.string().nullable(),
  currency: z.string(),
  issuedAt: z.string(),
  dueAt: z.string().nullable(),
  customerName: z.string(),
  customerEmail: z.string().nullable(),
  customerAddress: z.string().nullable(),
  customerTaxId: z.string().nullable(),
  businessName: z.string(),
  businessAddress: z.string().nullable(),
  businessEmail: z.string().nullable(),
  businessPhone: z.string().nullable(),
  items: z.array(invoiceItemSchema),
  subtotal: z.number(),
  discount: z.number(),
  discountType: z.string().default('FIXED'),
  discountValue: z.number().default(0),
  taxRate: z.number(),
  taxAmount: z.number(),
  total: z.number(),
  notes: z.string().nullable(),
  paymentInfo: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const invoiceListSchema = z.object({
  invoices: z.array(invoiceSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const invoiceDetailSchema = z.object({ invoice: invoiceSchema });

const orderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  items: z.unknown().nullable(),
  total: z.number(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

const orderListSchema = z.object({
  orders: z.array(orderSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const platformInfoResponseSchema = z.object({
  platform: z.object({
    name: z.string(),
    description: z.string(),
    url: z.string().nullable(),
  }),
});

const platformBrandResponseSchema = z.object({
  brand: z.object({
    logo: z.string().nullable(),
    favicon: z.string().nullable(),
  }),
});

export interface InvoicePlatformInfo {
  name: string;
  description: string;
  url: string | null;
  logoUrl: string | null;
}

/** Resolve an API-relative asset path against the finder's API base URL. */
function absoluteAssetUrl(assetPath: string | null, baseUrl: string): string | null {
  if (!assetPath) return null;
  if (/^https?:\/\//.test(assetPath)) return assetPath;
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${assetPath.startsWith('/') ? '' : '/'}${assetPath}`;
}

/** 服务端数据提供者：管理端列表/详情 + 商店订单 + 平台信息/图标。 */
const invoiceFinders: Record<string, FinderProvider> = {
  'invoice.adminInvoices': {
    handler: async (_input, ctx) =>
      ctx.api.get('/invoice/admin/invoices?page=1&pageSize=100', invoiceListSchema),
  },
  'invoice.adminInvoice': {
    handler: async (input, ctx) =>
      (
        await ctx.api.get(
          `/invoice/admin/invoices/${encodeURIComponent(typeof input.id === 'string' ? input.id : '')}`,
          invoiceDetailSchema,
        )
      ).invoice,
  },
  'invoice.orders': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/store/admin/orders?page=1&pageSize=100', orderListSchema)).orders,
  },
  'invoice.platform': {
    handler: async (_input, ctx) => {
      const [info, brand] = await Promise.all([
        ctx.api.get('/platform/info', platformInfoResponseSchema).catch(() => null),
        ctx.api.get('/platform/brand', platformBrandResponseSchema).catch(() => null),
      ]);
      return {
        name: info?.platform.name ?? '',
        description: info?.platform.description ?? '',
        url: info?.platform.url ?? null,
        logoUrl: absoluteAssetUrl(brand?.brand.logo ?? null, ctx.api.baseUrl),
      } satisfies InvoicePlatformInfo;
    },
  },
};

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  finders: invoiceFinders,
  ui: {
    actions: [
      {
        id: 'invoice.create',
        method: 'POST',
        path: '/invoice/admin/invoices',
        permission: 'invoice.admin',
        input: [
          { name: 'status', type: 'string', maxLength: 16 },
          { name: 'referenceNumber', type: 'string', maxLength: 191 },
          { name: 'orderId', type: 'string', maxLength: 191 },
          { name: 'currency', type: 'string', maxLength: 8 },
          { name: 'issuedAt', type: 'string', maxLength: 40 },
          { name: 'dueAt', type: 'string', maxLength: 40 },
          { name: 'customerName', type: 'string', maxLength: 191 },
          { name: 'customerEmail', type: 'string', maxLength: 191 },
          { name: 'customerAddress', type: 'string', maxLength: 500 },
          { name: 'customerTaxId', type: 'string', maxLength: 64 },
          { name: 'businessName', type: 'string', maxLength: 191 },
          { name: 'businessAddress', type: 'string', maxLength: 500 },
          { name: 'businessEmail', type: 'string', maxLength: 191 },
          { name: 'businessPhone', type: 'string', maxLength: 64 },
          { name: 'items', type: 'string', maxLength: 40000 },
          {
            name: 'discount',
            type: 'integer',
            default: 0,
            min: 0,
            max: 2000000000,
          },
          { name: 'discountType', type: 'string', maxLength: 16 },
          {
            name: 'discountValue',
            type: 'integer',
            default: 0,
            min: 0,
            max: 2000000000,
          },
          { name: 'taxRate', type: 'number', default: 0, min: 0, max: 100 },
          { name: 'notes', type: 'string', maxLength: 2000 },
          { name: 'paymentInfo', type: 'string', maxLength: 2000 },
        ],
        redirect: { responsePath: 'nextPath' },
        // The redirect itself is the receipt.
        silent: true,
      },
      {
        id: 'invoice.update',
        method: 'PATCH',
        path: '/invoice/admin/invoices/:id',
        permission: 'invoice.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'status', type: 'string', maxLength: 16 },
          { name: 'referenceNumber', type: 'string', maxLength: 191 },
          { name: 'orderId', type: 'string', maxLength: 191 },
          { name: 'currency', type: 'string', maxLength: 8 },
          { name: 'issuedAt', type: 'string', maxLength: 40 },
          { name: 'dueAt', type: 'string', maxLength: 40 },
          { name: 'customerName', type: 'string', maxLength: 191 },
          { name: 'customerEmail', type: 'string', maxLength: 191 },
          { name: 'customerAddress', type: 'string', maxLength: 500 },
          { name: 'customerTaxId', type: 'string', maxLength: 64 },
          { name: 'businessName', type: 'string', maxLength: 191 },
          { name: 'businessAddress', type: 'string', maxLength: 500 },
          { name: 'businessEmail', type: 'string', maxLength: 191 },
          { name: 'businessPhone', type: 'string', maxLength: 64 },
          { name: 'items', type: 'string', maxLength: 40000 },
          {
            name: 'discount',
            type: 'integer',
            default: 0,
            min: 0,
            max: 2000000000,
          },
          { name: 'discountType', type: 'string', maxLength: 16 },
          {
            name: 'discountValue',
            type: 'integer',
            default: 0,
            min: 0,
            max: 2000000000,
          },
          { name: 'taxRate', type: 'number', default: 0, min: 0, max: 100 },
          { name: 'notes', type: 'string', maxLength: 2000 },
          { name: 'paymentInfo', type: 'string', maxLength: 2000 },
        ],
        redirect: { responsePath: 'nextPath' },
        // The redirect itself is the receipt.
        silent: true,
      },
      {
        id: 'invoice.delete',
        method: 'DELETE',
        path: '/invoice/admin/invoices/:id',
        permission: 'invoice.admin',
        successFeedback: { messageKey: 'feedback.deleted' },
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
    ],
    adminRoutes: [
      {
        path: '/invoices',
        component: 'admin/invoices',
        permission: 'invoice.admin',
        nav: { labelKey: 'nav.label', groupKey: 'nav.group', order: 20 },
        data: [{ finder: 'invoice.adminInvoices', as: 'invoices' }],
      },
      {
        path: '/invoices/new',
        component: 'admin/invoice-new',
        permission: 'invoice.admin',
        data: [
          { finder: 'invoice.orders', as: 'orders' },
          { finder: 'invoice.platform', as: 'platform' },
        ],
      },
      {
        path: '/invoices/:id',
        component: 'admin/invoice-editor',
        permission: 'invoice.admin',
        data: [
          {
            finder: 'invoice.adminInvoice',
            as: 'invoice',
            input: { id: ':id' },
          },
          { finder: 'invoice.orders', as: 'orders' },
          { finder: 'invoice.platform', as: 'platform' },
        ],
      },
    ],
  },
};

export default frontend;
