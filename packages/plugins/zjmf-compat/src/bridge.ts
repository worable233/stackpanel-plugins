import type { CommerceOperations, CommerceProduct, CommerceService } from '@stackpanel/sdk';

/**
 * The narrow upstream surface the ZJMF-compat protocol layer is written against.
 *
 * It intentionally mirrors the platform's domain capabilities (catalog / order /
 * delivery) rather than any ZJMF wire detail, so the protocol translation is
 * unit-testable with a stub and the production adapter simply delegates to the
 * `commerce` outlet (the same truth SP v1 and the admin console use). No ZJMF
 * business logic is re-implemented here.
 */
export interface SpV1Product {
  id: string;
  name: string;
  description: string | null;
  /** Minor units, matching the platform's commerce representation. */
  price: number;
  currency: string;
  stock: number;
  status: string;
}

export interface SpV1Order {
  id: string;
  total: number;
  currency: string;
  status: string;
}

export interface SpV1Service {
  id: string;
  productId: string;
  productName: string;
  status: string;
}

export type SpV1ServiceAction = 'suspend' | 'resume' | 'terminate';

export interface SpV1Client {
  listProducts(): Promise<{ items: SpV1Product[]; currency: string | null }>;
  getProduct(id: string): Promise<SpV1Product | null>;
  createOrder(input: { productId: string; quantity: number }): Promise<SpV1Order>;
  listServices(): Promise<SpV1Service[]>;
  getService(id: string): Promise<SpV1Service | null>;
  lifecycle(id: string, action: SpV1ServiceAction): Promise<SpV1Service | null>;
}

function toProduct(row: CommerceProduct): SpV1Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    currency: row.currency,
    stock: row.stock,
    status: row.status,
  };
}

function toService(row: CommerceService): SpV1Service {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.productName,
    status: row.status,
  };
}

const CATALOG_PAGE = 200;
const CATALOG_MAX_PAGES = 10;

/**
 * Production adapter: the connection's anchor user scopes every operation, and
 * an optional product allow-list hides the rest of the catalog from the client.
 */
export function commerceClient(
  ops: CommerceOperations,
  userId: string,
  productIds: readonly string[],
): SpV1Client {
  const allowed = new Set(productIds);
  const expose = (product: SpV1Product): boolean => allowed.size === 0 || allowed.has(product.id);

  async function loadCatalog(): Promise<{ items: SpV1Product[]; currency: string | null }> {
    const items: SpV1Product[] = [];
    let currency: string | null = null;
    let page = 1;
    while (page <= CATALOG_MAX_PAGES) {
      const result = await ops.listCatalog({ page, pageSize: CATALOG_PAGE });
      for (const row of result.items) {
        if (!expose(toProduct(row))) continue;
        items.push(toProduct(row));
        currency ??= row.currency;
      }
      if (result.items.length === 0 || items.length >= result.total) break;
      page += 1;
    }
    return { items, currency };
  }

  return {
    async listProducts() {
      return loadCatalog();
    },
    async getProduct(id) {
      const product = await ops.getCatalogItem(id);
      if (!product) return null;
      const mapped = toProduct(product);
      return expose(mapped) ? mapped : null;
    },
    async createOrder(input) {
      const order = await ops.createOrder({
        userId,
        productId: input.productId,
        quantity: input.quantity,
        channelCode: 'ZJMF_COMPAT',
      });
      return {
        id: order.id,
        total: order.total,
        currency: order.currency,
        status: order.status,
      };
    },
    async listServices() {
      const rows = await ops.listServices(userId);
      return rows.map(toService);
    },
    async getService(id) {
      const row = await ops.getService(userId, id);
      return row ? toService(row) : null;
    },
    async lifecycle(id, action) {
      const row = await ops.runServiceLifecycle(userId, id, action);
      return row ? toService(row) : null;
    },
  };
}
