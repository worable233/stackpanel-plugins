import { defineModel } from '@stackpanel/sdk';
import type { CustomModelDefinition } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * Content workflow models (F4/F5).
 *
 * All four models are plugin-owned Extension models: the kernel derives one real
 * table per model at activation (`ext_cms_post` …) and no Prisma schema change or
 * migration is required. The engine only supports additive schema evolution, so
 * fields/indexes are append-only relative to the original `cms/post`/`cms/page`
 * shapes (`slug`, `published` keep their position).
 */

/** Workflow states of a content item's working copy. */
export const CONTENT_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** The two content kinds the plugin manages. */
export const CONTENT_KINDS = {
  post: 'cms/post',
  page: 'cms/page',
} as const;
export type ContentKind = (typeof CONTENT_KINDS)[keyof typeof CONTENT_KINDS];

export const slugSchema = z
  .string()
  .min(1)
  .max(191)
  .regex(/^[a-z0-9-]+$/, 'slug 只能包含小写字母、数字和连字符');

/**
 * Fields shared by posts and pages.
 *
 * `title`/`slug`/`excerpt`/`body` are the **working copy** the editor touches.
 * The `published*` fields are a denormalised snapshot of the live revision, so
 * the public read path is a single query with no join to the revision table.
 */
const contentFields = {
  title: z.string().min(1).max(191),
  slug: slugSchema,
  excerpt: z.string().max(500).optional(),
  body: z.string().min(1),
  authorId: z.string().max(191).optional(),
  /** Working-copy workflow state (not the live URL state). */
  status: z.enum([...CONTENT_STATUSES]).default('draft'),
  /** Whether a live revision is currently served. */
  published: z.boolean().default(false),
  /** Unix epoch ms when a `scheduled` item should go live. */
  publishAt: z.number().int().nonnegative().optional(),
  /** Slug of the live revision, denormalised so it is queryable. */
  publishedSlug: z.string().max(191).optional(),
  /** Live snapshot fields (kept in step with `publishedRevisionId`). */
  publishedTitle: z.string().max(191).optional(),
  publishedExcerpt: z.string().max(500).optional(),
  publishedBody: z.string().optional(),
  /** Latest working revision pointer. */
  currentRevisionId: z.string().max(191).optional(),
  currentRevisionNumber: z.number().int().nonnegative().default(0),
  /** Live revision pointer. */
  publishedRevisionId: z.string().max(191).optional(),
  publishedRevisionNumber: z.number().int().nonnegative().default(0),
  /** Last actor to touch the working copy. */
  updatedBy: z.string().max(191).optional(),
  /** Content locale (BCP 47); omitted means the site default content language. */
  locale: z.string().max(35).optional(),
  /** Groups translations of the same item across locales (hreflang). */
  translationKey: z.string().max(191).optional(),
};

const postSchema = z.object(contentFields);
const pageSchema = z.object(contentFields);

/** Immutable snapshot of a content item at one point in time. */
export const revisionSchema = z.object({
  resourceKind: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(191),
  revisionNumber: z.number().int().positive(),
  title: z.string().min(1).max(191),
  slug: slugSchema,
  excerpt: z.string().max(500).optional(),
  body: z.string().min(1),
  authorId: z.string().max(191).optional(),
  /** Optional human note describing the change. */
  note: z.string().max(191).optional(),
});

/** A retired slug path that should 301 to its resource's current location. */
export const redirectSchema = z.object({
  fromPath: z.string().min(1).max(500),
  resourceKind: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(191),
  active: z.boolean().default(true),
});

export type RevisionSpec = z.infer<typeof revisionSchema>;
export type RedirectSpec = z.infer<typeof redirectSchema>;
export type ContentSpec = z.infer<typeof postSchema>;

export const postModel = defineModel({
  kind: CONTENT_KINDS.post,
  label: '文章',
  schema: postSchema,
  indexes: [
    { fields: ['slug'], types: { slug: 'string' } },
    { fields: ['published'], types: { published: 'boolean' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['publishAt'], types: { publishAt: 'number' } },
    { fields: ['publishedSlug'], types: { publishedSlug: 'string' } },
    { fields: ['locale'], types: { locale: 'string' } },
    { fields: ['translationKey'], types: { translationKey: 'string' } },
    // Append-only: the admin console filters the working copy by title.
    { fields: ['title'], types: { title: 'string' } },
  ],
});

export const pageModel = defineModel({
  kind: CONTENT_KINDS.page,
  label: '页面',
  schema: pageSchema,
  indexes: [
    { fields: ['slug'], types: { slug: 'string' } },
    { fields: ['published'], types: { published: 'boolean' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['publishAt'], types: { publishAt: 'number' } },
    { fields: ['publishedSlug'], types: { publishedSlug: 'string' } },
    { fields: ['locale'], types: { locale: 'string' } },
    { fields: ['translationKey'], types: { translationKey: 'string' } },
    // Append-only: the admin console filters the working copy by title.
    { fields: ['title'], types: { title: 'string' } },
  ],
});

export const revisionModel = defineModel({
  kind: 'cms/revision',
  label: '内容版本',
  schema: revisionSchema,
  indexes: [
    { fields: ['resourceId'], types: { resourceId: 'string' } },
    { fields: ['resourceKind'], types: { resourceKind: 'string' } },
    { fields: ['revisionNumber'], types: { revisionNumber: 'integer' } },
  ],
});

export const redirectModel = defineModel({
  kind: 'cms/redirect',
  label: '内容重定向',
  schema: redirectSchema,
  indexes: [
    { fields: ['fromPath'], types: { fromPath: 'string' }, unique: true },
    { fields: ['active'], types: { active: 'boolean' } },
  ],
});

/** Look up a content kind's model, or `undefined` for an unknown kind. */
export function contentModelFor(kind: string): CustomModelDefinition | undefined {
  if (kind === CONTENT_KINDS.post) return postModel;
  if (kind === CONTENT_KINDS.page) return pageModel;
  return undefined;
}
