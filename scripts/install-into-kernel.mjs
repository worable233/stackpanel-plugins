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
import { createHash } from 'node:crypto';
import { kernelRoot as kernelRootFromWorkspace } from './check-dependencies.mjs';
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
 * 内核检出位置：`--kernel` 优先，其次环境变量 `STACKPANEL_KERNEL_ROOT`，
 * 最后从 `pnpm-workspace.yaml` 的 `link:` 覆盖里读。
 *
 * 最后那一步必须与 `check-dependencies.mjs` 用同一个来源，否则「装到哪个内核」
 * 和「校验哪个内核」会各说各话——那正是把产物装进旧内核、却报告依赖正常的成因。
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
  return kernelRootFromWorkspace;
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
//    `builtin` is read from the package's own `stackpanel.builtin` flag and
//    never forced. A plugin from this repo is an ordinary installable package:
//    marking it builtin would hand it kernel privileges — in-process `trusted`
//    execution, `frontendExecutions: 'server'`, and protection from uninstall —
//    which a business plugin must not have.
//
//    `execution: 'isolated'` is declared explicitly rather than relying on the
//    kernel's production-only rule, so development and the integration suite run
//    the same code path as production. Otherwise the default under
//    NODE_ENV !== production is `trusted`, and the tests would prove nothing
//    about isolation.
const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const builtin = pkg.stackpanel?.builtin === true;
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
  builtin,
  ...(builtin ? {} : { execution: 'isolated' }),
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
  try {
    cpSync(join(frontend, 'package.json'), join(frontendTarget, 'package.json'));
  } catch {
    /* optional */
  }
  // The kernel requires a content-addressed `revision` on the frontend manifest
  // and admits two mutually exclusive data requirements (ADR-0027):
  //   { finder }  package code in the web process → needs execution admission
  //   { fetch }   host-issued kernel GET          → needs no admission
  //
  // This script used to *delete* every requirement it did not understand, which
  // looked like a successful install and left each settings page rendering with
  // no data at all — a blank SMTP form that the operator would then re-submit.
  // A manifest that reaches this point in the wrong shape is a package defect,
  // so it fails loudly instead. `scripts/check-frontend-manifests.mjs` catches
  // the same thing before packaging.
  const frontendManifest = join(frontendTarget, 'manifest.json');
  if (existsSync(frontendManifest)) {
    const parsed = JSON.parse(readFileSync(frontendManifest, 'utf8'));
    const entryPath = join(frontendTarget, 'dist', 'index.js');
    if (existsSync(entryPath)) {
      parsed.revision = createHash('sha256')
        .update(readFileSync(entryPath))
        .digest('hex')
        .slice(0, 12);
    }
    const declaredFinders = new Set(parsed.finders ?? []);
    for (const key of ['pages', 'adminRoutes', 'accountRoutes']) {
      for (const route of parsed[key] ?? []) {
        for (const requirement of route.data ?? []) {
          const hasFetch = typeof requirement?.fetch?.path === 'string';
          if (hasFetch) {
            const path = requirement.fetch.path;
            if (
              !path.startsWith('/') ||
              path.startsWith('//') ||
              path.startsWith('/api/') ||
              path.includes('\\') ||
              path.split('/').some((seg) => seg === '..' || seg === '.')
            ) {
              throw new Error(
                `${id}: ${route.path} declares fetch.path "${path}", which is not a ` +
                  'kernel-relative path (no absolute URLs, no "..", no "/api/" prefix).',
              );
            }
          }
          if (!hasFetch && (!requirement || typeof requirement.finder !== 'string')) {
            throw new Error(
              `${id}: ${route.path} declares a data requirement with neither "finder" nor ` +
                `"fetch" (${JSON.stringify(requirement)}). The kernel rejects the package at install.`,
            );
          }
          if (!hasFetch && !declaredFinders.has(requirement.finder)) {
            throw new Error(
              `${id}: ${route.path} requires finder "${requirement.finder}", which is not ` +
                'listed in frontend/manifest.json "finders".',
            );
          }
        }
      }
    }
    writeFileSync(frontendManifest, `${JSON.stringify(parsed, null, 2)}\n`);
    if (parsed.revision) {
      const revisionDir = join(frontendTarget, 'revisions', parsed.revision);
      mkdirSync(revisionDir, { recursive: true });
      cpSync(join(frontendTarget, 'dist'), join(revisionDir, 'dist'), { recursive: true });
      writeFileSync(join(revisionDir, 'manifest.json'), `${JSON.stringify(parsed, null, 2)}\n`);
    }
  }
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[install-into-kernel] installed ${id}@${manifest.version} -> ${target}`);
}

// Tell the operator about the one thing that will look broken otherwise. Page
// data is served by finders, and a non-builtin package's finders only run in the
// web process once the kernel admits it to server execution. An unadmitted
// package therefore renders its pages and settings panels *without* the data
// they asked for — no error, just empty forms — which is easy to misread as a
// plugin bug.
if (!builtin) {
  const frontendManifest = join(pluginDir, 'frontend', 'manifest.json');
  const finders = existsSync(frontendManifest)
    ? (JSON.parse(readFileSync(frontendManifest, 'utf8')).finders ?? [])
    : [];
  if (Array.isArray(finders) && finders.length > 0) {
    console.log(
      `[install-into-kernel] ${id} declares ${finders.length} finder(s). Their pages and ` +
        `settings panels render with EMPTY data until the kernel admits the package for ` +
        `server-side execution: add "${id}" to the allow list in Admin -> Settings -> ` +
        `Runtime configuration (setting frontend.serverExec, applies immediately). The ` +
        `STACKPANEL_FRONTEND_SERVER_EXEC env var only works as a bootstrap fallback.`,
    );
  }
}
