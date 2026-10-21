import type { HttpRequest } from '@stackpanel/sdk';
import { z } from 'zod';
import {
  catalogProductModel,
  loadCatalogProducts,
  loadCategories,
  toProductData,
  type CatalogListing,
  type ProductCatalogData,
} from './data.js';
import { requireCategory } from './data.js';
import { CatalogError, extensions } from './context.js';
import { parsePagination } from './utils.js';
import { collectSubtreeIds } from './tree.js';

export interface StoreProductRead {
  listAll(): Promise<ProductSummary[]>;
  listByIds(ids: string[]): Promise<ProductSummary[]>;
  getById(id: string): Promise<ProductSummary | null>;
}

export interface StoreProductUpdate {
  updateStock(productId: string, stock: number): Promise<boolean>;
}

export interface ProductSummary {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  createdAt: Date;
  metadata: unknown;
}

let productReader: StoreProductRead | null = null;
let productUpdater: StoreProductUpdate | null = null;

export function bindProductServices(
  reader: StoreProductRead | null,
  updater: StoreProductUpdate | null,
): void {
  productReader = reader;
  productUpdater = updater;
}

function requireProductReader(): StoreProductRead {
  if (!productReader) throw new CatalogError(503, '商店商品数据不可用');
  return productReader;
}

function productJson(product: ProductSummary): unknown {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    currency: product.currency,
    stock: product.stock,
    status: product.status,
    metadata: product.metadata ?? null,
  };
}

async function findProductCatalogEntry(productId: string): Promise<{
  id: string;
  data: ProductCatalogData;
} | null> {
  const result = await extensions().list<ProductCatalogData>(catalogProductModel, {
    where: { productId: { eq: productId } },
    page: 1,
    pageSize: 1,
  });
  const item = result.items[0];
  if (!item) return null;
  const data = await toProductData(item.spec).catch(() => null);
  return data ? { id: item.name, data } : null;
}

export async function listPublicProducts(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const rawCategoryId = req.query['categoryId'];
  const rawQuery = req.query['q'];
  const rawShowAll = req.query['showAll'];
  const query =
    typeof rawQuery === 'string' && rawQuery.trim().length > 0
      ? rawQuery.trim().toLowerCase()
      : undefined;

  const categories = await loadCategories();
  let categoryId =
    typeof rawCategoryId === 'string' && rawCategoryId.length > 0 ? rawCategoryId : undefined;
  const showAll = rawShowAll === '1' || rawShowAll === 'true';
  if (showAll) {
    categoryId = undefined;
  } else if (!categoryId) {
    // 默认展示第一个子分类：排序最前的顶级分类（若有子分类则取其第一个）。
    const sorted = [...categories].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const roots = sorted.filter((category) => category.parentId === null);
    if (roots.length > 0) {
      const firstRoot = roots[0]!;
      const firstChild = sorted
        .filter((category) => category.parentId === firstRoot.id)
        .sort(
          (a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
      categoryId = firstChild?.id ?? firstRoot.id;
    }
  }

  let categoryIds: string[] = [];
  if (categoryId) {
    const row = categories.find((candidate) => candidate.id === categoryId);
    if (!row) throw new CatalogError(404, '分类不存在');
    categoryIds = collectSubtreeIds(categories, categoryId);
  }

  const reader = requireProductReader();
  let listings = await loadCatalogProducts('ON');
  let allStoreProducts: ProductSummary[] = [];
  if (showAll) {
    allStoreProducts = await reader.listAll();
  }
  const filtered = listings.filter((entry) => {
    if (showAll) return true;
    if (categoryIds.length > 0) {
      return entry.categoryIds.some((id) => categoryIds.includes(id));
    }
    return entry.categoryIds.length > 0;
  });
  const productsById = new Map(
    (await reader.listByIds(listings.map((entry) => entry.productId))).map((product) => [
      product.id,
      product,
    ]),
  );
  // 组装展示条目：分类筛选模式下用 catalog 记录；showAll 模式合并所有 store 商品。
  const entries: Array<{
    product: ProductSummary;
    listing: CatalogListing | null;
  }> = [];
  if (showAll) {
    const listingById = new Map(filtered.map((entry) => [entry.productId, entry]));
    for (const product of allStoreProducts) {
      if (product.status !== 'ACTIVE') continue;
      if (query && !product.name.toLowerCase().includes(query)) continue;
      entries.push({ product, listing: listingById.get(product.id) ?? null });
    }
    entries.sort(
      (left, right) =>
        right.product.createdAt.getTime() - left.product.createdAt.getTime() ||
        right.product.id.localeCompare(left.product.id),
    );
  } else {
    for (const entry of filtered) {
      const product = productsById.get(entry.productId);
      if (!product || product.status !== 'ACTIVE') continue;
      if (query && !product.name.toLowerCase().includes(query)) continue;
      entries.push({ product, listing: entry });
    }
    entries.sort(
      (left, right) =>
        (right.listing?.sortOrder ?? 0) - (left.listing?.sortOrder ?? 0) ||
        (right.listing?.createdAt.getTime() ?? 0) - (left.listing?.createdAt.getTime() ?? 0),
    );
  }
  const total = entries.length;
  const pageRows = entries.slice((page - 1) * pageSize, page * pageSize);
  return {
    products: pageRows.map(({ product, listing }) => ({
      catalog: listing
        ? {
            id: listing.id,
            categoryIds: listing.categoryIds,
            shelfStatus: listing.shelfStatus,
            sortOrder: listing.sortOrder,
          }
        : null,
      product: productJson(product),
    })),
    total,
    page,
    pageSize,
    categoryId: categoryId ?? null,
    query: query ?? null,
  };
}

export async function listAdminProducts(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const rawCategoryId = req.query['categoryId'];
  const categoryId =
    typeof rawCategoryId === 'string' && rawCategoryId.length > 0 ? rawCategoryId : undefined;
  const rawShelf = req.query['shelf'];
  const shelf = rawShelf === 'ON' || rawShelf === 'OFF' ? rawShelf : undefined;
  if (categoryId) await requireCategory(categoryId);

  let listings = await loadCatalogProducts(null);
  if (categoryId) {
    listings = listings.filter((entry) => entry.categoryIds.includes(categoryId));
  }
  if (shelf) {
    listings = listings.filter((entry) => entry.shelfStatus === shelf);
  }
  const reader = requireProductReader();
  const listingByProduct = new Map(listings.map((entry) => [entry.productId, entry]));
  const scoped = await reader.listByIds([...listingByProduct.keys()]);
  const products =
    categoryId === undefined && shelf === undefined ? await reader.listAll() : scoped;
  products.sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
  );
  const total = products.length;
  const pageRows = products.slice((page - 1) * pageSize, page * pageSize);
  return {
    products: pageRows.map((product) => {
      const entry = listingByProduct.get(product.id);
      return {
        product: productJson(product),
        catalog: entry
          ? {
              id: entry.id,
              categoryIds: entry.categoryIds,
              shelfStatus: entry.shelfStatus,
              sortOrder: entry.sortOrder,
            }
          : null,
      };
    }),
    total,
    page,
    pageSize,
  };
}

const productUpdateSchema = z
  .object({
    categoryIds: z.array(z.string().min(1).max(191)).optional(),
    shelfStatus: z.enum(['ON', 'OFF']).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    stock: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要一个更新字段' });

export async function updateAdminProduct(req: HttpRequest): Promise<unknown> {
  const productId = req.params['productId'];
  if (!productId) throw new CatalogError(400, '缺少商品 ID');
  const parsed = productUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw new CatalogError(400, '上架参数无效');
  const input = parsed.data;
  if (input.categoryIds !== undefined) {
    const categories = await loadCategories();
    const validIds = new Set(categories.map((category) => category.id));
    for (const categoryId of input.categoryIds) {
      if (!validIds.has(categoryId)) {
        throw new CatalogError(400, `分类不存在：${categoryId}`);
      }
    }
  }
  if (input.stock !== undefined) {
    if (!productUpdater) throw new CatalogError(503, '商店库存服务不可用');
    const updated = await productUpdater.updateStock(productId, input.stock);
    if (!updated) throw new CatalogError(404, '商品不存在');
  } else {
    const product = await requireProductReader().getById(productId);
    if (!product) throw new CatalogError(404, '商品不存在');
  }
  const hasCatalogChange =
    input.categoryIds !== undefined ||
    input.shelfStatus !== undefined ||
    input.sortOrder !== undefined;
  const existing = await findProductCatalogEntry(productId);
  if (hasCatalogChange) {
    if (existing) {
      const next: ProductCatalogData = {
        productId,
        categoryIds: input.categoryIds ?? existing.data.categoryIds,
        shelfStatus: input.shelfStatus ?? existing.data.shelfStatus,
        sortOrder: input.sortOrder ?? existing.data.sortOrder,
      };
      await extensions().update<ProductCatalogData>(catalogProductModel, existing.id, next);
    } else {
      const next: ProductCatalogData = {
        productId,
        categoryIds: input.categoryIds ?? [],
        shelfStatus: input.shelfStatus ?? 'ON',
        sortOrder: input.sortOrder ?? 0,
      };
      await extensions().create<ProductCatalogData>(catalogProductModel, next);
    }
  }
  const product = await requireProductReader().getById(productId);
  if (!product) throw new CatalogError(404, '商品不存在');
  const entry = await findProductCatalogEntry(productId);
  return {
    product: productJson(product),
    catalog: entry
      ? {
          id: entry.id,
          categoryIds: entry.data.categoryIds,
          shelfStatus: entry.data.shelfStatus,
          sortOrder: entry.data.sortOrder,
        }
      : null,
  };
}
