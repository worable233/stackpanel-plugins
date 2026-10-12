import type { FinderProvider, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';

interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  productCount: number;
  children: CategoryNode[];
}

const categoryNodeSchema: z.ZodType<CategoryNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    slug: z.string().nullable(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    sortOrder: z.number(),
    productCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    children: z.array(categoryNodeSchema),
  }),
);

const categoriesSchema = z.object({ categories: z.array(categoryNodeSchema) });

const catalogProductSchema = z.object({
  catalog: z
    .object({
      id: z.string(),
      categoryIds: z.array(z.string()),
      shelfStatus: z.string(),
      sortOrder: z.number(),
    })
    .nullable(),
  product: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    price: z.number(),
    currency: z.string(),
    stock: z.number(),
    status: z.string(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  }),
});

const adminProductsSchema = z.object({
  products: z.array(catalogProductSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const catalogProductsSchema = z.object({
  products: z.array(catalogProductSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  categoryId: z.string().nullable(),
  query: z.string().nullable(),
});

const catalogFinders: Record<string, FinderProvider> = {  'catalog.categories': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/catalog/categories', categoriesSchema)).categories,
  },
  'catalog.products': {
    handler: async (input, ctx) => {
      const query = new URLSearchParams();
      query.set('page', coercePositiveInt(input.page, 1));
      query.set('pageSize', coercePositiveInt(input.pageSize, 60));
      if (typeof input.categoryId === 'string' && input.categoryId) {
        query.set('categoryId', input.categoryId);
      }
      if (typeof input.showAll === 'string' && input.showAll === '1') {
        query.set('showAll', '1');
      }
      if (typeof input.q === 'string' && input.q.trim()) {
        query.set('q', input.q.trim());
      }
      return ctx.api.get(`/catalog/products?${query.toString()}`, catalogProductsSchema);
    },
  },
  'catalog.adminCategories': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/catalog/admin/categories', categoriesSchema)).categories,
  },
  'catalog.adminProducts': {
    handler: async (_input, ctx) =>
      ctx.api.get('/catalog/admin/products?page=1&pageSize=100', adminProductsSchema),
  },
};

function coercePositiveInt(value: unknown, fallback: number): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1) {
    return String(fallback);
  }
  return String(numeric);
}

export const frontend: FrontendPackage = {
  finders: catalogFinders,
  ui: {
    actions: [
      {
        id: 'catalog.create-category',
        method: 'POST',
        path: '/catalog/admin/categories',
        permission: 'catalog.admin',
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 191 },
          { name: 'icon', type: 'string', maxLength: 32 },
          { name: 'parentId', type: 'string', maxLength: 191 },
          { name: 'sortOrder', type: 'integer', default: 0, min: 0, max: 9999 },
        ],
      },
      {
        id: 'catalog.update-category',
        method: 'PATCH',
        path: '/catalog/admin/categories/:id',
        permission: 'catalog.admin',
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', maxLength: 191 },
          { name: 'icon', type: 'string', maxLength: 32 },
          { name: 'parentId', type: 'string', maxLength: 191 },
          { name: 'sortOrder', type: 'integer', min: 0, max: 9999 },
        ],
      },
      {
        id: 'catalog.reorder-categories',
        method: 'POST',
        path: '/catalog/admin/categories/reorder',
        permission: 'catalog.admin',
        input: [
          { name: 'ids', type: 'ids' },
          { name: 'parentIds', type: 'ids' },
          { name: 'sortOrders', type: 'ids' },
        ],
      },
      {
        id: 'catalog.delete-category',
        method: 'DELETE',
        path: '/catalog/admin/categories/:id',
        permission: 'catalog.admin',
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'catalog.update-product',
        method: 'PATCH',
        path: '/catalog/admin/products/:productId',
        permission: 'catalog.admin',
        input: [
          { name: 'productId', type: 'string', required: true, maxLength: 191 },
          { name: 'categoryIds', type: 'ids' },
          { name: 'shelfStatus', type: 'string' },
          { name: 'sortOrder', type: 'integer', min: 0, max: 9999 },
          { name: 'stock', type: 'integer', min: 0, max: 1000000 },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/categories',
        component: 'admin/categories',
        permission: 'catalog.admin',
        nav: { label: '商品分类', group: '商店插件' },
        data: [{ finder: 'catalog.adminCategories', as: 'categories' }],
      },
    ],
  },
};

export default frontend;
