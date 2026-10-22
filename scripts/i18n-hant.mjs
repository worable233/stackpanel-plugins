#!/usr/bin/env node
/**
 * Generate the Traditional Chinese package catalogs (`zh-TW`, `zh-HK`) from
 * `zh-CN` (ADR-0016 §5).
 *
 * Hand-maintaining two extra copies of every package catalog invites drift, so
 * Traditional Chinese is *derived*: the Simplified catalog stays the single
 * authored source and this script rewrites both Traditional files
 * deterministically for every `packages/plugins/<id>/frontend/messages/` that
 * ships a `zh-CN.json`.
 *
 * Conversion rules
 *   - `zh-TW` uses OpenCC `cn → twp`: fully traditional characters plus Taiwan
 *     vocabulary (軟體 / 網路 / 設定 / 螢幕 …).
 *   - `zh-HK` starts from the same text and applies a Hong Kong vocabulary
 *     overlay (軟件 / 網絡 / 默認 / 設置 / 用戶 …).
 *   - Structure, key order and `{placeholders}` are preserved byte for byte, so
 *     the key/placeholder parity gates keep passing.
 *
 * Usage
 *   node scripts/i18n-hant.mjs            # rewrite every zh-TW / zh-HK catalog
 *   node scripts/i18n-hant.mjs --check    # fail if a committed catalog is stale
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const toTW = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** Hong Kong vocabulary overrides applied on top of the Taiwan text. */
const HK_TERMS = [
  ['軟體', '軟件'],
  ['硬體', '硬件'],
  ['程式', '程序'],
  ['網路', '網絡'],
  ['網際網路', '互聯網'],
  ['預設', '默認'],
  ['設定', '設置'],
  ['使用者', '用戶'],
  ['登入', '登錄'],
  // `儲存` covers both "storage" and "save" in Traditional Chinese. Rewriting it
  // to `保存` would turn 「密鑰存儲」/「存儲桶」 into 「保存」, so Hong Kong keeps
  // `儲存` — it is the standard term for both senses there.
  ['檔案', '文件'],
  ['快取', '緩存'],
  ['執行緒', '線程'],
];

/**
 * Characters that are also legitimate traditional forms, so the
 * leftover-simplified check must not flag them:
 *   台 (臺/台), 游 (遊/游), 准 (準/准), 后 (後/后 as in 皇后/天后),
 *   里 (裡/里 as in 公里), 干 (乾/幹/干 as in 干擾), 面 (麵/面 as in 見面),
 *   只 (隻/只), 系 (係/繫/系).
 *
 * Conversion is word-aware, so these only survive where OpenCC itself decided
 * the traditional text keeps the glyph.
 */
const VALID_TRADITIONAL = new Set(['台', '游', '准', '后', '里', '干', '面', '只', '系']);

function toHK(text) {
  let next = text;
  for (const [from, to] of HK_TERMS) next = next.split(from).join(to);
  return next;
}

/** Convert every string leaf; leave non-Han strings (ids, urls) untouched. */
function convert(node, transform) {
  if (typeof node === 'string') {
    return /\p{Script=Han}/u.test(node) ? transform(node) : node;
  }
  if (Array.isArray(node)) return node.map((item) => convert(item, transform));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = convert(value, transform);
    return out;
  }
  return node;
}

function simplifiedLeftovers(text) {
  const found = new Set();
  for (const char of text) {
    if (!/\p{Script=Han}/u.test(char)) continue;
    if (toTW(char) !== char && !VALID_TRADITIONAL.has(char)) found.add(char);
  }
  return [...found].join('');
}

/** Every plugin frontend directory that holds a `zh-CN.json` catalog. */
function catalogDirs() {
  const dirs = [];
  const kindDir = path.join(root, 'packages', 'plugins');
  for (const id of readdirSync(kindDir)) {
    const dir = path.join(kindDir, id, 'frontend', 'messages');
    try {
      if (statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      // Not a frontend package.
    }
  }
  return dirs.filter((dir) => {
    try {
      return statSync(path.join(dir, 'zh-CN.json')).isFile();
    } catch {
      return false;
    }
  });
}

let stale = 0;
for (const dir of catalogDirs()) {
  const source = JSON.parse(readFileSync(path.join(dir, 'zh-CN.json'), 'utf8'));
  const tw = convert(source, toTW);
  const hk = convert(source, (text) => toHK(toTW(text)));
  for (const [name, catalog] of [
    ['zh-TW', tw],
    ['zh-HK', hk],
  ]) {
    const leftover = simplifiedLeftovers(JSON.stringify(catalog));
    if (leftover) throw new Error(`${dir}/${name}: simplified characters left: ${leftover}`);
  }
  for (const [name, catalog] of [
    ['zh-TW', tw],
    ['zh-HK', hk],
  ]) {
    const file = path.join(dir, `${name}.json`);
    const next = `${JSON.stringify(catalog, null, 2)}\n`;
    if (check) {
      let current = '';
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        current = '';
      }
      if (current !== next) {
        stale += 1;
        console.error(`stale: ${path.relative(root, file)}`);
      }
      continue;
    }
    writeFileSync(file, next);
    console.log(`wrote ${path.relative(root, file)}`);
  }
}

if (check) {
  if (stale > 0) {
    console.error(
      `\n${stale} Traditional Chinese catalog(s) are out of date — run \`pnpm i18n:hant\`.`,
    );
    process.exit(1);
  }
  console.log('Traditional Chinese catalogs: up to date');
}
