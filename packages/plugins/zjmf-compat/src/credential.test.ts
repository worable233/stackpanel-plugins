import { describe, expect, it } from 'vitest';
import { issueToken, hashCredential, verifyCredential } from './credential.js';

describe('zjmf-compat credentials', () => {
  it('hashes and verifies a password', () => {
    const { hash, salt } = hashCredential('s3cret-pass');
    expect(verifyCredential('s3cret-pass', hash, salt)).toBe(true);
    expect(verifyCredential('wrong-pass', hash, salt)).toBe(false);
  });

  it('uses a fresh salt per hash', () => {
    expect(hashCredential('same').salt).not.toBe(hashCredential('same').salt);
  });

  it('never throws on malformed stored material', () => {
    expect(verifyCredential('x', '', '')).toBe(false);
    expect(verifyCredential('x', 'not-hex', 'salt')).toBe(false);
  });

  it('issues opaque URL-safe tokens', () => {
    const token = issueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(20);
    expect(issueToken()).not.toBe(token);
  });
});
