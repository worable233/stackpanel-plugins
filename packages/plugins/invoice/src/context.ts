import type { ExtensionClient, ExtensionTransaction } from '@stackpanel/sdk';

/** Stable error codes for invoice errors (ADR-0012 §2). */
const INVOICE_ERROR_CODES: Record<string, string> = {
  '查询参数无效': 'invoice.query.invalid',
  '请求参数无效': 'invoice.request.invalid',
  '发票插件未就绪': 'invoice.not_ready',
  '缺少发票 ID': 'invoice.id_required',
  '发票不存在': 'invoice.not_found',
  '发票数据已损坏': 'invoice.corrupt',
};

/** Messages carrying a variable suffix; matched on the part before `：`. */
export function invoiceErrorCode(message: string): string {
  return INVOICE_ERROR_CODES[message.split(/[:：]/)[0] ?? ''] ?? 'invoice.error';
}

export class InvoiceError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceError';
    this.code = invoiceErrorCode(message);
  }
}

type TransactionRunner = <T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>;

let extensionClient: ExtensionClient | null = null;
let transactionRunner: TransactionRunner | null = null;

/** The plugin's own model client, bound at activation. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new InvoiceError(503, '发票插件未就绪');
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!transactionRunner) throw new InvoiceError(503, '发票插件未就绪');
  return transactionRunner(fn);
}

export function bindExtensions(client: ExtensionClient, runTransactionFn: TransactionRunner): void {
  extensionClient = client;
  transactionRunner = runTransactionFn;
}

export function clearExtensions(): void {
  extensionClient = null;
  transactionRunner = null;
}
