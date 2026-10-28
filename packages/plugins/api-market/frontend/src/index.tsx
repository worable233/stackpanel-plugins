import type { FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { messages, t } from './i18n.js';

/**
 * Minimal frontend skeleton for the api-market plugin (plan 阶段 0 · 断言 4).
 *
 * P1 ships the HTTP surface only; this package exists so the kernel's frontend
 * readiness check (`/ready` → `pendingFrontends`) is satisfied once the plugin
 * is installed. The real catalog / key / usage pages are P2 and live in their
 * own spec.
 */

const catalogItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  category: z.string(),
  unitCost: z.number(),
});

const catalogSchema = z.object({ items: z.array(catalogItemSchema) });

/** Public catalog page rendered by the web shell under /api-market. */
function CatalogPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const catalog = catalogSchema.parse(props.data.catalog ?? { items: [] });
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">{tr('page.title')}</h1>
      {catalog.items.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">{tr('page.empty')}</p>
      ) : (
        <ul className="mt-6 divide-y">
          {catalog.items.map((item) => (
            <li key={item.slug} className="py-4">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="font-medium">{item.name}</h2>
                <span className="text-xs text-muted-foreground">
                  {tr('page.unitCost').replace('{units}', String(item.unitCost))}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  pages: [
    {
      path: '/api-market',
      component: 'api-market/catalog',
      data: [{ fetch: { path: '/api-market/catalog' }, as: 'catalog' }],
    },
  ],
  pageComponents: { 'api-market/catalog': CatalogPage },
};

export default frontend;
