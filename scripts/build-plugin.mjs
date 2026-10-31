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
 * relative imports.
 *
 * 外部依赖只有两类：**宿主提供的**（`@stackpanel/*` 的契约/工具包、`zod`、
 * `@prisma/*`）与 Node 内置模块。其余第三方包一律打进产物——远程安装的包落在
 * `data/plugins/<id>/`，那里**没有 node_modules**，Node 只会沿目录向上找内核仓的
 * `node_modules`；内核没声明过的包（例如 `wowid` 用的 `jose`）就找不到，表现为
 * isolated worker 启动即退、宿主只报 `exited before ready`。这类缺陷在本地
 * 「内核根目录恰好装了同款依赖」时完全看不出来，只有装到干净实例上才炸。
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

/**
 * 宿主（内核）提供的模块：必须 external，否则插件会带上自己那份实例，
 * 扩展点注册、schema 校验、zod 身份全部对不上。
 */
const HOST_PROVIDED = ['@stackpanel/sdk', '@stackpanel/spec', '@stackpanel/ui', '@stackpanel/net-guard', 'zod'];

function isHostProvided(specifier) {
  if (specifier.startsWith('node:')) return true;
  if (HOST_PROVIDED.some((name) => specifier === name || specifier.startsWith(`${name}/`))) return true;
  return specifier.startsWith('@prisma/');
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
  // 只有宿主提供的包留作 external（必须与内核共享同一个实例），其余第三方依赖
  // 全部内联。见文件头注释：远程安装的包运行时没有自己的 node_modules。
  plugins: [
    {
      name: 'externalize-host-provided-imports',
      setup(context) {
        context.onResolve({ filter: /^[^./]/ }, (args) => {
          if (internals.has(args.path)) return null;
          return isHostProvided(args.path) ? { path: args.path, external: true } : null;
        });
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

// 4) 产物里若还残留「宿主也不会提供」的裸导入，这个包在干净实例上必定装不起来。
//    宁可构建失败，也别等用户点安装时才看到 `exited before ready`。
const residue = [...bundled.matchAll(/(?:from |import\()['"]([^'".][^'"]*)['"]/g)]
  .map((match) => match[1])
  .filter((specifier) => !isHostProvided(specifier));
const leftover = [...new Set(residue)].filter((specifier) => /^[a-z@]/i.test(specifier));
if (leftover.length > 0) {
  console.error(`[build-plugin] 产物里仍有未内联的第三方依赖：${leftover.join(', ')}`);
  process.exit(1);
}

console.log(`[build-plugin] bundled ${srcEntry} -> ${resolve(distDir, 'index.js')}`);
