import { definePlugin, PluginError } from '@stackpanel/sdk';
import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { CATEGORY_KIND, PRODUCT_KIND, catalogProductModel, categoryModel } from './data.js';
import {
  listAdminCategories,
  listPublicCategories,
  createCategory,
  updateCategory,
  reorderCategories,
  deleteCategory,
} from './categories.js';
import {
  bindProductServices,
  listAdminProducts,
  listPublicProducts,
  updateAdminProduct,
  type StoreProductRead,
  type StoreProductUpdate,
} from './products.js';
import { CatalogError, bindExtensions, clearExtensions, extensions } from './context.js';

const STORE_PRODUCT_READ = 'store.product.read';
const STORE_PRODUCT_UPDATE = 'store.product.update';

/**
 * 商品分类插件（单分类树）。
 *
 * 单一分类树，支持无限层级；分类可配置 emoji 图标；商品在自身设置页选择
 * 一个或多个分类。前台按分类树浏览商品，未分类商品默认不展示，除非开启
 * 「展示全部服务」。
 *
 * 数据经 Extension 引擎（`ctx.extensions`）读写，插件不再接触裸 DB。
 */

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof CatalogError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

/**
 * 迁移 v1 数据：删除仍带 `catalogId` 的旧分类（多目录结构）。导入时 schema 会
 * 丢弃未知字段，故这里只做兜底清理；缺 `categoryIds` 的旧上架记录在导入阶段
 * 已被 schema 拒绝。
 */
async function migrateLegacyData(): Promise<void> {
  const categories = await extensions().listAll<Record<string, unknown>>(categoryModel);
  for (const category of categories) {
    if ((category.spec as { catalogId?: unknown }).catalogId !== undefined) {
      await extensions().delete(categoryModel, category.name);
    }
  }
}

export const catalogPlugin = definePlugin({
  manifest: {
    id: 'catalog',
    name: '商品分类',
    version: '0.4.0',
    description: '单一分类树：商品在设置页选择分类，前台按分类树浏览服务。',
    requires: ['store'],
    consumes: [
      { pluginId: 'store', extensionPoint: STORE_PRODUCT_READ, optional: false },
      { pluginId: 'store', extensionPoint: STORE_PRODUCT_UPDATE, optional: false },
    ],
    permissions: ['catalog.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['catalog.admin'] }],
    // Open-platform surface: every entry mirrors one internal route below and
    // dispatches to the *same* handler, so the alias never widens auth.
    capabilities: [
      {
        id: 'catalog.admin.categories.list',
        method: 'GET',
        route: '/catalog/admin/categories',
        path: '/api/v1/catalog/admin/categories',
        summary: 'List the category tree (admin view)',
        scope: 'catalog.admin',
      },
      {
        id: 'catalog.admin.categories.create',
        method: 'POST',
        route: '/catalog/admin/categories',
        path: '/api/v1/catalog/admin/categories',
        summary: 'Create a category',
        scope: 'catalog.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'catalog.admin.categories.update',
        method: 'PATCH',
        route: '/catalog/admin/categories/:id',
        path: '/api/v1/catalog/admin/categories/:id',
        summary: 'Update a category; params: {id}',
        scope: 'catalog.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'catalog.admin.categories.reorder',
        method: 'POST',
        route: '/catalog/admin/categories/reorder',
        path: '/api/v1/catalog/admin/categories/reorder',
        summary: 'Reorder the category tree',
        scope: 'catalog.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'catalog.admin.categories.delete',
        method: 'DELETE',
        route: '/catalog/admin/categories/:id',
        path: '/api/v1/catalog/admin/categories/:id',
        summary: 'Delete a category; params: {id}',
        scope: 'catalog.admin',
        mutating: true,
        destructive: true,
      },
      {
        id: 'catalog.admin.products.list',
        method: 'GET',
        route: '/catalog/admin/products',
        path: '/api/v1/catalog/admin/products',
        summary: 'List products with their category assignment',
        scope: 'catalog.admin',
      },
      {
        id: 'catalog.admin.products.update',
        method: 'PATCH',
        route: '/catalog/admin/products/:productId',
        path: '/api/v1/catalog/admin/products/:productId',
        summary: 'Assign a product to a category; params: {productId}',
        scope: 'catalog.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'catalog.categories.list',
        method: 'GET',
        route: '/catalog/categories',
        path: '/api/v1/catalog/categories',
        summary: 'Public category tree',
      },
      {
        id: 'catalog.products.list',
        method: 'GET',
        route: '/catalog/products',
        path: '/api/v1/catalog/products',
        summary: 'Public product listing',
      },
    ],
  },
  customModels: [categoryModel, catalogProductModel],
  routes: [
    {
      method: 'GET',
      path: '/catalog/categories',
      auth: 'public',
      handler: handle(listPublicCategories),
    },
    {
      method: 'GET',
      path: '/catalog/products',
      auth: 'public',
      handler: handle(listPublicProducts),
    },
    {
      method: 'GET',
      path: '/catalog/admin/categories',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(listAdminCategories),
    },
    {
      method: 'POST',
      path: '/catalog/admin/categories',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(createCategory),
    },
    {
      method: 'PATCH',
      path: '/catalog/admin/categories/:id',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(updateCategory),
    },
    {
      method: 'POST',
      path: '/catalog/admin/categories/reorder',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(reorderCategories),
    },
    {
      method: 'DELETE',
      path: '/catalog/admin/categories/:id',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(deleteCategory),
    },
    {
      method: 'GET',
      path: '/catalog/admin/products',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(listAdminProducts),
    },
    {
      method: 'PATCH',
      path: '/catalog/admin/products/:productId',
      auth: 'admin',
      permission: 'catalog.admin',
      handler: handle(updateAdminProduct),
    },
  ],
  onActivate: async (ctx) => {
    bindExtensions(ctx.extensions, ctx.tx);
    await migrateLegacyData();
    const [reader, updater] = [
      ctx.getExtensions<StoreProductRead>(STORE_PRODUCT_READ)[0] ?? null,
      ctx.getExtensions<StoreProductUpdate>(STORE_PRODUCT_UPDATE)[0] ?? null,
    ];
    bindProductServices(reader, updater);
    ctx.logger.info('catalog: activated (v0.4.0 extension engine)');
  },
  onDeactivate: (ctx) => {
    clearExtensions();
    bindProductServices(null, null);
    ctx.logger.info('catalog: deactivated');
  },
});

export { CATEGORY_KIND, PRODUCT_KIND, catalogProductModel, categoryModel };
export default catalogPlugin;
