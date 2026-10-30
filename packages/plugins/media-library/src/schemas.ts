import { z } from 'zod';

/**
 * Query contract of `GET /media-library/items`. Unknown keys are stripped (not
 * rejected): the console owns these params, but a stray analytics param must not
 * turn a list request into a 400.
 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  visibility: z.enum(['public', 'private']).optional(),
  kind: z.enum(['image', 'document', 'archive', 'video', 'audio', 'text', 'other']).optional(),
  q: z.string().trim().min(1).max(191).optional(),
  ownerId: z.string().trim().min(1).max(191).optional(),
});

/** `PATCH /media-library/items/:id` mirrors the kernel's editable fields. */
export const patchBodySchema = z
  .object({
    filename: z.string().trim().min(1).max(191).optional(),
    visibility: z.enum(['public', 'private']).optional(),
  })
  .strict()
  .refine((value) => value.filename !== undefined || value.visibility !== undefined, {
    message: '至少需要修改一个字段',
  });

/** `POST /media-library/variants/rebuild` — omit `attachmentId` to repair all. */
export const rebuildBodySchema = z
  .object({ attachmentId: z.string().trim().min(1).max(191).optional() })
  .strict();

/**
 * `POST /media-library/optimize` — batch WebP conversion of stored attachments.
 *
 * `attachmentId` is optional on purpose: the console sends `{}` to convert the
 * next batch (the kernel bounds each call), or one id for a targeted fix.
 */
export const optimizeBodySchema = z
  .object({ attachmentId: z.string().trim().min(1).max(191).optional() })
  .strict();
