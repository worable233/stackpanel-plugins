import type { ExtensionClient, ExtensionTransaction, PluginContext } from '@stackpanel/sdk';
import type { StoreProductRead, StoreProductUpdate } from './store-capabilities.js';

const STORE_PRODUCT_READ = 'store.product.read';
const STORE_PRODUCT_UPDATE = 'store.product.update';

let ctx: PluginContext | null = null;
let extensionClient: ExtensionClient | null = null;
let transactionRunner: (<T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>) | null =
  null;
let productRead: StoreProductRead | null = null;
let productUpdate: StoreProductUpdate | null = null;

export function bindContext(pluginCtx: PluginContext): void {
  ctx = pluginCtx;
  extensionClient = pluginCtx.extensions;
  transactionRunner = pluginCtx.tx;
  productRead = pluginCtx.getExtensions<StoreProductRead>(STORE_PRODUCT_READ)[0] ?? null;
  productUpdate = pluginCtx.getExtensions<StoreProductUpdate>(STORE_PRODUCT_UPDATE)[0] ?? null;
}

export function resetContext(): void {
  ctx = null;
  extensionClient = null;
  transactionRunner = null;
  productRead = null;
  productUpdate = null;
}

/** The host plugin context (secrets/logger). */
export function pluginContext(): PluginContext {
  if (!ctx) throw new Error('zjmf.not_ready');
  return ctx;
}

/** The plugin's own extension client. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new Error('zjmf.not_ready');
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!transactionRunner) throw new Error('zjmf.not_ready');
  return transactionRunner(fn);
}

/** Store's product read capability (declared dependency). */
export function storeProductRead(): StoreProductRead {
  if (!productRead) throw new Error('zjmf.not_ready');
  return productRead;
}

/** Store's product mutation capability (declared dependency). */
export function storeProductUpdate(): StoreProductUpdate {
  if (!productUpdate) throw new Error('zjmf.not_ready');
  return productUpdate;
}
