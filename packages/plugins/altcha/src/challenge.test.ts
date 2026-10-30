import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALGORITHM,
  DEFAULT_MAX_NUMBER,
  createChallenge,
  decodeToken,
  verifySolution,
} from './challenge.js';

const KEY = 'a'.repeat(64);

/** Brute-force the number the way the widget does. */
function solve(salt: string, challenge: string, maxNumber: number): number {
  for (let n = 0; n < maxNumber; n += 1) {
    if (createHash('sha256').update(salt + n).digest('hex') === challenge) return n;
  }
  return -1;
}

function token(salt: string, challenge: string, number: number, signature: string): string {
  return Buffer.from(
    JSON.stringify({ algorithm: ALGORITHM, challenge, number, salt, signature }),
  ).toString('base64');
}

describe('createChallenge', () => {
  it('issues a solvable challenge whose hash is sha256(salt + number)', () => {
    const challenge = createChallenge({ hmacKey: KEY, maxNumber: 5_000, number: 42 });
    expect(challenge.algorithm).toBe('SHA-256');
    expect(challenge.maxnumber).toBe(5_000);
    expect(challenge.challenge).toBe(createHash('sha256').update(challenge.salt + 42).digest('hex'));
    expect(challenge.signature).toBe(createHmac('sha256', KEY).update(challenge.challenge).digest('hex'));
  });

  it('carries an expiry inside the salt and terminates it with &', () => {
    const now = 1_700_000_000_000;
    const challenge = createChallenge({ hmacKey: KEY, expiresMs: 60_000, now, number: 1 });
    expect(challenge.salt).toMatch(/\?expires=\d+&$/);
    expect(Number(challenge.salt.split('expires=')[1]!.replace('&', ''))).toBe(
      Math.floor((now + 60_000) / 1000),
    );
  });

  it('never repeats a salt', () => {
    const salts = new Set(
      Array.from({ length: 50 }, () => createChallenge({ hmacKey: KEY, number: 1 }).salt),
    );
    expect(salts.size).toBe(50);
  });

  it('defaults to a 100k search space', () => {
    expect(createChallenge({ hmacKey: KEY, number: 1 }).maxnumber).toBe(DEFAULT_MAX_NUMBER);
  });

  it('omits the expiry entirely when expiresMs is 0', () => {
    expect(createChallenge({ hmacKey: KEY, expiresMs: 0, number: 1 }).salt).not.toContain('expires');
  });
});

describe('verifySolution', () => {
  it('accepts a solved challenge and reports the challenge digest as id', () => {
    const challenge = createChallenge({ hmacKey: KEY, maxNumber: 20_000 });
    const number = solve(challenge.salt, challenge.challenge, challenge.maxnumber);
    expect(number).toBeGreaterThanOrEqual(0);
    const result = verifySolution(
      token(challenge.salt, challenge.challenge, number, challenge.signature),
      { hmacKey: KEY },
    );
    expect(result).toEqual({ ok: true, id: challenge.challenge });
  });

  it('rejects a number that does not hash to the challenge', () => {
    const challenge = createChallenge({ hmacKey: KEY, number: 7 });
    const wrong = 7 === 8 ? 7 : 8;
    const result = verifySolution(token(challenge.salt, challenge.challenge, wrong, challenge.signature), {
      hmacKey: KEY,
    });
    expect(result).toEqual({ ok: false, reason: 'solution_mismatch' });
  });

  it('rejects a token signed with a different key', () => {
    const challenge = createChallenge({ hmacKey: 'b'.repeat(64), number: 3 });
    const result = verifySolution(token(challenge.salt, challenge.challenge, 3, challenge.signature), {
      hmacKey: KEY,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects an expired challenge even when the solution is correct', () => {
    const challenge = createChallenge({ hmacKey: KEY, expiresMs: 60_000, now: 1_000, number: 5 });
    const result = verifySolution(token(challenge.salt, challenge.challenge, 5, challenge.signature), {
      hmacKey: KEY,
      now: 1_000 + 61_000,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a challenge that has not expired yet', () => {
    const now = 1_700_000_000_000;
    const challenge = createChallenge({ hmacKey: KEY, expiresMs: 60_000, now, number: 5 });
    const result = verifySolution(token(challenge.salt, challenge.challenge, 5, challenge.signature), {
      hmacKey: KEY,
      now: now + 59_000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects garbage, empty and oversized payloads', () => {
    expect(verifySolution('', { hmacKey: KEY })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySolution('not-base64-!!', { hmacKey: KEY })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifySolution('x'.repeat(5000), { hmacKey: KEY })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a payload with a non-integer number', () => {
    const payload = Buffer.from(
      JSON.stringify({
        algorithm: ALGORITHM,
        challenge: 'c',
        number: 1.5,
        salt: 's',
        signature: 'g',
      }),
    ).toString('base64');
    expect(verifySolution(payload, { hmacKey: KEY })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unsupported algorithm', () => {
    const payload = Buffer.from(
      JSON.stringify({ algorithm: 'MD5', challenge: 'c', number: 1, salt: 's', signature: 'g' }),
    ).toString('base64');
    expect(verifySolution(payload, { hmacKey: KEY })).toEqual({
      ok: false,
      reason: 'unsupported_algorithm',
    });
  });

  it('does not trust a solution whose salt was rewritten', () => {
    const challenge = createChallenge({ hmacKey: KEY, number: 11 });
    const rewritten = `${challenge.salt}x`;
    const result = verifySolution(
      token(rewritten, challenge.challenge, 11, challenge.signature),
      { hmacKey: KEY },
    );
    expect(result).toEqual({ ok: false, reason: 'solution_mismatch' });
  });
});

describe('decodeToken', () => {
  it('round-trips the widget wire format', () => {
    const challenge = createChallenge({ hmacKey: KEY, number: 2 });
    expect(decodeToken(token(challenge.salt, challenge.challenge, 2, challenge.signature))).toEqual(
      {
        algorithm: ALGORITHM,
        challenge: challenge.challenge,
        number: 2,
        salt: challenge.salt,
        signature: challenge.signature,
      },
    );
  });

  it('returns null for a JSON payload missing fields', () => {
    expect(decodeToken(Buffer.from('{"algorithm":"SHA-256"}').toString('base64'))).toBeNull();
  });
});
