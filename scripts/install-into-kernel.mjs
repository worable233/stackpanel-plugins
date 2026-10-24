#!/usr/bin/env node
/**
 * Install a built plugin from this repo into a kernel checkout's `data/plugins/`.
 *
 * The plugins live in the separate `StackPanel-plugins` repo, so the kernel's
 * built-in discovery (which only scans its own `packages/plugins/`) never sees
 * them. This bundles the source, then copies `dist/` + a manifest derived from
 * the compiled plugin definition into the kernel package dir.
 *
 * The plugin id is taken from the compiled definition, not hard-coded, so the
 * same script works for every plugin in this repo.
 *
 * Usage (from the plugin package dir):
 *   node ../../../scripts/install-into-kernel.mjs [--kernel /path/to/StackPanel]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
const definition = mod.default ?? Object.values(mod).find((value) => value?.manifest);

if (!definition?.manifest) throw new Error('compiled plugin has no manifest');
const id = definition.manifest.id;
if (!/^[a-z0-9_-]{1,64}$/.test(id ?? '')) {
  throw new Error(`插件 id 不合法：${String(id)}`);
}

// 3) Compose the distribution manifest the kernel expects.
//    `version` comes from the compiled definition so the installed manifest can
//    never drift from the plugin source (that drift is what made the previously
//    installed ticket report 0.3.0 while its source still said 0.2.0).
const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const manifest = {
  id,
  name: definition.manifest.name ?? id,
  version: definition.manifest.version ?? pkg.version ?? '0.0.0',
  ...((definition.manifest.description ?? pkg.description)
    ? { description: definition.manifest.description ?? pkg.description }
    : {}),
  ...(definition.manifest.permissions ? { permissions: definition.manifest.permissions } : {}),
  ...(definition.manifest.roleTemplates
    ? { roleTemplates: definition.manifest.roleTemplates }
    : {}),
  builtin: true,
  apiVersion: '>=0.4.0',
};

// 4) Atomically replace the target package dir in every candidate data dir.
for (const dataDir of dataDirs) {
  const target = join(dataDir, 'plugins', id);
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
  console.log(`[install-into-kernel] installed ${id}@${manifest.version} -> ${target}`);
}
