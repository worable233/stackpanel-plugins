import { z } from 'zod';

/** 前端 select 在「无值」时提交的哨兵值。 */
export const NONE = '__none__';

export function toNullable(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === '' || value === NONE ? null : value;
}

export function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const parsed = z
    .object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    })
    .safeParse(query);
  return parsed.success ? parsed.data : { page: 1, pageSize: 20 };
}
