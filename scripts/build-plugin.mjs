/**
 * Build a built-in plugin package into a single runnable ESM bundle.
 *
 * Plugins are consumed by the API kernel at runtime: the boot seed copies a
 * plugin's `dist/` into `data/plugins/<id>/`, then the kernel imports its entry
 * (`dist/index.js`) with Node's native ESM loader.
 *
 * A plain `tsc` emit is NOT sufficient here: with the shared
 * `moduleResolution: "bundler"` the emitted JS keeps bare relative imports
 * (e.g. `./errors` without a `.js` suffix), which Node ESM cannot resolve. We
 * therefore bundle every plugin's source into a single `dist/index.js` so the
 * output is always runnable regardless of how individual sources write their
 * relative imports. Bare package imports (`@stackpanel/*`, `@prisma/*`, …) are
 * left external and resolved at runtime from the workspace root `node_modules`,
 * matching how the kernel already loads plugin packages.
 *
 * Usage (run from a plugin package dir):
 *   node ../../scripts/build-plugin.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cwd = process.cwd();
const srcEntry = resolve(cwd, 'src/index.ts');
const distDir = resolve(cwd, 'dist');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoPackages = resolve(repoRoot, 'packages');

/**
 * 本仓工作区内的依赖包（如 `@stackpanel/llm-protocol`）：**必须打进产物**。
 *
 * 内核装载插件时只认它自己的 `node_modules`，插件仓的 `packages/*` 不在其中。
 * 如果把它们整成 external，产物里会留下 `import '@stackpanel/llm-protocol'`，
 * 内核加载时直接 ERR_MODULE_NOT_FOUND——而且只在运行时炸，构建是绿的。所以这里
 * 按「软链是否指向本仓 packages/」来判定，命中就内联，其余裸包维持 external。
 *
 * 判定走 `node_modules/<name>` 软链而不是 `require.resolve`：后者要求包已构建出
 * `dist/index.js`，会让构建顺序变成隐式前置条件。
 */
function internalWorkspaceDeps() {
  const found = new Map();
  const manifestPath = resolve(cwd, 'package.json');
  if (!existsSync(manifestPath)) return found;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const linkPath = resolve(cwd, 'node_modules', name);
    if (!existsSync(linkPath)) continue;
    const real = realpathSync(linkPath);
    if (!real.startsWith(realpathSync(repoPackages) + '/')) continue;
    found.set(name, real);
  }
  return found;
}

const internals = internalWorkspaceDeps();
const alias = Object.fromEntries(
  [...internals].map(([name, dir]) => [name, resolve(dir, 'src', 'index.ts')]),
);

if (!existsSync(srcEntry)) {
  console.error(`[build-plugin] no entry at ${srcEntry}`);
  process.exit(1);
}

// 1) Emit type declarations into dist (mirrors the shared `declaration: true`).
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
execSync('tsc -p tsconfig.build.json --emitDeclarationOnly', {
  cwd,
  stdio: 'inherit',
});

// 2) Bundle the runtime entry into a single runnable ESM file.
await build({
  entryPoints: [srcEntry],
  outfile: resolve(distDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  alias,
  // 等价于原来的 `packages: 'external'`，但给工作区内部包开了个口子：只有它们
  // 会被解析进产物，其余裸包（`@stackpanel/sdk`、`zod`…）照旧留给运行时。
  plugins: [
    {
      name: 'externalize-bare-imports',
      setup(context) {
        context.onResolve({ filter: /^[^./]/ }, (args) =>
          internals.has(args.path) ? null : { path: args.path, external: true },
        );
      },
    },
  ],
  logLevel: 'info',
});

// 3) 兜底校验：内联失败时构建必须红，而不是等内核运行时 ERR_MODULE_NOT_FOUND。
const bundled = readFileSync(resolve(distDir, 'index.js'), 'utf8');
for (const name of internals.keys()) {
  if (bundled.includes(`from '${name}'`) || bundled.includes(`from "${name}"`)) {
    console.error(`[build-plugin] ${name} 没有被内联进产物（仍是外部导入）`);
    process.exit(1);
  }
}

console.log(`[build-plugin] bundled ${srcEntry} -> ${resolve(distDir, 'index.js')}`);
