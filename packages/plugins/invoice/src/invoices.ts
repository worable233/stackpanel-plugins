import type { ExtensionInstance } from '@stackpanel/sdk';
import { z } from 'zod';
import {
  INVOICE_KIND,
  invoiceInputSchema,
  invoiceModel,
  type InvoiceData,
  type InvoiceItem,
  type InvoiceItemInput,
} from './data.js';
import { extensions, InvoiceError, notifyInvoice } from './context.js';

/** 计算后的发票金额字段。 */
export interface InvoiceTotals {
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

/** 发票视图：模型载荷 + 引擎元数据。 */
export interface InvoiceView extends InvoiceData {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 解析折扣输入为实际折扣额（最小货币单位，受小计上限约束）。
 * `FIXED`：discountValue 即分；`PERCENT`：discountValue 为基点（万分之一）。
 */
function resolveDiscount(subtotal: number, type: DiscountTypeLike, value: number): number {
  const raw =
    type === 'PERCENT' ? Math.round((subtotal * Math.max(0, value)) / 10_000) : Math.max(0, value);
  return Math.max(0, Math.min(raw, subtotal));
}

type DiscountTypeLike = 'FIXED' | 'PERCENT';

/** 对明细行求和并计算税/折扣（金额为最小货币单位，入参已保证整数）。 */
export function computeTotals(
  items: readonly { quantity: number; unitPrice: number }[],
  discount: number,
  taxRate: number,
  discountType: DiscountTypeLike = 'FIXED',
  discountValue?: number,
): InvoiceTotals {
  let subtotal = 0;
  for (const item of items) {
    subtotal += Math.round(item.quantity * item.unitPrice);
  }
  const effectiveDiscount =
    discountType === 'FIXED' && discountValue === undefined
      ? Math.max(0, Math.min(discount, subtotal))
      : resolveDiscount(subtotal, discountType, discountValue ?? discount);
  const taxable = subtotal - effectiveDiscount;
  const safeRate = Math.max(0, Math.min(taxRate, 100));
  const taxAmount = Math.round((taxable * safeRate) / 100);
  return {
    subtotal,
    discount: effectiveDiscount,
    taxRate: safeRate,
    taxAmount,
    total: taxable + taxAmount,
  };
}

/** 为明细行补齐服务端计算的 lineTotal。 */
function materializeItems(items: readonly InvoiceItemInput[]): InvoiceItem[] {
  return items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineTotal: Math.round(item.quantity * item.unitPrice),
  }));
}

export function toInvoiceView(instance: ExtensionInstance<InvoiceData>): InvoiceView {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

/**
 * The plugin action bridge only carries flat scalars, so the editor posts the
 * line-items array as a JSON string. Decode it before schema validation.
 */
function normalizeBody(body: unknown): unknown {
  if (body && typeof body === 'object' && 'items' in body) {
    const raw = (body as { items?: unknown }).items;
    if (typeof raw === 'string') {
      if (raw.trim() === '') return { ...(body as Record<string, unknown>), items: [] };
      try {
        return { ...(body as Record<string, unknown>), items: JSON.parse(raw) };
      } catch {
        throw new InvoiceError(400, '请求参数无效');
      }
    }
  }
  return body;
}

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function parsePagination(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  const parsed = paginationSchema.safeParse(query);
  return parsed.success ? parsed.data : { page: 1, pageSize: 20 };
}

/** 生成发票号：`INV-YYYYMMDD-####`，序号取自当前发票总数 + 1。 */
async function nextInvoiceNumber(): Promise<string> {
  const page = await extensions().list<InvoiceData>(invoiceModel, {
    page: 1,
    pageSize: 1,
  });
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
  const sequence = String(page.total + 1).padStart(4, '0');
  return `INV-${stamp}-${sequence}`;
}

export async function listInvoices(req: { query: Record<string, unknown> }): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().toLowerCase() : '';

  if (q) {
    const all = await extensions().listAll<InvoiceData>(invoiceModel, {
      orderBy: { field: 'createdAt', desc: true },
    });
    const filtered = all.filter((item) => {
      const haystack =
        `${item.spec.number} ${item.spec.customerName} ${item.spec.referenceNumber ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
    const start = (page - 1) * pageSize;
    return {
      invoices: filtered.slice(start, start + pageSize).map(toInvoiceView),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  const result = await extensions().list<InvoiceData>(invoiceModel, {
    where: status ? { status: { eq: status } } : {},
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return {
    invoices: result.items.map(toInvoiceView),
    total: result.total,
    page,
    pageSize,
  };
}

export async function getInvoice(req: { params: Record<string, string> }): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new InvoiceError(400, '缺少发票 ID');
  const instance = await extensions().get<InvoiceData>(invoiceModel, id);
  if (!instance) throw new InvoiceError(404, '发票不存在');
  return { invoice: toInvoiceView(instance) };
}

export async function createInvoice(req: { body: unknown }): Promise<unknown> {
  const parsed = invoiceInputSchema.safeParse(normalizeBody(req.body) ?? {});
  if (!parsed.success) throw new InvoiceError(400, '请求参数无效');
  const input = parsed.data;
  const items = materializeItems(input.items ?? []);
  const discountType = input.discountType ?? 'FIXED';
  const discountValue = input.discountValue ?? input.discount ?? 0;
  const totals = computeTotals(
    items,
    input.discount ?? 0,
    input.taxRate ?? 0,
    discountType,
    discountValue,
  );
  const created = await extensions().create<InvoiceData>(invoiceModel, {
    number: await nextInvoiceNumber(),
    referenceNumber: input.referenceNumber ?? null,
    status: input.status ?? 'DRAFT',
    orderId: input.orderId ?? null,
    currency: input.currency ?? 'CNY',
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    dueAt: input.dueAt ?? null,
    customerName: input.customerName ?? '',
    customerEmail: input.customerEmail ?? null,
    customerAddress: input.customerAddress ?? null,
    customerTaxId: input.customerTaxId ?? null,
    businessName: input.businessName ?? '',
    businessAddress: input.businessAddress ?? null,
    businessEmail: input.businessEmail ?? null,
    businessPhone: input.businessPhone ?? null,
    items,
    ...totals,
    discountType,
    discountValue,
    notes: input.notes ?? null,
    paymentInfo: input.paymentInfo ?? null,
  });
  await notifyInvoice('issued', {
    name: created.name,
    number: created.spec.number,
    status: created.spec.status,
    currency: created.spec.currency,
    total: created.spec.total,
    customerEmail: created.spec.customerEmail,
  });
  return {
    invoice: toInvoiceView(created),
    nextPath: `/admin/plugin/invoice/invoices/${created.name}`,
  };
}

export async function updateInvoice(req: {
  params: Record<string, string>;
  body: unknown;
}): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new InvoiceError(400, '缺少发票 ID');
  const parsed = invoiceInputSchema.safeParse(normalizeBody(req.body) ?? {});
  if (!parsed.success) throw new InvoiceError(400, '请求参数无效');
  const existing = await extensions().get<InvoiceData>(invoiceModel, id);
  if (!existing) throw new InvoiceError(404, '发票不存在');

  const input = parsed.data;
  const items = input.items !== undefined ? materializeItems(input.items) : existing.spec.items;
  const discount = input.discount !== undefined ? input.discount : existing.spec.discount;
  const discountType = input.discountType ?? existing.spec.discountType;
  const discountValue =
    input.discountValue !== undefined
      ? input.discountValue
      : input.discount !== undefined
        ? input.discount
        : existing.spec.discountValue;
  const taxRate = input.taxRate !== undefined ? input.taxRate : existing.spec.taxRate;
  const totals = computeTotals(items, discount, taxRate, discountType, discountValue);

  const updated = await extensions().update<InvoiceData>(invoiceModel, id, {
    ...existing.spec,
    ...(input.referenceNumber !== undefined ? { referenceNumber: input.referenceNumber } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.customerName !== undefined ? { customerName: input.customerName } : {}),
    ...(input.customerEmail !== undefined ? { customerEmail: input.customerEmail } : {}),
    ...(input.customerAddress !== undefined ? { customerAddress: input.customerAddress } : {}),
    ...(input.customerTaxId !== undefined ? { customerTaxId: input.customerTaxId } : {}),
    ...(input.businessName !== undefined ? { businessName: input.businessName } : {}),
    ...(input.businessAddress !== undefined ? { businessAddress: input.businessAddress } : {}),
    ...(input.businessEmail !== undefined ? { businessEmail: input.businessEmail } : {}),
    ...(input.businessPhone !== undefined ? { businessPhone: input.businessPhone } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.paymentInfo !== undefined ? { paymentInfo: input.paymentInfo } : {}),
    items,
    ...totals,
    discountType,
    discountValue,
  });
  // 只有状态真的变了才发通知：编辑金额/地址等字段不该刷「状态更新」。
  if (updated.spec.status !== existing.spec.status) {
    await notifyInvoice('status', {
      name: updated.name,
      number: updated.spec.number,
      status: updated.spec.status,
      previousStatus: existing.spec.status,
      currency: updated.spec.currency,
      total: updated.spec.total,
      customerEmail: updated.spec.customerEmail,
    });
  }
  return {
    invoice: toInvoiceView(updated),
    nextPath: `/admin/plugin/invoice/invoices/${updated.name}`,
  };
}

export async function deleteInvoice(req: { params: Record<string, string> }): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new InvoiceError(400, '缺少发票 ID');
  const existing = await extensions().get<InvoiceData>(invoiceModel, id);
  if (!existing) throw new InvoiceError(404, '发票不存在');
  await extensions().delete(invoiceModel, id);
  return { deleted: true };
}

export { INVOICE_KIND };
