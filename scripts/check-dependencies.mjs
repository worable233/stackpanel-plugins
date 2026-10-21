import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const kernelRoot = resolve(root, '../StackPanel');

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
    problems.push('内核依赖未完整安装，请先在 ../StackPanel 执行 pnpm install --frozen-lockfile。');
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
