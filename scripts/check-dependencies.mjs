import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 内核检出位置：解析 `pnpm-workspace.yaml` 里 `link:` 覆盖的**实际**路径。
 *
 * 为什么不再写死 `../StackPanel`：本机上同时存在多份内核检出（`StackPanel`、
 * `StackPanel-main`、`StackPanel-merge` …），它们的 package.json 都叫
 * `stackpanel`，无法自动区分哪个是正在开发的那一份。写死目录名的结果是：
 * 依赖被 link 到一份旧内核上，插件用了新 SDK 的导出就再也编译不过，而且
 * 报错信息（`has no exported member named 'ServiceChangeOption'`）完全指向
 * 错误的方向——看起来像插件写错了。
 *
 * `pnpm-workspace.yaml` 的 `link:` 是 pnpm 安装时真正生效的那份配置，因此
 * 它必须是唯一事实来源：脚本校验的路径与实际装上的路径不可能再不一致。
 */
function readKernelRoot() {
  const fromEnv = process.env['STACKPANEL_KERNEL_ROOT'];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());

  const workspaceFile = resolve(root, 'pnpm-workspace.yaml');
  const text = readFileSync(workspaceFile, 'utf8');
  // 只取第一条 `@stackpanel/sdk` 的 link 目标；其余包共享同一内核根目录。
  // 要削掉尾部 `/packages/sdk`：link 指向的是**包内**目录，而内核根是它的上两级。
  const match = /^\s*'@stackpanel\/sdk':\s*link:(.+?)\/packages\/sdk\s*$/m.exec(text);
  if (!match) {
    throw new Error(
      `无法从 ${workspaceFile} 解析内核位置：缺少 '@stackpanel/sdk': link:…/packages/sdk 覆盖。`,
    );
  }
  return resolve(root, match[1].trim());
}

export const kernelRoot = readKernelRoot();

export function checkDependencies(beforeInstall = false) {
  const problems = [];
  const modules = resolve(root, 'node_modules');
  // lstat also detects a dangling symlink; existsSync alone does not.
  try {
    if (lstatSync(modules).isSymbolicLink()) {
      problems.push('插件仓 node_modules 不能是软链。请先移走该软链，再运行 pnpm dev:setup。');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!existsSync(resolve(kernelRoot, 'node_modules/.modules.yaml'))) {
    problems.push(`内核依赖未完整安装，请先在 ${kernelRoot} 执行 pnpm install --frozen-lockfile。`);
  }
  const hostRequire = createRequire(resolve(kernelRoot, 'package.json'));
  for (const name of ['sdk', 'net-guard', 'ui', 'spec']) {
    const manifest = resolve(kernelRoot, 'packages', name, 'package.json');
    if (!existsSync(manifest)) {
      problems.push(`缺少内核开发包：${manifest}`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const entry = pkg.exports?.['.']?.import;
    if (entry && !existsSync(resolve(dirname(manifest), entry))) {
      problems.push(`${pkg.name} 尚未构建，请在内核执行 pnpm --filter ${pkg.name} build。`);
    }
  }
  for (const name of ['@stackpanel/sdk', '@stackpanel/net-guard', '@stackpanel/ui']) {
    try {
      hostRequire.resolve(name);
    } catch {
      problems.push(`内核无法解析 ${name}，请重新安装并构建内核依赖。`);
    }
  }

  if (!beforeInstall) {
    if (!existsSync(resolve(modules, '.modules.yaml'))) {
      problems.push('插件仓缺少 pnpm 安装元数据，请运行 pnpm dev:setup。');
    }
    for (const dir of readdirSync(resolve(root, 'packages/plugins'))) {
      const manifest = resolve(root, 'packages/plugins', dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const localRequire = createRequire(manifest);
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        try {
          const entry = localRequire.resolve(
            name.startsWith('@types/') ? `${name}/package.json` : name,
          );
          if (name.startsWith('@stackpanel/')) {
            // 本仓自己的工作区包（`packages/protocol` 等）复用 `@stackpanel/` 前缀，
            // 但它们不来自内核检出，不能按内核包校验路径。
            const ownPackages = realpathSync(resolve(root, 'packages'));
            if (realpathSync(entry).startsWith(ownPackages + '/')) continue;
            const expected = resolve(kernelRoot, 'packages', name.slice('@stackpanel/'.length));
            if (!realpathSync(entry).startsWith(realpathSync(expected) + '/')) {
              problems.push(`${pkg.name}: ${name} 指向了错误的内核工作区。`);
            }
          }
          if (name === 'zod') {
            const sdkRequire = createRequire(resolve(kernelRoot, 'packages/sdk/package.json'));
            if (realpathSync(entry) !== realpathSync(sdkRequire.resolve('zod'))) {
              problems.push(`${pkg.name}: Zod 与内核 SDK 不一致，请重新安装内核与插件依赖。`);
            }
          }
        } catch {
          problems.push(`${pkg.name}: 无法解析已声明依赖 ${name}，请运行 pnpm dev:setup。`);
        }
      }
    }
  }

  if (problems.length) throw new Error(problems.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkDependencies(process.argv.includes('--before-install'));
    console.log('内核与插件仓依赖检查通过。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
