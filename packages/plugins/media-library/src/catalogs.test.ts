import { describe, expect, it } from 'vitest';
import enUS from '../frontend/messages/en-US.json';
import zhCN from '../frontend/messages/zh-CN.json';
import zhHK from '../frontend/messages/zh-HK.json';
import zhTW from '../frontend/messages/zh-TW.json';

/**
 * Catalog parity (ADR-0016 §5).
 *
 * A missing key in one locale renders the raw key in the console, and a stale
 * extra key hides a removed feature. Both are cheap to catch here and expensive
 * to notice in a screenshot review, so parity is asserted structurally.
 */
const catalogs: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  'en-US': enUS,
};

const referenceLocale = 'zh-CN';
const referenceKeys = Object.keys(catalogs[referenceLocale] ?? {}).sort();

describe('media-library catalogs', () => {
  it('ships every interface language the manifest declares', () => {
    expect(Object.keys(catalogs).sort()).toEqual(['en-US', 'zh-CN', 'zh-HK', 'zh-TW']);
  });

  it('keeps the same key set in every locale', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), `${locale} keys`).toEqual(referenceKeys);
    }
  });

  it('never ships an empty message', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('keeps placeholders identical across locales', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
    for (const key of referenceKeys) {
      const expected = placeholders(catalogs[referenceLocale]?.[key] ?? '');
      for (const [locale, catalog] of Object.entries(catalogs)) {
        expect(placeholders(catalog[key] ?? ''), `${locale}:${key}`).toEqual(expected);
      }
    }
  });
});
