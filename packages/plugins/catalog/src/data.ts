import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';
import { CatalogError, extensions } from './context.js';

export const CATEGORY_KIND = 'catalog/category';
export const PRODUCT_KIND = 'catalog/product';

/** Declared models. Storage, DDL and indexes are owned by the Extension engine. */
export const categoryModel = defineModel({
  kind: CATEGORY_KIND,
  label: '商品分类',
  schema: z.object({
    parentId: z.string().nullable(),
    name: z.string(),
    slug: z.string().nullable(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    sortOrder: z.number(),
  }),
  indexes: [
    { fields: ['parentId'], types: { parentId: 'string' } },
    { fields: ['slug'], types: { slug: 'string' } },
    { fields: ['sortOrder'], types: { sortOrder: 'integer' } },
  ],
});

export const catalogProductModel = defineModel({
  kind: PRODUCT_KIND,
  label: '商品分类关联',
  schema: z.object({
    productId: z.string(),
    categoryIds: z.array(z.string()),
    shelfStatus: z.enum(['ON', 'OFF']),
    sortOrder: z.number(),
  }),
  indexes: [
    { fields: ['productId'], types: { productId: 'string' } },
    { fields: ['shelfStatus'], types: { shelfStatus: 'string' } },
    { fields: ['sortOrder'], types: { sortOrder: 'integer' } },
  ],
});

export const categoryDataSchema = z.object({
  parentId: z.string().min(1).max(191).nullable(),
  name: z.string().min(1).max(191),
  slug: z.string().min(1).max(191).nullable(),
  description: z.string().max(500).nullable(),
  icon: z.string().max(32).nullable(),
  sortOrder: z.number().int().min(0).max(9999),
});

export type CategoryData = z.infer<typeof categoryDataSchema>;

export interface CategoryRow {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export const productDataSchema = z.object({
  productId: z.string().min(1).max(191),
  categoryIds: z.array(z.string().min(1).max(191)),
  shelfStatus: z.enum(['ON', 'OFF']),
  sortOrder: z.number().int().min(0).max(9999),
});

export type ProductCatalogData = z.infer<typeof productDataSchema>;

export interface CatalogListing {
  id: string;
  productId: string;
  categoryIds: string[];
  shelfStatus: 'ON' | 'OFF';
  sortOrder: number;
  createdAt: Date;
}

export async function toCategoryData(data: unknown): Promise<CategoryData> {
  const parsed = categoryDataSchema.safeParse(data);
  if (!parsed.success) throw new CatalogError(500, '分类数据已损坏');
  return parsed.data;
}

export async function toProductData(data: unknown): Promise<ProductCatalogData> {
  const parsed = productDataSchema.safeParse(data);
  if (!parsed.success) throw new CatalogError(500, '上架数据已损坏');
  return parsed.data;
}

export async function loadCategories(): Promise<CategoryRow[]> {
  const items = await extensions().listAll<CategoryData>(categoryModel, {
    orderBy: { field: 'createdAt' },
  });
  const categories: CategoryRow[] = [];
  for (const item of items) {
    const data = await toCategoryData(item.spec).catch(() => null);
    if (!data) continue;
    categories.push({
      id: item.name,
      parentId: data.parentId,
      name: data.name,
      slug: data.slug,
      description: data.description,
      icon: data.icon,
      sortOrder: data.sortOrder,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return categories;
}

export async function requireCategory(id: string): Promise<CategoryRow> {
  const item = await extensions().get<CategoryData>(categoryModel, id);
  if (!item) throw new CatalogError(404, '分类不存在');
  const data = await toCategoryData(item.spec);
  return {
    id: item.name,
    parentId: data.parentId,
    name: data.name,
    slug: data.slug,
    description: data.description,
    icon: data.icon,
    sortOrder: data.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function loadCatalogProducts(shelf: 'ON' | 'OFF' | null): Promise<CatalogListing[]> {
  const items = await extensions().listAll<ProductCatalogData>(
    catalogProductModel,
    shelf ? { where: { shelfStatus: { eq: shelf } } } : undefined,
  );
  const listings: CatalogListing[] = [];
  for (const item of items) {
    const data = await toProductData(item.spec).catch(() => null);
    if (!data) continue;
    listings.push({
      id: item.name,
      productId: data.productId,
      categoryIds: data.categoryIds,
      shelfStatus: data.shelfStatus,
      sortOrder: data.sortOrder,
      createdAt: item.createdAt,
    });
  }
  return listings;
}

/** Count products per category (all shelf states). */
export async function loadCountsByCategory(): Promise<Map<string, number>> {
  const listings = await loadCatalogProducts(null);
  const counts = new Map<string, number>();
  for (const entry of listings) {
    for (const categoryId of entry.categoryIds) {
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
    }
  }
  return counts;
}
