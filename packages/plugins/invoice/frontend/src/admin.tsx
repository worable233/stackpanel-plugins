'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader, SectionTitle, Select } from '@stackpanel/ui';
import type { ReactElement, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, GripVertical, Hash, Plus, Printer, Save, Send, Trash2 } from 'lucide-react';
import { t } from './i18n.js';

/** Minimal translator shape, so helpers stay free of the SDK's generic types. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

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

/** Status code → catalog key + tone. Codes are API values, not copy. */
const STATUS_META: Record<string, { messageKey: string; cls: string }> = {
  DRAFT: { messageKey: 'status.DRAFT', cls: 'bg-muted text-muted-foreground' },
  SENT: {
    messageKey: 'status.SENT',
    cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  PAID: {
    messageKey: 'status.PAID',
    cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  VOID: { messageKey: 'status.VOID', cls: 'bg-destructive/10 text-destructive' },
};

function statusMeta(status: string, tr: Translate): { label: string; cls: string } {
  const meta = STATUS_META[status];
  return {
    label: meta ? tr(meta.messageKey) : status,
    cls: meta?.cls ?? 'bg-muted text-muted-foreground',
  };
}

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

/** 最小货币单位（分）→ 展示字符串。 */
function money(amount: number, currency: string, locale?: string): string {
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const value = (amount / 100).toLocaleString(locale ?? 'zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${value}`;
}

function formatDate(value: string | null, locale?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(locale ?? 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
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

function parseOrderLines(raw: unknown, tr: Translate): OrderLine[] {
  if (!raw || typeof raw !== 'object') return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const lines: OrderLine[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const line = entry as Record<string, unknown>;
    const name = typeof line['name'] === 'string' ? line['name'] : tr('orderItem.unnamed');
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

function SectionHeading({ title, action }: { title: string; action?: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <SectionTitle>{title}</SectionTitle>
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
  tr: Translate,
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
      paymentInfo: platform?.url ? tr('paymentInfo.website', { url: platform.url }) : '',
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

const TABS: Array<{ id: Tab; messageKey: string }> = [
  { id: 'invoice', messageKey: 'tab.invoice' },
  { id: 'payment', messageKey: 'tab.payment' },
  { id: 'business', messageKey: 'tab.business' },
];

const ITEM_GRID =
  'grid grid-cols-[1rem_minmax(0,1fr)_3.25rem_5rem_5rem_1.75rem] items-center gap-2';

export function InvoiceEditorPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const locale = props.locale;
  const invoice = props.data.invoice as Invoice | undefined;
  const orders = (props.data.orders as Order[] | undefined) ?? [];
  const platform = props.data.platform as PlatformInfo | undefined;
  const createAction = props.actions['invoice.create'];
  const updateAction = props.actions['invoice.update'];
  const isEdit = Boolean(invoice);
  const action = isEdit ? updateAction : createAction;

  const [tab, setTab] = useState<Tab>('invoice');
  const [state, setState] = useState<EditorState>(() => initialEditorState(invoice, platform, tr));
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
    const lines = parseOrderLines(order.items, tr).map((line) => ({
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
          backHref="/admin/plugin/invoice/invoices"
          backLabel={tr('editor.backToList')}
          title={isEdit ? (invoice?.number ?? tr('editor.title.edit')) : tr('editor.title.new')}
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
                {tr('editor.saveDraft')}
              </button>
              <button
                type="submit"
                form="invoice-form"
                name="status"
                value={state.status}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
              >
                <Send className="size-4" />
                {isEdit ? tr('editor.saveChanges') : tr('editor.create')}
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
                {tr(item.messageKey)}
              </button>
            ))}
          </div>

          <div className={tab === 'invoice' ? 'space-y-6' : 'hidden'}>
            <Field label={tr('field.referenceNumber')}>
              <div className="relative">
                <input
                  name="referenceNumber"
                  value={state.referenceNumber}
                  onChange={(e) => patch({ referenceNumber: e.target.value })}
                  placeholder={tr('field.referencePlaceholder')}
                  className={`${inputCls} pr-10`}
                />
                <Hash className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tr('field.issuedAt')}>
                <input
                  name="issuedAt"
                  type="date"
                  value={state.issuedAt}
                  onChange={(e) => patch({ issuedAt: e.target.value })}
                  className={inputCls}
                />
              </Field>
              <Field label={tr('field.dueAt')}>
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
              <SectionHeading title={tr('section.customer')} />
              <Field label={tr('field.order')}>
                <Select
                  name="orderId"
                  value={state.orderId}
                  onChange={(e) => applyOrder(e.target.value)}
                  className={inputCls}
                >
                  <option value="">{tr('field.orderNone')}</option>
                  {orders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.id} · {money(order.total, order.currency, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-center gap-3 rounded-xl border border-input bg-card px-4 py-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground">
                  {initials(state.customerName)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {state.customerName || tr('customer.noName')}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {state.customerEmail || tr('customer.noEmail')}
                  </p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr('field.customerName')}>
                  <input
                    name="customerName"
                    value={state.customerName}
                    onChange={(e) => patch({ customerName: e.target.value })}
                    className={inputCls}
                  />
                </Field>
                <Field label={tr('field.customerEmail')}>
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
                <Field label={tr('field.customerAddress')}>
                  <textarea
                    name="customerAddress"
                    rows={2}
                    value={state.customerAddress}
                    onChange={(e) => patch({ customerAddress: e.target.value })}
                    className={`${inputCls} h-auto resize-y py-2.5`}
                  />
                </Field>
                <Field label={tr('field.customerTaxId')}>
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
                title={tr('section.items')}
                action={
                  <button type="button" onClick={addItem} className={linkActionCls}>
                    <Plus className="size-4" />
                    {tr('items.add')}
                  </button>
                }
              />
              <div>
                <div className={`${ITEM_GRID} px-1 pb-2 text-sm text-muted-foreground`}>
                  <span aria-hidden="true" />
                  <span>{tr('items.colDescription')}</span>
                  <span>{tr('items.colQuantity')}</span>
                  <span>{tr('items.colUnitPrice')}</span>
                  <span className="text-right">{tr('items.colLineTotal')}</span>
                  <span aria-hidden="true" />
                </div>
                {state.items.length === 0 ? (
                  <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                    {tr('items.empty')}
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
                        title={tr('items.dragAria')}
                      >
                        <GripVertical className="size-4" />
                      </span>
                      <input
                        value={item.description}
                        onChange={(e) => updateItem(index, { description: e.target.value })}
                        placeholder={tr('items.descriptionPlaceholder')}
                        draggable={false}
                        className={itemInputCls}
                      />
                      <input
                        type="number"
                        min={1}
                        value={item.quantity}
                        onChange={(e) =>
                          updateItem(index, {
                            quantity: Math.max(1, Number(e.target.value) || 1),
                          })
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
                        {money(Math.round(item.quantity * item.unitPrice), state.currency, locale)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeItem(index)}
                        aria-label={tr('items.deleteAria')}
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
              <SectionHeading title={tr('section.adjustments')} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr('field.taxRate')}>
                  <Select
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
                        {tr('tax.preset', { rate })}
                      </option>
                    ))}
                    <option value="custom">{tr('tax.custom')}</option>
                  </Select>
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
                <Field label={tr('field.discount')}>
                  <div className="flex gap-2">
                    <div className="w-24 shrink-0">
                      <Select
                        value={state.discountType}
                        onChange={(e) =>
                          patch({
                            discountType: e.target.value as EditorState['discountType'],
                          })
                        }
                        className={inputCls}
                      >
                        <option value="FIXED">{tr('discount.FIXED')}</option>
                        <option value="PERCENT">{tr('discount.PERCENT')}</option>
                      </Select>
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

            <Field label={tr('field.notes')}>
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
            <Field label={tr('field.status')}>
              <Select
                value={state.status}
                onChange={(e) => patch({ status: e.target.value })}
                className={inputCls}
              >
                <option value="DRAFT">{tr('status.DRAFT')}</option>
                <option value="SENT">{tr('status.SENT')}</option>
                <option value="PAID">{tr('status.PAID')}</option>
                <option value="VOID">{tr('status.VOID')}</option>
              </Select>
            </Field>
            <Field label={tr('field.currency')}>
              <input
                name="currency"
                value={state.currency}
                onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}
                maxLength={8}
                className={inputCls}
              />
            </Field>
            <Field label={tr('field.paymentInfo')}>
              <textarea
                name="paymentInfo"
                rows={4}
                value={state.paymentInfo}
                onChange={(e) => patch({ paymentInfo: e.target.value })}
                placeholder={tr('paymentInfo.placeholder')}
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
                  {platform?.name || tr('platform.unconfigured')}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {platform?.description || tr('platform.description')}
                </p>
              </div>
            </div>
            <Field label={tr('field.businessName')}>
              <input
                name="businessName"
                value={state.businessName}
                onChange={(e) => patch({ businessName: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={tr('field.businessAddress')}>
              <textarea
                name="businessAddress"
                rows={3}
                value={state.businessAddress}
                onChange={(e) => patch({ businessAddress: e.target.value })}
                className={`${inputCls} h-auto resize-y py-2.5`}
              />
            </Field>
            <Field label={tr('field.businessEmail')}>
              <input
                name="businessEmail"
                type="email"
                value={state.businessEmail}
                onChange={(e) => patch({ businessEmail: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={tr('field.businessPhone')}>
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
                    ? tr('paymentInfo.website', { url: platform.url })
                    : state.paymentInfo,
                })
              }
              className="inline-flex h-10 w-fit items-center gap-1.5 rounded-xl border border-input bg-card px-4 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
            >
              <Hash className="size-4" />
              {tr('business.fillFromPlatform')}
            </button>
          </div>
        </form>

        {/* 右：实时预览 */}
        <InvoicePreview
          number={isEdit ? (invoice?.number ?? tr('preview.number')) : tr('preview.title')}
          tr={tr}
          locale={locale}
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
  tr,
  locale,
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
  tr: Translate;
  locale?: string;
}): ReactElement {
  const metaRows: Array<{ label: string; value: string }> = [
    { label: tr('field.referenceNumber'), value: referenceNumber || '—' },
    { label: tr('field.issuedAt'), value: formatDate(issuedAt, locale) },
    { label: tr('field.dueAt'), value: formatDate(dueAt, locale) },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-sm print:fixed print:inset-0 print:z-[9999] print:m-0 print:block print:rounded-none print:border-0 print:shadow-none">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 print:hidden">
        <span className="text-base font-semibold text-foreground">{tr('preview.title')}</span>
        <div className="inline-flex overflow-hidden rounded-xl border border-input bg-card shadow-sm">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Printer className="size-4" />
            {tr('preview.print')}
          </button>
          <span className="w-px self-stretch bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Download className="size-4" />
            {tr('preview.download')}
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
              <p className="text-3xl font-normal tracking-[0.2em] text-foreground">
                {tr('preview.number')}
              </p>
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
                <dt className="text-muted-foreground">{tr('preview.status')}：</dt>
                <dd className="font-medium text-foreground">{statusMeta(status, tr).label}</dd>
              </div>
            </dl>
            <div className="text-xs">
              <p className="font-semibold text-foreground">{tr('preview.paymentInfo')}</p>
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
                {tr('preview.business')}
              </p>
              <p className="mt-1.5 text-sm font-semibold text-foreground">{business.name || '—'}</p>
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
                {tr('preview.customer')}
              </p>
              <p className="mt-1.5 text-sm font-semibold text-foreground">{customer.name || '—'}</p>
              {customer.address ? (
                <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                  {customer.address}
                </p>
              ) : null}
              {customer.email ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{customer.email}</p>
              ) : null}
              {customer.taxId ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {tr('preview.taxId', { taxId: customer.taxId })}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-8">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left">
                <tr className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
                  <th className="px-3 py-2.5 font-semibold">{tr('items.colDescription')}</th>
                  <th className="px-3 py-2.5 text-center font-semibold">
                    {tr('items.colQuantity')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-semibold">
                    {tr('items.colUnitPrice')}
                  </th>
                  <th className="px-3 py-2.5 text-right font-semibold">
                    {tr('items.colLineTotal')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {tr('preview.emptyItems')}
                    </td>
                  </tr>
                ) : null}
                {items.map((item, index) => (
                  <tr key={index} className="border-b border-border/70 last:border-0">
                    <td className="px-3 py-2.5">{item.description || '—'}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums">{item.quantity}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(item.unitPrice, currency, locale)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(item.lineTotal, currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex justify-end">
            <dl className="w-full max-w-xs space-y-2 text-xs">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{tr('preview.subtotal')}</dt>
                <dd className="tabular-nums text-foreground">
                  {money(subtotal, currency, locale)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{tr('preview.discount')}</dt>
                <dd className="tabular-nums text-foreground">
                  {discount > 0
                    ? `-${money(discount, currency, locale)}`
                    : money(0, currency, locale)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{tr('preview.tax', { rate: taxRate })}</dt>
                <dd className="tabular-nums text-foreground">
                  {money(taxAmount, currency, locale)}
                </dd>
              </div>
              <div className="flex items-center justify-between border-y-2 border-foreground py-2.5 text-sm font-semibold text-foreground">
                <dt className="uppercase tracking-wide">{tr('preview.total')}</dt>
                <dd className="tabular-nums">{money(total, currency, locale)}</dd>
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
              <p>
                {tr('preview.issuedBy', {
                  name: business.name || tr('preview.unnamedBusiness'),
                })}
              </p>
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
  const tr = t(props.locale);
  const locale = props.locale;
  const result = props.data.invoices as
    { invoices?: Invoice[]; total?: number; page?: number; pageSize?: number } | undefined;
  const invoices = result?.invoices ?? [];
  const total = result?.total ?? invoices.length;
  const page = result?.page ?? 1;
  const pageSize = result?.pageSize ?? 20;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageHref = (next: number) =>
    next > 1 ? `/admin/plugin/invoice/invoices?page=${next}` : '/admin/plugin/invoice/invoices';
  const deleteAction = props.actions['invoice.delete'];
  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={tr('list.title')}
        actions={
          <Link
            href="/admin/plugin/invoice/invoices/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Plus className="size-4" />
            {tr('list.create')}
          </Link>
        }
      />
      {invoices.length > 0 ? (
        <>
          <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{tr('list.colNumber')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('list.colCustomer')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('list.colStatus')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{tr('list.colTotal')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{tr('list.colIssuedAt')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{tr('list.colActions')}</th>
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
                      <Badge meta={statusMeta(invoice.status, tr)} />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {money(invoice.total, invoice.currency, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                      {formatDate(invoice.issuedAt, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {deleteAction ? (
                        <form action={deleteAction} className="inline">
                          <input type="hidden" name="id" value={invoice.id} />
                          <button
                            type="submit"
                            className="text-xs text-muted-foreground hover:text-destructive"
                          >
                            {tr('list.delete')}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>{tr('list.pageSummary', { total, page, pages })}</span>
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Link
                    href={pageHref(page - 1)}
                    className="rounded-lg bg-muted px-3 py-1.5 text-foreground transition-colors hover:bg-muted/70"
                  >
                    {tr('list.previous')}
                  </Link>
                ) : null}
                {page < pages ? (
                  <Link
                    href={pageHref(page + 1)}
                    className="rounded-lg bg-muted px-3 py-1.5 text-foreground transition-colors hover:bg-muted/70"
                  >
                    {tr('list.next')}
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Plus className="size-5" />
          </span>
          <p className="mt-4 text-sm font-medium">{tr('list.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tr('list.emptyHint')}</p>
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
