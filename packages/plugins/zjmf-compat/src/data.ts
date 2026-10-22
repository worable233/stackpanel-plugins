import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * A ZJMF-compat connection: one legacy client identity bound to a platform user
 * anchor. Credentials are plugin-owned (scrypt hash + salt); the anchor user is
 * the platform principal whose catalog / orders / services the client sees.
 */
export const connectionSchema = z.object({
  name: z.string().min(1).max(100),
  username: z.string().min(1).max(100),
  passwordHash: z.string().min(1),
  passwordSalt: z.string().min(1),
  /** Platform user id used as the order / service ownership anchor. */
  userId: z.string().min(1),
  enabled: z.boolean(),
  /** When non-empty, only these catalog product ids are exposed. */
  productIds: z.array(z.string()).default([]),
});

export type ConnectionData = z.infer<typeof connectionSchema>;

export const zjmfConnectionModel = defineModel({
  kind: 'zjmf-compat/connection',
  label: '魔方兼容连接',
  readPermission: 'zjmf-compat.admin',
  permission: 'zjmf-compat.admin',
  schema: connectionSchema,
  indexes: [
    { fields: ['username'], types: { username: 'string' }, unique: true },
    { fields: ['enabled'], types: { enabled: 'boolean' } },
  ],
  retention: 'delete',
});
