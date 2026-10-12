import type {
  AuthService,
  ExtensionClient,
  ExtensionTransaction,
  PluginContext,
  PluginLogger,
  PluginSecrets,
  StateService,
  WalletService,
} from '@stackpanel/sdk';

let ctx: PluginContext | null = null;
let extensionClient: ExtensionClient | null = null;
let transactionRunner: (<T>(fn: (tx: ExtensionTransaction) => Promise<T>) => Promise<T>) | null = null;
let authService: AuthService | null = null;
let walletService: WalletService | null = null;
let stateService: StateService | null = null;
let secretsService: PluginSecrets | null = null;
let loggerService: PluginLogger | null = null;

export function bindContext(pluginCtx: PluginContext): void {
  ctx = pluginCtx;
  extensionClient = pluginCtx.extensions;
  transactionRunner = pluginCtx.tx;
  authService = pluginCtx.auth;
  walletService = pluginCtx.wallet;
  stateService = pluginCtx.state;
  secretsService = pluginCtx.secrets;
  loggerService = pluginCtx.logger;
}

export function resetContext(): void {
  ctx = null;
  extensionClient = null;
  transactionRunner = null;
  authService = null;
  walletService = null;
  stateService = null;
  secretsService = null;
  loggerService = null;
}

/** The plugin's own extension client. */
export function extensions(): ExtensionClient {
  if (!extensionClient) throw new Error('llm-gateway.not_ready');
  return extensionClient;
}

/** Run a set of writes atomically through `ctx.tx`. */
export function runTransaction<T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> {
  if (!transactionRunner) throw new Error('llm-gateway.not_ready');
  return transactionRunner(fn);
}

export function auth(): AuthService {
  if (!authService) throw new Error('llm-gateway.not_ready');
  return authService;
}

export function wallet(): WalletService {
  if (!walletService) throw new Error('llm-gateway.not_ready');
  return walletService;
}

export function state(): StateService {
  if (!stateService) throw new Error('llm-gateway.not_ready');
  return stateService;
}

export function secrets(): PluginSecrets {
  if (!secretsService) throw new Error('llm-gateway.not_ready');
  return secretsService;
}

export function logger(): PluginLogger {
  if (!loggerService) throw new Error('llm-gateway.not_ready');
  return loggerService;
}

export function pluginContext(): PluginContext {
  if (!ctx) throw new Error('llm-gateway.not_ready');
  return ctx;
}
