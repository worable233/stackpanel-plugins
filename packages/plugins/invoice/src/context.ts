import type {
  ExtensionClient,
  ExtensionTransaction,
  PluginContext,
} from "@stackpanel/sdk";
import { formatMinorCurrency } from "@stackpanel/sdk";

/** Stable error codes for invoice errors (ADR-0012 §2). */
const INVOICE_ERROR_CODES: Record<string, string> = {
  查询参数无效: "invoice.query.invalid",
  请求参数无效: "invoice.request.invalid",
  发票插件未就绪: "invoice.not_ready",
  "缺少发票 ID": "invoice.id_required",
  发票不存在: "invoice.not_found",
  发票数据已损坏: "invoice.corrupt",
};

/** Messages carrying a variable suffix; matched on the part before `：`. */
export function invoiceErrorCode(message: string): string {
  return (
    INVOICE_ERROR_CODES[message.split(/[:：]/)[0] ?? ""] ?? "invoice.error"
  );
}

export class InvoiceError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "InvoiceError";
    this.code = invoiceErrorCode(message);
  }
}

type TransactionRunner = <T>(
  fn: (tx: ExtensionTransaction) => Promise<T>,
) => Promise<T>;

let extensionClient: ExtensionClient | null = null;
let transactionRunner: TransactionRunner | null = null;
let pluginContext: PluginContext | null = null;

/** The plugin's own model client, bound at activation. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new InvoiceError(503, "发票插件未就绪");
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(
  fn: (tx: ExtensionTransaction) => Promise<T>,
): Promise<T> {
  if (!transactionRunner) throw new InvoiceError(503, "发票插件未就绪");
  return transactionRunner(fn);
}

export function bindExtensions(
  client: ExtensionClient,
  runTransactionFn: TransactionRunner,
  ctx?: PluginContext,
): void {
  extensionClient = client;
  transactionRunner = runTransactionFn;
  pluginContext = ctx ?? null;
}

export function clearExtensions(): void {
  extensionClient = null;
  transactionRunner = null;
  pluginContext = null;
}

/** 声明本插件发出的通知类型（内核偏好目录据此生成配置项）。 */
export const INVOICE_NOTIFICATION_TYPES = [
  {
    type: "invoice.issued",
    category: "wallet" as const,
    label: "发票已开具",
    order: 40,
  },
  {
    type: "invoice.status.changed",
    category: "wallet" as const,
    label: "发票状态变更",
    order: 50,
  },
];

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  SENT: "已发送",
  PAID: "已支付",
  VOID: "已作废",
};

/**
 * 发票回执（best-effort）。
 *
 * 发票归属靠 `customerEmail` 反查平台用户：开票时客户可能还不是平台用户，
 * 因此解析不到就静默跳过（发票本身仍然可以通过邮件/打印交付）。通知失败绝不
 * 影响开票。
 */
export async function notifyInvoice(
  event: "issued" | "status",
  invoice: {
    name: string;
    number: string;
    status: string;
    currency: string;
    total: number;
    customerEmail: string | null;
    previousStatus?: string | undefined;
  },
): Promise<void> {
  const ctx = pluginContext;
  if (!ctx || !invoice.customerEmail) return;
  try {
    const user = await ctx.auth.getUserByEmail(invoice.customerEmail);
    if (!user) return;
    const amount = formatMinorCurrency(
      invoice.total,
      invoice.currency,
      "zh-CN",
    );
    const statusLabel = STATUS_LABELS[invoice.status] ?? invoice.status;
    if (event === "issued") {
      await ctx.notifications.create({
        userId: user.id,
        type: "invoice.issued",
        title: "发票已开具",
        body: `发票 ${invoice.number}（${amount}）已开具，当前状态：${statusLabel}。`,
        link: "/account/invoices",
        data: {
          invoiceId: invoice.name,
          number: invoice.number,
          total: invoice.total,
          currency: invoice.currency,
        },
        status: "success",
      });
      return;
    }
    await ctx.notifications.upsert({
      userId: user.id,
      dedupeKey: `invoice:${invoice.name}:status:${invoice.status}`,
      type: "invoice.status.changed",
      title: "发票状态已更新",
      body: `发票 ${invoice.number} 状态已更新为「${statusLabel}」。`,
      link: "/account/invoices",
      data: {
        invoiceId: invoice.name,
        number: invoice.number,
        status: invoice.status,
        ...(invoice.previousStatus
          ? { previousStatus: invoice.previousStatus }
          : {}),
      },
      status:
        invoice.status === "PAID"
          ? "success"
          : invoice.status === "VOID"
            ? "error"
            : "info",
    });
  } catch (error) {
    ctx.logger.warn(
      `invoice: notification ${event} failed for ${invoice.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
