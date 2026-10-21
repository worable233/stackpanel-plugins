#!/usr/bin/env node

import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'docs/wiki');
const wikiArg = process.argv.indexOf('--wiki');
const wiki = wikiArg >= 0 ? resolve(process.argv[wikiArg + 1] ?? '') : null;
const check = process.argv.includes('--check');

if (!wiki || !existsSync(source)) {
  console.error('usage: node tools/publish-wiki.mjs --wiki <wiki-worktree> [--check]');
  process.exit(1);
}

const pages = readdirSync(source)
  .filter((name) => name.endsWith('.md'))
  .sort();
const changed = [];
for (const page of pages) {
  const from = resolve(source, page);
  const to = resolve(wiki, page);
  const same = existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8');
  if (!same) changed.push(page);
  if (!check && !same) cpSync(from, to);
}

if (check && changed.length) {
  console.error(`Wiki diverged: ${changed.join(', ')}`);
  process.exit(1);
}

console.log(`${pages.length} pages, ${changed.length} ${check ? 'diverged' : 'updated'}`);
