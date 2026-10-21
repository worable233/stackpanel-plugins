import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { z } from 'zod';
import {
  catalogProductModel,
  categoryModel,
  loadCategories,
  requireCategory,
  toProductData,
  type CategoryData,
  type CategoryRow,
  type ProductCatalogData,
} from './data.js';
import { CatalogError, extensions, runTransaction } from './context.js';
import { toNullable } from './utils.js';
import { buildCategoryForest, collectSubtreeIds } from './tree.js';

const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(191),
  slug: z.string().trim().max(191).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  icon: z.string().trim().max(32).nullable().optional(),
  parentId: z.string().trim().max(191).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

const categoryUpdateSchema = categoryCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要一个更新字段' });

/** 拖拽重排：整棵树的扁平顺序，父在前子紧跟其后（先序）。 */
const reorderSchema = z.object({
  /** 平行数组：id / parentId / sortOrder 按索引对应。parentId 为「__root__」表示顶级。 */
  ids: z.array(z.string().min(1).max(191)),
  parentIds: z.array(z.string().max(191)),
  sortOrders: z.array(z.coerce.number().int().min(0).max(9999)),
});

function categoryJson(row: CategoryRow): unknown {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findCategoryBySlug(slug: string, excludeId?: string): Promise<CategoryRow | null> {
  const categories = await loadCategories();
  return categories.find((category) => category.slug === slug && category.id !== excludeId) ?? null;
}

export async function listAdminCategories(): Promise<unknown> {
  const categories = await loadCategories();
  const counts = await import('./data.js').then((m) => m.loadCountsByCategory());
  return { categories: buildCategoryForest(categories, counts) };
}

export async function listPublicCategories(): Promise<unknown> {
  const categories = await loadCategories();
  const counts = await import('./data.js').then((m) => m.loadCountsByCategory());
  return { categories: buildCategoryForest(categories, counts) };
}

export async function createCategory(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const parsed = categoryCreateSchema.safeParse(req.body);
  if (!parsed.success) throw new CatalogError(400, '分类参数无效');
  const input = parsed.data;
  const parentId = toNullable(input.parentId) ?? null;
  if (parentId) await requireCategory(parentId);
  const slug = toNullable(input.slug) ?? null;
  if (slug && (await findCategoryBySlug(slug))) throw new CatalogError(409, '分类标识已存在');
  const data: CategoryData = {
    parentId,
    name: input.name,
    slug,
    description: input.description ?? null,
    icon: input.icon ?? null,
    sortOrder: input.sortOrder,
  };
  const instance = await extensions().create<CategoryData>(categoryModel, data);
  return reply.code(201).send({
    category: categoryJson({
      id: instance.name,
      ...data,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    }),
  });
}

export async function updateCategory(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new CatalogError(400, '缺少分类 ID');
  const parsed = categoryUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw new CatalogError(400, '分类参数无效');
  const input = parsed.data;
  const current = await requireCategory(id);
  const newParentId = toNullable(input.parentId ?? current.parentId) ?? null;
  if (newParentId) {
    if (newParentId === id) throw new CatalogError(400, '分类不能移动到自身');
    const subtree = collectSubtreeIds(await loadCategories(), id);
    if (subtree.includes(newParentId)) throw new CatalogError(400, '分类不能移动到其子分类下');
    await requireCategory(newParentId);
  }
  const newSlug = toNullable(input.slug);
  if (newSlug !== undefined && newSlug !== null && (await findCategoryBySlug(newSlug, id))) {
    throw new CatalogError(409, '分类标识已存在');
  }
  const next: CategoryData = {
    parentId: newParentId,
    name: input.name ?? current.name,
    slug: newSlug === undefined ? current.slug : newSlug,
    description:
      input.description === undefined ? current.description : (input.description ?? null),
    icon: input.icon === undefined ? current.icon : (input.icon ?? null),
    sortOrder: input.sortOrder ?? current.sortOrder,
  };
  const instance = await extensions().update<CategoryData>(categoryModel, id, next);
  return {
    category: categoryJson({
      id: instance.name,
      ...next,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    }),
  };
}

/**
 * 拖拽重排分类树：接收扁平节点列表，校验完整性后批量更新 parentId/sortOrder。
 * 通过比较当前库中分类集合，忽略不存在的 id，保证部分更新安全。
 */
export async function reorderCategories(req: HttpRequest): Promise<unknown> {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) throw new CatalogError(400, '排序参数无效');
  const { ids, parentIds, sortOrders } = parsed.data;
  if (ids.length === 0) return { ok: true };
  if (ids.length !== parentIds.length || ids.length !== sortOrders.length) {
    throw new CatalogError(400, '排序参数长度不一致');
  }
  const tree = ids.map((id, index) => ({
    id,
    parentId:
      parentIds[index] && parentIds[index].length > 0 && parentIds[index] !== '__root__'
        ? parentIds[index]
        : null,
    sortOrder: sortOrders[index],
  }));

  const existing = await loadCategories();
  const existingById = new Map(existing.map((category) => [category.id, category]));
  const unknownIds = tree.filter((node) => !existingById.has(node.id));
  if (unknownIds.length > 0) {
    throw new CatalogError(400, '排序列表包含不存在的分类');
  }

  // 校验所有引用到的 parentId 都存在（或为 null），且不属于自身后代。
  const treeIds = new Set(tree.map((node) => node.id));
  for (const node of tree) {
    if (node.parentId && !treeIds.has(node.parentId)) {
      throw new CatalogError(400, '排序列表的父分类缺失');
    }
  }

  await runTransaction(async (tx) => {
    for (const node of tree) {
      const row = existingById.get(node.id)!;
      const data: CategoryData = {
        parentId: node.parentId,
        name: row.name,
        slug: row.slug,
        description: row.description,
        icon: row.icon,
        sortOrder: node.sortOrder ?? 0,
      };
      await tx.extensions.update<CategoryData>(categoryModel, node.id, data);
    }
  });
  return { ok: true };
}

export async function deleteCategory(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new CatalogError(400, '缺少分类 ID');
  await requireCategory(id);
  const categories = await loadCategories();
  if (categories.some((category) => category.parentId === id)) {
    throw new CatalogError(409, '请先删除或移动子分类');
  }
  await runTransaction(async (tx) => {
    const products = await tx.extensions.listAll<ProductCatalogData>(catalogProductModel);
    for (const entry of products) {
      const data = await toProductData(entry.spec).catch(() => null);
      if (!data) continue;
      const remaining = data.categoryIds.filter((categoryId) => categoryId !== id);
      if (remaining.length !== data.categoryIds.length) {
        await tx.extensions.update<ProductCatalogData>(catalogProductModel, entry.name, {
          ...data,
          categoryIds: remaining,
        });
      }
    }
    await tx.extensions.delete(categoryModel, id);
  });
  return reply.code(204).send();
}
