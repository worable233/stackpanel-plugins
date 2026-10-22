import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Plugin-owned credential hashing for ZJMF-compat connections.
 *
 * These are not platform users: legacy ZJMF clients send a username/password,
 * which we verify against the plugin's own scrypt hash. The platform anchor user
 * (`connection.userId`) is a separate, kernel-owned identity.
 */
export interface CredentialHash {
  hash: string;
  salt: string;
}

const KEY_LENGTH = 64;

export function hashCredential(password: string): CredentialHash {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return { hash, salt };
}

/** Constant-time verification; never throws on malformed stored material. */
export function verifyCredential(password: string, hash: string, salt: string): boolean {
  try {
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(password, salt, expected.length || KEY_LENGTH);
    return expected.length > 0 && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Generate an opaque, URL-safe client session token. */
export function issueToken(): string {
  return randomBytes(32).toString('base64url');
}
