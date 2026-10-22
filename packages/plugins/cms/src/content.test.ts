import { describe, expect, it } from 'vitest';
import { CONTENT_KINDS, contentModelFor } from './models.js';
import { contentPath, normalizePath } from './workflow.js';

describe('cms content URL contract', () => {
  it('maps posts under /blog and pages at the root', () => {
    expect(contentPath(CONTENT_KINDS.post, 'hello-world')).toBe('/blog/hello-world');
    expect(contentPath(CONTENT_KINDS.page, 'about')).toBe('/about');
  });

  it('normalises caller paths to a leading slash and no trailing slash', () => {
    expect(normalizePath('blog/old')).toBe('/blog/old');
    expect(normalizePath('/blog/old/')).toBe('/blog/old');
    expect(normalizePath('/')).toBe('/');
  });

  it('resolves the two content kinds and rejects unknown ones', () => {
    expect(contentModelFor('cms/post')?.kind).toBe('cms/post');
    expect(contentModelFor('cms/page')?.kind).toBe('cms/page');
    expect(contentModelFor('cms/revision')).toBeUndefined();
  });
});
