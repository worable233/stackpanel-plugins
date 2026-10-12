/**
 * Structural mirrors of the store plugin's product capabilities
 * (`store.product.read` / `store.product.update`). The store plugin owns the
 * implementation; consumers only rely on this shape, mirroring the catalog
 * plugin's pattern.
 */

export interface StoreProductSummary {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  categoryId: string | null;
  fulfillmentType: string;
  providerId: string | null;
  providerProductId: string | null;
  createdAt: Date;
  metadata: unknown;
}

export interface StoreProductRead {
  listAll(): Promise<StoreProductSummary[]>;
  listByIds(ids: string[]): Promise<StoreProductSummary[]>;
  getById(id: string): Promise<StoreProductSummary | null>;
}

export interface StoreProductMutation {
  name: string;
  price: number;
  currency: string;
  stock: number;
  status?: string;
  description?: string | null;
  metadata?: unknown;
  fulfillmentType?: string;
  providerId?: string | null;
  providerProductId?: string | null;
}

export type StoreProductPatch = Partial<StoreProductMutation>;

export interface StoreProductUpdate {
  updateStock(productId: string, stock: number): Promise<boolean>;
  create(input: StoreProductMutation): Promise<StoreProductSummary>;
  update(productId: string, patch: StoreProductPatch): Promise<StoreProductSummary | null>;
  remove(productId: string): Promise<boolean>;
}
