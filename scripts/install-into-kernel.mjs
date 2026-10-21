#!/usr/bin/env node
/**
 * Install the built llm-gateway plugin into the kernel's `data/plugins/`.
 *
 * The plugin lives in the separate `StackPanel-plugins` repo, so the kernel's
 * built-in discovery (which only scans `packages/plugins/`) never sees it. This
 * script bundles the source, then copies `dist/` + a manifest derived from the
 * compiled plugin definition into the kernel package dir.
 *
 * Usage (from the plugin package dir):
 *   node ../../../scripts/install-into-kernel.mjs [--kernel /path/to/StackPanel]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const pluginDir = process.cwd();
const args = process.argv.slice(2);
const kernelArg = args.indexOf('--kernel');

/**
 * 内核检出位置：`--kernel` 优先，其次环境变量 `STACKPANEL_KERNEL_ROOT`，最后按
 * 「两个仓库并排放置」的约定从本脚本位置推导（`<parent>/StackPanel`）。
 * 不写死任何人的绝对路径。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kernelRoot = (() => {
  if (kernelArg >= 0) {
    const value = args[kernelArg + 1];
    if (!value) throw new Error('--kernel 需要跟一个路径');
    return resolve(value);
  }
  const fromEnv = process.env['STACKPANEL_KERNEL_ROOT'];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(repoRoot, '..', 'StackPanel');
})();

if (!existsSync(join(kernelRoot, 'package.json'))) {
  throw new Error(
    `找不到内核检出：${kernelRoot}\n` +
      '请用 --kernel <path> 指定，或设置 STACKPANEL_KERNEL_ROOT，' +
      '或把两个仓库并排放置为 StackPanel/ 与 StackPanel-plugins/。',
  );
}

/**
 * Candidate data directories. The dev server resolves `<repo-root>/data`
 * (via `resolveStackPanelDataDir`); the integration test suite overrides
 * `STACKPANEL_DATA_DIR` to `<kernel-root>/apps/api/data`. Install into every
 * existing candidate so both see the fresh build.
 */
const dataDirs = [join(kernelRoot, 'data'), join(kernelRoot, 'apps', 'api', 'data')].filter(
  (dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
);

// 1) Build a fresh dist bundle (needs `tsc` + `esbuild` on PATH).
const binDir = join(kernelRoot, 'node_modules', '.bin');
execSync('node ../../../scripts/build-plugin.mjs', {
  cwd: pluginDir,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
});

// 2) Read the compiled plugin definition's manifest.
const entry = pathToFileURL(join(pluginDir, 'dist', 'index.js')).href;
const mod = await import(`${entry}?v=${Date.now()}`);
const definition = mod.default ?? mod.llmGatewayPlugin;
if (!definition?.manifest) throw new Error('compiled plugin has no manifest');

// 3) Compose the distribution manifest the kernel expects.
const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const manifest = {
  id: 'llm-gateway',
  name: definition.manifest.name ?? 'API 中转',
  version: pkg.version ?? '0.0.0',
  ...(pkg.description ? { description: pkg.description } : {}),
  ...(definition.manifest.permissions ? { permissions: definition.manifest.permissions } : {}),
  ...(definition.manifest.roleTemplates ? { roleTemplates: definition.manifest.roleTemplates } : {}),
  builtin: true,
  apiVersion: '>=0.4.0',
};

// 4) Atomically replace the target package dir in every candidate data dir.
for (const dataDir of dataDirs) {
  const target = join(dataDir, 'plugins', 'llm-gateway');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(pluginDir, 'dist'), join(target, 'dist'), { recursive: true });
  const frontend = join(pluginDir, 'frontend');
  const frontendTarget = join(target, 'frontend');
  mkdirSync(frontendTarget, { recursive: true });
  try {
    cpSync(join(frontend, 'manifest.json'), join(frontendTarget, 'manifest.json'));
  } catch {
    /* optional */
  }
  try {
    cpSync(join(frontend, 'dist'), join(frontendTarget, 'dist'), { recursive: true });
  } catch {
    /* optional */
  }
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[install-into-kernel] installed llm-gateway -> ${target}`);
}
