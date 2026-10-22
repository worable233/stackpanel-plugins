import { PluginError } from '@stackpanel/sdk';

/**
 * Stable, namespaced error codes for the CMS content workflow (ADR-0012 §2).
 *
 * `ContentError` extends {@link PluginError} so the kernel's error boundary
 * renders it as an RFC 7807 problem verbatim — the plugin owns the code and the
 * HTTP status, and the UI localises by `code`.
 */
export class ContentError extends PluginError {
  constructor(code: string, status: number, detail: string) {
    super(code, status, detail);
    this.name = 'ContentError';
  }
}

/** Raised when the plugin has not been activated yet (handler ran too early). */
export function notReady(): ContentError {
  return new ContentError('cms.not_ready', 503, 'CMS 插件未就绪');
}
