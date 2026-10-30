/**
 * Challenge issuing and verification for a **self-hosted** ALTCHA proof of work.
 *
 * The whole protocol is two hashes, so it runs here with no external service and
 * no per-deployment key material from a vendor:
 *
 * 1. the server picks a random salt and a target `number`, then publishes
 *    `challenge = sha256(salt + number)`, `maxnumber` and
 *    `signature = hmac(challenge, key)`;
 * 2. the browser brute-forces `number` until the hashes match — that is the work;
 * 3. the server re-verifies the solution and the HMAC, so a token cannot be
 *    minted without solving, and cannot be replayed (see `singleUse` in the
 *    plugin, which also proves *we* issued it).
 *
 * Wire compatibility with the official widget (`altcha.min.js`) depends on two
 * things only: the field names of the challenge, and that the solution is
 * `sha256(salt + number)` in the same hex encoding. Both are honoured here.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const ALGORITHM = 'SHA-256';
/** Default search space. ~100k hashes is well under a second on a phone. */
export const DEFAULT_MAX_NUMBER = 100_000;
/** A challenge is worthless once the visitor has wandered off for ten minutes. */
export const DEFAULT_EXPIRES_MS = 10 * 60_000;

export interface ChallengeOptions {
  /** HMAC key (hex). Rotating it invalidates every outstanding challenge. */
  hmacKey: string;
  maxNumber?: number;
  /** `0` issues challenges that never expire — meant for tests only. */
  expiresMs?: number;
  /** Extra query parameters folded into the salt (e.g. the guarded action). */
  params?: Record<string, string>;
  /** Fixed `number`, for tests. */
  number?: number;
  /** Fixed base salt, for tests. */
  salt?: string;
  /** Injectable clock, for tests. */
  now?: number;
}

export interface Challenge {
  algorithm: typeof ALGORITHM;
  challenge: string;
  maxnumber: number;
  /** Random salt, with `?expires=…` and the `&` terminator the widget echoes back. */
  salt: string;
  signature: string;
}

export type VerifyFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'expired'
  | 'signature_mismatch'
  | 'solution_mismatch';

export type VerifyResult = { ok: true; id: string } | { ok: false; reason: VerifyFailure };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacHex(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** Constant-time comparison for two hex digests of equal length. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function createChallenge(options: ChallengeOptions): Challenge {
  const maxNumber = options.maxNumber ?? DEFAULT_MAX_NUMBER;
  const expiresMs = options.expiresMs ?? DEFAULT_EXPIRES_MS;
  const now = options.now ?? Date.now();

  let salt = options.salt ?? randomBytes(12).toString('hex');
  const params = new URLSearchParams(options.params ?? {});
  if (expiresMs > 0) params.set('expires', String(Math.floor((now + expiresMs) / 1000)));
  const query = params.toString();
  if (query) salt += `?${query}`;
  // The terminator keeps a caller-supplied parameter from spilling into the hash
  // input of the next field.
  if (!salt.endsWith('&')) salt += '&';

  const number = options.number ?? randomInt(Math.max(1, maxNumber));
  const challenge = sha256Hex(salt + number);
  return {
    algorithm: ALGORITHM,
    challenge,
    maxnumber: maxNumber,
    salt,
    signature: hmacHex(challenge, options.hmacKey),
  };
}

export interface Solution {
  algorithm: string;
  challenge: string;
  number: number;
  salt: string;
  signature: string;
}

/** Decode the base64 JSON the widget writes into the hidden field. */
export function decodeToken(token: string): Solution | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const { algorithm, challenge, number, salt, signature } = value;
  if (
    typeof algorithm !== 'string' ||
    typeof challenge !== 'string' ||
    typeof salt !== 'string' ||
    typeof signature !== 'string'
  ) {
    return null;
  }
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0) return null;
  return { algorithm, challenge, number, salt, signature };
}

/** `expires` is carried in the salt, which the widget echoes back verbatim. */
function expiresAt(salt: string): number | null {
  const query = salt.indexOf('?');
  if (query < 0) return null;
  const params = new URLSearchParams(salt.slice(query + 1).split('&')[0] ?? '');
  const raw = params.get('expires');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Verify one solution. Returns the challenge digest as `id` so the caller can
 * make it single-use without parsing the token a second time.
 */
export function verifySolution(
  token: string,
  options: { hmacKey: string; now?: number },
): VerifyResult {
  const solution = decodeToken(token);
  if (!solution) return { ok: false, reason: 'malformed' };
  if (solution.algorithm !== ALGORITHM) return { ok: false, reason: 'unsupported_algorithm' };

  const expires = expiresAt(solution.salt);
  if (expires !== null && expires <= (options.now ?? Date.now())) {
    return { ok: false, reason: 'expired' };
  }

  // Re-derive with the *submitted* salt: it is opaque to the server and must be
  // hashed verbatim, including the `?expires=…` it carries. A client cannot fake
  // `challenge` (the hash must match) and cannot fake `signature` (it does not
  // know the key).
  const challenge = sha256Hex(solution.salt + solution.number);
  if (!hexEqual(challenge, solution.challenge)) {
    return { ok: false, reason: 'solution_mismatch' };
  }
  if (!hexEqual(hmacHex(challenge, options.hmacKey), solution.signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, id: challenge };
}

