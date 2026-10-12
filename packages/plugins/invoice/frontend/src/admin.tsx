'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import type { ReactElement, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  GripVertical,
  Hash,
  Plus,
  Printer,
  Save,
  Send,
  Trash2,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

interface Invoice {
  id: string;
  number: string;
  referenceNumber: string | null;
  status: string;
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
  discountType: 'FIXED' | 'PERCENT';
  discountValue: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  paymentInfo: string | null;
  updatedAt?: string;
}

interface Order {
  id: string;
  userId: string;
  items: unknown;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface OrderLine {
  name: string;
  quantity: number;
  price: number;
}

interface PlatformInfo {
  name: string;
  description: string;
  url: string | null;
  logoUrl: string | null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: '草稿', cls: 'bg-muted text-muted-foreground' },
  SENT: { label: '已发送', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  PAID: { label: '已支付', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  VOID: { label: '已作废', cls: 'bg-destructive/10 text-destructive' },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' };
}

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

/** 最小货币单位（分）→ 展示字符串。 */
function money(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const value = (amount / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${value}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function toDateInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '—';
  return trimmed.slice(0, 2).toUpperCase();
}

function parseOrderLines(raw: unknown): OrderLine[] {
  if (!raw || typeof raw !== 'object') return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const lines: OrderLine[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const line = entry as Record<string, unknown>;
    const name = typeof line['name'] === 'string' ? line['name'] : '订单商品';
    const quantity = typeof line['quantity'] === 'number' ? line['quantity'] : 1;
    const price = typeof line['price'] === 'number' ? line['price'] : 0;
    lines.push({ name, quantity, price });
  }
  return lines;
}

const TAX_PRESETS = [0, 6, 9, 13];

/* ------------------------------------------------------------------ */
/* Small UI primitives                                                 */
/* ------------------------------------------------------------------ */

function Badge({ meta }: { meta: { label: string; cls: string } }): ReactElement {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      {children}
    </label>
  );
}

function SectionHeading({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-base font-semibold text-foreground">{title}</span>
      {action}
    </div>
  );
}

/** 输入框：白底 + 浅色描边 + 大圆角，贴近参考稿的“悬浮白卡”观感。 */
const inputCls =
  'h-11 w-full rounded-xl border border-input bg-card px-3.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40';

/** 明细行内的小尺寸输入框。 */
const itemInputCls =
  'h-10 w-full rounded-xl border border-input bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40';

/** 纯文字动作链（参考稿的 “+ Add Item” 风格）。 */
const linkActionCls =
  'inline-flex items-center gap-1 text-sm font-semibold text-foreground transition-opacity hover:opacity-70';

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

interface EditorState {
  status: string;
  referenceNumber: string;
  orderId: string;
  currency: string;
  issuedAt: string;
  dueAt: string;
  customerName: string;
  customerEmail: string;
  customerAddress: string;
  customerTaxId: string;
  businessName: string;
  businessAddress: string;
  businessEmail: string;
  businessPhone: string;
  items: InvoiceItem[];
  discountType: 'FIXED' | 'PERCENT';
  discount: string;
  taxRate: string;
  taxCustom: boolean;
  notes: string;
  paymentInfo: string;
}

function initialEditorState(
  invoice: Invoice | undefined,
  platform: PlatformInfo | undefined,
): EditorState {
  if (!invoice) {
    return {
      status: 'DRAFT',
      referenceNumber: '',
      orderId: '',
      currency: 'CNY',
      issuedAt: new Date().toISOString().slice(0, 10),
      dueAt: '',
      customerName: '',
      customerEmail: '',
      customerAddress: '',
      customerTaxId: '',
      businessName: platform?.name ?? '',
      businessAddress: '',
      businessEmail: '',
      businessPhone: '',
      items: [],
      discountType: 'FIXED',
      discount: '0',
      taxRate: '0',
      taxCustom: false,
      notes: '',
      paymentInfo: platform?.url ? `官网：${platform.url}` : '',
    };
  }
  return {
    status: invoice.status,
    referenceNumber: invoice.referenceNumber ?? '',
    orderId: invoice.orderId ?? '',
    currency: invoice.currency,
    issuedAt: toDateInput(invoice.issuedAt),
    dueAt: toDateInput(invoice.dueAt),
    customerName: invoice.customerName,
    customerEmail: invoice.customerEmail ?? '',
    customerAddress: invoice.customerAddress ?? '',
    customerTaxId: invoice.customerTaxId ?? '',
    businessName: invoice.businessName,
    businessAddress: invoice.businessAddress ?? '',
    businessEmail: invoice.businessEmail ?? '',
    businessPhone: invoice.businessPhone ?? '',
    items: invoice.items,
    discountType: invoice.discountType ?? 'FIXED',
    // FIXED：分 → 元（÷100）；PERCENT：基点 → 百分比（÷100）。换算一致。
    discount: (invoice.discountValue / 100).toString(),
    taxRate: invoice.taxRate.toString(),
    taxCustom: !TAX_PRESETS.includes(invoice.taxRate),
    notes: invoice.notes ?? '',
    paymentInfo: invoice.paymentInfo ?? '',
  };
}

function computePreview(state: EditorState, currency: string) {
  const items = state.items.map((item) => ({
    ...item,
    lineTotal: Math.round(item.quantity * item.unitPrice),
  }));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const rawValue = Math.max(0, Number(state.discount || 0));
  const rawDiscount =
    state.discountType === 'PERCENT'
      ? Math.round((subtotal * rawValue) / 100)
      : Math.round(rawValue * 100);
  const discount = Math.max(0, Math.min(rawDiscount, subtotal));
  const taxable = subtotal - discount;
  const rate = Math.max(0, Math.min(Number(state.taxRate || 0), 100));
  const taxAmount = Math.round((taxable * rate) / 100);
  return {
    items,
    subtotal,
    discount,
    taxAmount,
    total: taxable + taxAmount,
    currency,
  };
}

type Tab = 'invoice' | 'payment' | 'business';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'invoice', label: '发票' },
  { id: 'payment', label: '付款' },
  { id: 'business', label: '商户' },
];

const ITEM_GRID =
  'grid grid-cols-[1rem_minmax(0,1fr)_3.25rem_5rem_5rem_1.75rem] items-center gap-2';

export function InvoiceEditorPage(props: AdminPageComponentProps): ReactElement {
  const invoice = props.data.invoice as Invoice | undefined;
  const orders = (props.data.orders as Order[] | undefined) ?? [];
  const platform = props.data.platform as PlatformInfo | undefined;
  const createAction = props.actions['invoice.create'];
  const updateAction = props.actions['invoice.update'];
  const isEdit = Boolean(invoice);
  const action = isEdit ? updateAction : createAction;

  const [tab, setTab] = useState<Tab>('invoice');
  const [state, setState] = useState<EditorState>(() => initialEditorState(invoice, platform));
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const preview = useMemo(() => computePreview(state, state.currency), [state]);
  const itemsJson = useMemo(
    () =>
      JSON.stringify(
        state.items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      ),
    [state.items],
  );

  function patch(next: Partial<EditorState>) {
    setState((current) => ({ ...current, ...next }));
  }

  function updateItem(index: number, next: Partial<InvoiceItem>) {
    setState((current) => ({
      ...current,
      items: current.items.map((item, i) => (i === index ? { ...item, ...next } : item)),
    }));
  }

  function addItem() {
    setState((current) => ({
      ...current,
      items: [...current.items, { description: '', quantity: 1, unitPrice: 0, lineTotal: 0 }],
    }));
  }

  function removeItem(index: number) {
    setState((current) => ({
      ...current,
      items: current.items.filter((_, i) => i !== index),
    }));
  }

  function moveItem(from: number, to: number) {
    if (from === to) return;
    setState((current) => {
      const items = [...current.items];
      const [moved] = items.splice(from, 1);
      if (!moved) return current;
      items.splice(to, 0, moved);
      return { ...current, items };
    });
  }

  function applyOrder(orderId: string) {
    const order = orders.find((item) => item.id === orderId);
    if (!order) {
      patch({ orderId: '' });
      return;
    }
    const lines = parseOrderLines(order.items).map((line) => ({
      description: line.name,
      quantity: line.quantity,
      unitPrice: line.price,
      lineTotal: line.quantity * line.price,
    }));
    patch({
      orderId: order.id,
      currency: order.currency,
      items: lines.length > 0 ? lines : state.items,
    });
  }

  return (
    <main className="w-full space-y-6">
      <div className="print:hidden">
        <PageHeader
          eyebrow={
            <Link
              href="/admin/plugin/invoice/invoices"
              className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              返回发票列表
            </Link>
          }
          title={isEdit ? (invoice?.number ?? '编辑发票') : '新建发票'}
          description={
            isEdit
              ? '编辑发票信息并实时预览，确认后打印或导出 PDF。'
              : '填写发票信息并实时预览，确认后发送、打印或导出 PDF。'
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                form="invoice-form"
                name="status"
                value="DRAFT"
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-input bg-card px-4 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
              >
                <Save className="size-4" />
                存为草稿
              </button>
              <button
                type="submit"
                form="invoice-form"
                name="status"
                value={state.status}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
              >
                <Send className="size-4" />
                {isEdit ? '保存修改' : '创建发票'}
              </button>
            </div>
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* 左：编辑表单 */}
        <form
          id="invoice-form"
          action={action}
          className="space-y-6 rounded-2xl border bg-card p-6 shadow-sm print:hidden sm:p-7"
        >
          {isEdit ? <input type="hidden" name="id" value={invoice?.id} /> : null}
          <input type="hidden" name="items" value={itemsJson} readOnly />
          <input type="hidden" name="taxRate" value={state.taxRate} readOnly />
          <input type="hidden" name="discountType" value={state.discountType} readOnly />
          {/* FIXED：元 → 分；PERCENT：百分比 → 基点。两者均为 ×100。 */}
          <input
            type="hidden"
            name="discountValue"
            value={Math.round(Number(state.discount || 0) * 100)}
            readOnly
          />

          <div className="flex flex-wrap gap-1 rounded-xl bg-muted p-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  tab === item.id
                    ? 'bg-card text-foreground shadow-sm ring-1 ring-border'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className={tab === 'invoice' ? 'space-y-6' : 'hidden'}>
              <Field label="参考号">
                <div className="relative">
                  <input
                    name="referenceNumber"
                    value={state.referenceNumber}
                    onChange={(e) => patch({ referenceNumber: e.target.value })}
                    placeholder="如 PO-2024-001"
                    className={`${inputCls} pr-10`}
                  />
                  <Hash className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="签发日期">
                  <input
                    name="issuedAt"
                    type="date"
                    value={state.issuedAt}
                    onChange={(e) => patch({ issuedAt: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <Field label="到期日期">
                  <input
                    name="dueAt"
                    type="date"
                    value={state.dueAt}
                    onChange={(e) => patch({ dueAt: e.target.value })}
                    className={inputCls}
                  />
                </Field>
              </div>

              <div className="space-y-4 border-t pt-6">
                <SectionHeading title="开票对象" />
                <Field label="关联订单">
                  <select
                    name="orderId"
                    value={state.orderId}
                    onChange={(e) => applyOrder(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">不关联订单</option>
                    {orders.map((order) => (
                      <option key={order.id} value={order.id}>
                        {order.id} · {money(order.total, order.currency)}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex items-center gap-3 rounded-xl border border-input bg-card px-4 py-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground">
                    {initials(state.customerName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {state.customerName || '未填写客户'}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {state.customerEmail || '填写客户名称与邮箱后显示'}
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="客户名称">
                    <input
                      name="customerName"
                      value={state.customerName}
                      onChange={(e) => patch({ customerName: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="客户邮箱">
                    <input
                      name="customerEmail"
                      type="email"
                      value={state.customerEmail}
                      onChange={(e) => patch({ customerEmail: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="客户地址">
                    <textarea
                      name="customerAddress"
                      rows={2}
                      value={state.customerAddress}
                      onChange={(e) => patch({ customerAddress: e.target.value })}
                      className={`${inputCls} h-auto resize-y py-2.5`}
                    />
                  </Field>
                  <Field label="客户税号">
                    <input
                      name="customerTaxId"
                      value={state.customerTaxId}
                      onChange={(e) => patch({ customerTaxId: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </div>

              <div className="space-y-4 border-t pt-6">
                <SectionHeading
                  title="发票明细"
                  action={
                    <button type="button" onClick={addItem} className={linkActionCls}>
                      <Plus className="size-4" />
                      添加明细
                    </button>
                  }
                />
                <div>
                  <div
                    className={`${ITEM_GRID} px-1 pb-2 text-sm text-muted-foreground`}
                  >
                    <span aria-hidden="true" />
                    <span>描述</span>
                    <span>数量</span>
                    <span>单价</span>
                    <span className="text-right">小计</span>
                    <span aria-hidden="true" />
                  </div>
                  {state.items.length === 0 ? (
                    <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                      暂无明细，点击「添加明细」或从订单带入。
                    </p>
                  ) : null}
                  <div className="space-y-3 pt-1">
                    {state.items.map((item, index) => (
                      <div
                        key={index}
                        draggable
                        onDragStart={() => setDragIndex(index)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragIndex !== null) moveItem(dragIndex, index);
                          setDragIndex(null);
                        }}
                        onDragEnd={() => setDragIndex(null)}
                        className={`${ITEM_GRID} rounded-xl px-1 py-1 ${
                          dragIndex === index ? 'bg-muted/60' : ''
                        }`}
                      >
                        <span
                          className="inline-flex cursor-grab items-center justify-center text-muted-foreground/60 active:cursor-grabbing"
                          title="拖动排序"
                        >
                          <GripVertical className="size-4" />
                        </span>
                        <input
                          value={item.description}
                          onChange={(e) => updateItem(index, { description: e.target.value })}
                          placeholder="描述"
                          draggable={false}
                          className={itemInputCls}
                        />
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={(e) =>
                            updateItem(index, { quantity: Math.max(1, Number(e.target.value) || 1) })
                          }
                          draggable={false}
                          className={itemInputCls}
                        />
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={(item.unitPrice / 100).toString()}
                          onChange={(e) =>
                            updateItem(index, {
                              unitPrice: Math.round((Number(e.target.value) || 0) * 100),
                            })
                          }
                          draggable={false}
                          className={itemInputCls}
                        />
                        <span className="pr-2 text-right text-sm font-medium tabular-nums text-foreground">
                          {money(Math.round(item.quantity * item.unitPrice), state.currency)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeItem(index)}
                          aria-label="删除明细"
                          className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-4 border-t pt-6">
                <SectionHeading title="调整" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="税率">
                    <select
                      value={state.taxCustom ? 'custom' : state.taxRate}
                      onChange={(e) => {
                        if (e.target.value === 'custom') {
                          patch({ taxCustom: true });
                        } else {
                          patch({ taxCustom: false, taxRate: e.target.value });
                        }
                      }}
                      className={inputCls}
                    >
                      {TAX_PRESETS.map((rate) => (
                        <option key={rate} value={rate}>
                          增值税 {rate}%
                        </option>
                      ))}
                      <option value="custom">自定义</option>
                    </select>
                    {state.taxCustom ? (
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        value={state.taxRate}
                        onChange={(e) => patch({ taxRate: e.target.value })}
                        className={`${inputCls} mt-2`}
                      />
                    ) : null}
                  </Field>
                  <Field label="折扣">
                    <div className="flex gap-2">
                      <div className="w-24 shrink-0">
                        <select
                          value={state.discountType}
                          onChange={(e) =>
                            patch({ discountType: e.target.value as EditorState['discountType'] })
                          }
                          className={inputCls}
                        >
                          <option value="FIXED">固定</option>
                          <option value="PERCENT">百分比</option>
                        </select>
                      </div>
                      <div className="relative min-w-0 flex-1">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={state.discount}
                          onChange={(e) => patch({ discount: e.target.value })}
                          className={`${inputCls} pr-7`}
                        />
                        <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sm text-muted-foreground">
                          {state.discountType === 'PERCENT' ? '%' : '¥'}
                        </span>
                      </div>
                    </div>
                  </Field>
                </div>
              </div>

              <Field label="备注">
                <textarea
                  name="notes"
                  rows={3}
                  value={state.notes}
                  onChange={(e) => patch({ notes: e.target.value })}
                  className={`${inputCls} h-auto resize-y py-2.5`}
                />
              </Field>
            </div>

          <div className={tab === 'payment' ? 'grid gap-5' : 'hidden'}>
              <Field label="状态">
                <select
                  value={state.status}
                  onChange={(e) => patch({ status: e.target.value })}
                  className={inputCls}
                >
                  <option value="DRAFT">草稿</option>
                  <option value="SENT">已发送</option>
                  <option value="PAID">已支付</option>
                  <option value="VOID">已作废</option>
                </select>
              </Field>
              <Field label="币种">
                <input
                  name="currency"
                  value={state.currency}
                  onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}
                  maxLength={8}
                  className={inputCls}
                />
              </Field>
              <Field label="收款信息">
                <textarea
                  name="paymentInfo"
                  rows={4}
                  value={state.paymentInfo}
                  onChange={(e) => patch({ paymentInfo: e.target.value })}
                  placeholder="开户行 / 账号 / 路由号等"
                  className={`${inputCls} h-auto resize-y py-2.5`}
                />
              </Field>
            </div>

          <div className={tab === 'business' ? 'grid gap-5' : 'hidden'}>
              <div className="flex items-start gap-3 rounded-xl border border-input bg-card px-4 py-3">
                {platform?.logoUrl ? (
                  <img
                    src={platform.logoUrl}
                    alt=""
                    className="size-10 shrink-0 rounded-lg object-contain"
                  />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground">
                    {initials(state.businessName || platform?.name || '')}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {platform?.name || '未配置平台信息'}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {platform?.description || '平台「设置 → 平台信息」中的名称与图标会用于发票。'}
                  </p>
                </div>
              </div>
              <Field label="商户名称">
                <input
                  name="businessName"
                  value={state.businessName}
                  onChange={(e) => patch({ businessName: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="商户地址">
                <textarea
                  name="businessAddress"
                  rows={3}
                  value={state.businessAddress}
                  onChange={(e) => patch({ businessAddress: e.target.value })}
                  className={`${inputCls} h-auto resize-y py-2.5`}
                />
              </Field>
              <Field label="商户邮箱">
                <input
                  name="businessEmail"
                  type="email"
                  value={state.businessEmail}
                  onChange={(e) => patch({ businessEmail: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label="商户电话">
                <input
                  name="businessPhone"
                  value={state.businessPhone}
                  onChange={(e) => patch({ businessPhone: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <button
                type="button"
                onClick={() =>
                  patch({
                    businessName: platform?.name ?? state.businessName,
                    paymentInfo: platform?.url
                      ? `官网：${platform.url}`
                      : state.paymentInfo,
                  })
                }
                className="inline-flex h-10 w-fit items-center gap-1.5 rounded-xl border border-input bg-card px-4 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
              >
                <Hash className="size-4" />
                从平台信息填充
              </button>
            </div>
        </form>

        {/* 右：实时预览 */}
        <InvoicePreview
          number={isEdit ? (invoice?.number ?? '发票') : '预览'}
          referenceNumber={state.referenceNumber}
          currency={preview.currency}
          issuedAt={state.issuedAt}
          dueAt={state.dueAt}
          status={state.status}
          logoUrl={platform?.logoUrl ?? null}
          customer={{
            name: state.customerName,
            email: state.customerEmail,
            address: state.customerAddress,
            taxId: state.customerTaxId,
          }}
          business={{
            name: state.businessName,
            address: state.businessAddress,
            email: state.businessEmail,
            phone: state.businessPhone,
          }}
          items={preview.items}
          subtotal={preview.subtotal}
          discount={preview.discount}
          taxRate={Number(state.taxRate || 0)}
          taxAmount={preview.taxAmount}
          total={preview.total}
          notes={state.notes}
          paymentInfo={state.paymentInfo}
        />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function InvoicePreview({
  number,
  referenceNumber,
  currency,
  issuedAt,
  dueAt,
  status,
  logoUrl,
  customer,
  business,
  items,
  subtotal,
  discount,
  taxRate,
  taxAmount,
  total,
  notes,
  paymentInfo,
}: {
  number: string;
  referenceNumber: string;
  currency: string;
  issuedAt: string;
  dueAt: string;
  status: string;
  logoUrl: string | null;
  customer: { name: string; email: string; address: string; taxId: string };
  business: { name: string; address: string; email: string; phone: string };
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string;
  paymentInfo: string;
}): ReactElement {
  const metaRows: Array<{ label: string; value: string }> = [
    { label: '参考号', value: referenceNumber || '—' },
    { label: '签发日期', value: formatDate(issuedAt) },
    { label: '到期日期', value: formatDate(dueAt) },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-sm print:fixed print:inset-0 print:z-[9999] print:m-0 print:block print:rounded-none print:border-0 print:shadow-none">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 print:hidden">
        <span className="text-base font-semibold text-foreground">预览</span>
        <div className="inline-flex overflow-hidden rounded-xl border border-input bg-card shadow-sm">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Printer className="size-4" />
            打印
          </button>
          <span className="w-px self-stretch bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Download className="size-4" />
            下载 PDF
          </button>
        </div>
      </div>

      <div className="flex-1 bg-neutral-200 p-6 print:bg-white print:p-0 dark:bg-neutral-800">
        <div className="mx-auto w-full max-w-[46rem] rounded-md bg-card p-8 shadow-[0_8px_30px_rgba(0,0,0,0.08)] print:max-w-none print:rounded-none print:p-0 print:shadow-none">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {logoUrl ? (
                <img src={logoUrl} alt="" className="size-11 shrink-0 object-contain" />
              ) : (
                <span
                  className="grid size-11 shrink-0 grid-cols-2 grid-rows-2 gap-1"
                  aria-hidden="true"
                >
                  <span className="rounded-[3px] bg-foreground" />
                  <span className="rounded-[3px] bg-foreground" />
                  <span className="rounded-[3px] bg-foreground" />
                  <span className="rounded-[3px] bg-foreground" />
                </span>
              )}
            </div>
            <div className="text-right">
              <p className="text-3xl font-normal tracking-[0.2em] text-foreground">发票</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{number}</p>
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2">
            <dl className="space-y-1.5 text-xs">
              {metaRows.map((row) => (
                <div key={row.label} className="flex gap-1.5">
                  <dt className="text-muted-foreground">{row.label}：</dt>
                  <dd className="font-medium text-foreground">{row.value}</dd>
                </div>
              ))}
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">状态：</dt>
                <dd className="font-medium text-foreground">{statusMeta(status).label}</dd>
              </div>
            </dl>
            <div className="text-xs">
              <p className="font-semibold text-foreground">收款信息</p>
              {paymentInfo ? (
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{paymentInfo}</p>
              ) : (
                <p className="mt-1 text-muted-foreground">—</p>
              )}
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                商户
              </p>
              <p className="mt-1.5 text-sm font-semibold text-foreground">
                {business.name || '—'}
              </p>
              {business.address ? (
                <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                  {business.address}
                </p>
              ) : null}
              {business.email ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{business.email}</p>
              ) : null}
              {business.phone ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{business.phone}</p>
              ) : null}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                客户
              </p>
              <p className="mt-1.5 text-sm font-semibold text-foreground">
                {customer.name || '—'}
              </p>
              {customer.address ? (
                <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                  {customer.address}
                </p>
              ) : null}
              {customer.email ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{customer.email}</p>
              ) : null}
              {customer.taxId ? (
                <p className="mt-0.5 text-xs text-muted-foreground">税号：{customer.taxId}</p>
              ) : null}
            </div>
          </div>

          <div className="mt-8">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left">
                <tr className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
                  <th className="px-3 py-2.5 font-semibold">描述</th>
                  <th className="px-3 py-2.5 text-center font-semibold">数量</th>
                  <th className="px-3 py-2.5 text-right font-semibold">单价</th>
                  <th className="px-3 py-2.5 text-right font-semibold">小计</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
                      暂无明细
                    </td>
                  </tr>
                ) : null}
                {items.map((item, index) => (
                  <tr key={index} className="border-b border-border/70 last:border-0">
                    <td className="px-3 py-2.5">{item.description || '—'}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums">{item.quantity}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(item.unitPrice, currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(item.lineTotal, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex justify-end">
            <dl className="w-full max-w-xs space-y-2 text-xs">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">净额</dt>
                <dd className="tabular-nums text-foreground">{money(subtotal, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">折扣</dt>
                <dd className="tabular-nums text-foreground">
                  {discount > 0 ? `-${money(discount, currency)}` : money(0, currency)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">税额（{taxRate}%）</dt>
                <dd className="tabular-nums text-foreground">{money(taxAmount, currency)}</dd>
              </div>
              <div className="flex items-center justify-between border-y-2 border-foreground py-2.5 text-sm font-semibold text-foreground">
                <dt className="uppercase tracking-wide">应付合计</dt>
                <dd className="tabular-nums">{money(total, currency)}</dd>
              </div>
            </dl>
          </div>

          <div className="mt-8 flex flex-col justify-between gap-4 border-t pt-4 text-xs text-muted-foreground sm:flex-row">
            <div className="space-y-0.5">
              {business.email ? <p>{business.email}</p> : null}
              {business.phone ? <p>{business.phone}</p> : null}
            </div>
            <div className="sm:text-right">
              {notes ? <p className="whitespace-pre-wrap">{notes}</p> : null}
              <p>由 {business.name || '商户'} 开具</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

export function InvoiceListPage(props: AdminPageComponentProps): ReactElement {
  const invoices = (props.data.invoices as { invoices?: Invoice[] } | undefined)?.invoices ?? [];
  const deleteAction = props.actions['invoice.delete'];
  return (
    <main className="w-full space-y-6">
      <PageHeader
        title="发票管理"
        description="按订单或客户开具发票，支持税费、折扣与打印导出。"
        actions={
          <Link
            href="/admin/plugin/invoice/invoices/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Plus className="size-4" />
            新建发票
          </Link>
        }
      />
      {invoices.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">发票号</th>
                <th className="px-4 py-2.5 font-medium">客户</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 text-right font-medium">金额</th>
                <th className="px-4 py-2.5 text-right font-medium">签发日期</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/plugin/invoice/invoices/${invoice.id}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {invoice.number}
                    </Link>
                    {invoice.referenceNumber ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {invoice.referenceNumber}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {invoice.customerName || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge meta={statusMeta(invoice.status)} />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                    {money(invoice.total, invoice.currency)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                    {formatDate(invoice.issuedAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {deleteAction ? (
                      <form action={deleteAction} className="inline">
                        <input type="hidden" name="id" value={invoice.id} />
                        <button
                          type="submit"
                          className="text-xs text-muted-foreground hover:text-destructive"
                        >
                          删除
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Plus className="size-5" />
          </span>
          <p className="mt-4 text-sm font-medium">还没有发票</p>
          <p className="mt-1 text-sm text-muted-foreground">点击「新建发票」开始开具第一张。</p>
        </div>
      )}
    </main>
  );
}

export const adminPages = {
  'admin/invoices': InvoiceListPage,
  'admin/invoice-editor': InvoiceEditorPage,
  'admin/invoice-new': InvoiceEditorPage,
} as const;
