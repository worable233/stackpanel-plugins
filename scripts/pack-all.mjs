#!/usr/bin/env node
/**
 * 打包本仓**全部**插件为市场可安装包（ZIP + signature.json + 目录条目）。
 *
 * 逐个调用 `scripts/pack-plugin.mjs`（每个包各自的构建方式不同，不在本脚本里
 * 复制它的逻辑）。任何单个包失败都会立即中止并打印包名——发布一批包时
 * 「悄悄少一个」比整体失败危险得多：目录里缺条目意味着用户根本装不到它。
 *
 * 用法：
 *   STACKPANEL_KERNEL_ROOT=/path/to/StackPanel \
 *   node scripts/pack-all.mjs --out dist-pack --key ~/.stackpanel-release/pkg-signing.pem \
 *     --tag plugins-v0.1.0 [--only smtp,wecom-mail]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function args() {
  const parsed = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      parsed[key.slice(2)] = value;
      i += 1;
    } else {
      parsed[key.slice(2)] = 'true';
    }
  }
  return parsed;
}

const opts = args();
const kernelRoot = process.env['STACKPANEL_KERNEL_ROOT'] ?? opts['kernel'];
if (!kernelRoot) {
  console.error('缺少 STACKPANEL_KERNEL_ROOT（或 --kernel <path>）');
  process.exit(1);
}
const outDir = path.resolve(opts['out'] ?? path.join(repoRoot, 'dist-pack'));
const keyPath = opts['key'];
if (!keyPath) {
  console.error('缺少 --key <包签名私钥 PEM>');
  process.exit(1);
}
const only = new Set((opts['only'] ?? '').split(',').filter(Boolean));
const tag = opts['tag'] ?? 'plugins-v0.1.0';
mkdirSync(outDir, { recursive: true });

// 内核侧 tsc/esbuild 由共享 workspace 提供；本仓的 node_modules 只装了自己的包。
const kernelBin = path.join(path.resolve(kernelRoot), 'node_modules', '.bin');
const env = {
  ...process.env,
  STACKPANEL_KERNEL_ROOT: path.resolve(kernelRoot),
  PATH: `${kernelBin}:${process.env.PATH ?? ''}`,
};

const pluginsDir = path.join(repoRoot, 'packages', 'plugins');
const ids = readdirSync(pluginsDir)
  .filter((id) => existsSync(path.join(pluginsDir, id, 'package.json')))
  .filter((id) => existsSync(path.join(pluginsDir, id, 'src', 'index.ts')))
  .filter((id) => only.size === 0 || only.has(id))
  .sort();

// 目录名不一定等于插件 id（`template/` 打出来的是 `myname`），所以按「本次新增了
// 哪个条目文件」认领产物，而不是拿目录名拼文件名。
const entriesDir = path.join(outDir, 'entries');
const packed = [];
for (const dir of ids) {
  const cwd = path.join(pluginsDir, dir);
  const before = new Set(existsSync(entriesDir) ? readdirSync(entriesDir) : []);
  console.log(`\n=== packing ${dir} ===`);
  execFileSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'pack-plugin.mjs'), '--out', outDir, '--key', keyPath, '--tag', tag],
    { cwd, env, stdio: 'inherit' },
  );
  const created = (existsSync(entriesDir) ? readdirSync(entriesDir) : []).filter(
    (name) => !before.has(name),
  );
  if (created.length !== 1) {
    throw new Error(`${dir}: 期望新增 1 个目录条目，实际 ${created.length}（${created.join(', ')}）`);
  }
  const entry = path.join(entriesDir, created[0]);
  packed.push({
    dir,
    id: created[0].replace(/^plugin-/, '').replace(/\.json$/, ''),
    entry,
    size: statSync(entry).size,
  });
}

console.log(`\n[pack-all] ${packed.length} 个包已产出 → ${outDir}`);
for (const item of packed) console.log(`  ${item.id}  (from ${item.dir}/)`);
