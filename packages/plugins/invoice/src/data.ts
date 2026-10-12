import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/** 发票主模型。金额一律以最小货币单位（分）存储，与 store 插件一致。 */
export const INVOICE_KIND = 'invoice/invoice';

export const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * 折扣类型：
 * - `FIXED`：固定金额，discountValue 为最小货币单位（分）。
 * - `PERCENT`：百分比，discountValue 为基点（百分比 × 100，如 12.5% → 1250）。
 * 该值是用户输入，服务端据此计算实际折扣额 {@link InvoiceData.discount}。
 */
export const INVOICE_DISCOUNT_TYPES = ['FIXED', 'PERCENT'] as const;
export type InvoiceDiscountType = (typeof INVOICE_DISCOUNT_TYPES)[number];

/** 单条明细行（服务端根据 unitPrice × quantity 计算 lineTotal）。 */
export const invoiceItemSchema = z.object({
  description: z.string().max(500),
  quantity: z.number(),
  unitPrice: z.number().int(),
  lineTotal: z.number().int(),
});

/** 明细行载荷（与 {@link invoiceItemSchema} 对齐）。 */
export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export const invoiceModel = defineModel({
  kind: INVOICE_KIND,
  label: '发票',
  schema: z.object({
    number: z.string(),
    referenceNumber: z.string().nullable().default(null),
    status: z.enum(INVOICE_STATUSES).default('DRAFT'),
    orderId: z.string().nullable().default(null),
    currency: z.string().default('CNY'),
    issuedAt: z.string(),
    dueAt: z.string().nullable().default(null),
    // 客户（Billed To）
    customerName: z.string().default(''),
    customerEmail: z.string().nullable().default(null),
    customerAddress: z.string().nullable().default(null),
    customerTaxId: z.string().nullable().default(null),
    // 开票方（Business）
    businessName: z.string().default(''),
    businessAddress: z.string().nullable().default(null),
    businessEmail: z.string().nullable().default(null),
    businessPhone: z.string().nullable().default(null),
    // 明细与金额
    items: z.array(invoiceItemSchema).default([]),
    subtotal: z.number().int().default(0),
    discount: z.number().int().default(0),
    discountType: z.enum(INVOICE_DISCOUNT_TYPES).default('FIXED'),
    discountValue: z.number().int().min(0).default(0),
    taxRate: z.number().default(0),
    taxAmount: z.number().int().default(0),
    total: z.number().int().default(0),
    notes: z.string().nullable().default(null),
    paymentInfo: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['number'], types: { number: 'string' } },
  ],
});

/** 发票载荷（与 {@link invoiceModel} 的 zod schema 对齐）。 */
export interface InvoiceData {
  number: string;
  referenceNumber: string | null;
  status: InvoiceStatus;
  orderId: string | null;
  currency: string;
  issuedAt: string;
  dueAt: string | null;
  customerName: string;
  customerEmail: string | null;
  customerAddress: string | null;
  customerTaxId: string | null;
  businessName: string;
  businessAddress: string | null;
  businessEmail: string | null;
  businessPhone: string | null;
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  discountType: InvoiceDiscountType;
  discountValue: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  paymentInfo: string | null;
}

/** 明细行输入（不含服务端计算的 lineTotal）。 */
export const invoiceItemInputSchema = z.object({
  description: z.string().max(500).default(''),
  quantity: z.number(),
  unitPrice: z.number().int(),
});

export type InvoiceItemInput = z.infer<typeof invoiceItemInputSchema>;

/** 创建/更新发票的输入载荷。 */
export const invoiceInputSchema = z.object({
  referenceNumber: z.string().max(191).nullable().optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  orderId: z.string().max(191).nullable().optional(),
  currency: z.string().max(8).optional(),
  issuedAt: z.string().max(40).optional(),
  dueAt: z.string().max(40).nullable().optional(),
  customerName: z.string().max(191).optional(),
  customerEmail: z.string().max(191).nullable().optional(),
  customerAddress: z.string().max(500).nullable().optional(),
  customerTaxId: z.string().max(64).nullable().optional(),
  businessName: z.string().max(191).optional(),
  businessAddress: z.string().max(500).nullable().optional(),
  businessEmail: z.string().max(191).nullable().optional(),
  businessPhone: z.string().max(64).nullable().optional(),
  items: z.array(invoiceItemInputSchema).max(200).optional(),
  discount: z.number().int().min(0).optional(),
  discountType: z.enum(INVOICE_DISCOUNT_TYPES).optional(),
  discountValue: z.number().int().min(0).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
  paymentInfo: z.string().max(2000).nullable().optional(),
});

export type InvoiceInput = z.infer<typeof invoiceInputSchema>;
