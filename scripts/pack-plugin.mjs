#!/usr/bin/env node
/**
 * 把一个插件打包成**可分发安装包**（ZIP + `signature.json`），并生成市场目录条目。
 *
 * 这是「源码仓 → 市场可安装」的最后一步。内核的远程安装（`fetchAndVerifyPackage`）
 * 要求三件事同时成立，少一件都装不上：
 *
 * 1. ZIP 里的文件集合与 `artifact.sha256/size` 完全一致（目录条目里声明）；
 * 2. ZIP 里带 `signature.json`，且签名公钥在实例 keyring 中 `purpose: 'package'`；
 * 3. 目录 `publishers[]` 把该 keyId 绑定到发布者与**允许的仓库**。
 *
 * ZIP 结构就是内核 `assemblePluginFiles` 承认的那一套（与 ZIP 上传路径同规）：
 *
 *   manifest.json           内核插件清单（id/name/version/permissions/execution…）
 *   dist/index.js           入口（+ .map）
 *   frontend/manifest.json  有前端时（`files[]` 里列的每个文件都必须真实存在）
 *   frontend/dist/*.js|css|map
 *   signature.json          对上面全部文件的 SHA-256 集合签名
 *
 * 用法（在插件包目录内执行）：
 *   STACKPANEL_KERNEL_ROOT=/path/to/StackPanel \
 *   node ../../../scripts/pack-plugin.mjs --out ../../../dist-pack \
 *     --key ~/.stackpanel-release/pkg-signing.pem --tag plugins-v0.1.0
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const pluginDir = process.cwd();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const kernelRoot = process.env['STACKPANEL_KERNEL_ROOT']
  ? path.resolve(process.env['STACKPANEL_KERNEL_ROOT'])
  : opts['kernel']
    ? path.resolve(opts['kernel'])
    : null;
if (!kernelRoot || !existsSync(path.join(kernelRoot, 'packages/spec/dist/index.js'))) {
  console.error(
    '缺少内核检出（需要其中已构建的 packages/spec/dist）：用 --kernel <path> 或 STACKPANEL_KERNEL_ROOT 指定',
  );
  process.exit(1);
}

const outDir = path.resolve(opts['out'] ?? path.join(repoRoot, 'dist-pack'));
const keyPath = opts['key'];
if (!keyPath || !existsSync(keyPath)) {
  console.error('缺少 --key <包签名私钥 PEM>');
  process.exit(1);
}
const publisher = opts['publisher'] ?? 'stackpanel';
const repository = opts['repository'] ?? 'worable233/stackpanel-plugins';
const tag = opts['tag'] ?? 'plugins-v0.1.0';
const channel = opts['channel'] ?? 'stable';
// 兼容区间的默认值与文档口径一致：从 `KERNEL_VERSION` 起、到下一个 minor 之前
// （`rehearse-distribution.mjs` 用的是同一条规则）。写死 `<1.0.0` 会把「0.9 也能装」
// 这种没人验证过的承诺签进条目里。
function nextMinor(version) {
  const [major, minor] = version.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}


const spec = await import(
  pathToFileURL(path.join(kernelRoot, 'packages/spec/dist/index.js')).href
);

// 兼容区间的默认值与文档口径一致：`KERNEL_VERSION` 起、到下一个 minor 之前
// （`rehearse-distribution.mjs` 用同一条规则）。
const compatKernel =
  opts['compat-kernel'] ?? `>=${spec.KERNEL_VERSION} <${nextMinor(spec.KERNEL_VERSION)}`;
const compatApi = opts['compat-api'] ?? `>=${spec.KERNEL_API_VERSION}`;
const compatAbi = opts['compat-abi'] ?? '^1.0.0';

const pkg = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const frontendDir = path.join(pluginDir, 'frontend');
const hasFrontend = existsSync(path.join(frontendDir, 'manifest.json'));

// 1) 构建后端 bundle（内核加载的就是 dist/index.js）。
execSync(`node ${path.join(repoRoot, 'scripts', 'build-plugin.mjs')}`, {
  cwd: pluginDir,
  stdio: 'inherit',
});

// 2) 构建前端 bundle（有前端时）。`files[]` 声明的产物必须真的存在，否则内核
//    的 `validateFrontendFiles` 会 422，这里先构建再收集，避免拿旧产物打包。
if (hasFrontend && existsSync(path.join(frontendDir, 'tsup.config.ts'))) {
  execSync('pnpm run build', { cwd: frontendDir, stdio: 'inherit' });
}

// 3) 从编译后的定义推导内核插件清单（与 `install-into-kernel.mjs` 同源，
//    版本号取自编译产物，避免「manifest 说 0.3.0、代码里还是 0.2.0」的漂移）。
const entryFile = path.join(pluginDir, 'dist', 'index.js');
const mod = await import(`${pathToFileURL(entryFile).href}?v=${Date.now()}`);
const definition = mod.default ?? Object.values(mod).find((value) => value?.manifest);
if (!definition?.manifest) throw new Error('编译产物里找不到插件定义（manifest）');
const id = definition.manifest.id;
if (!/^[a-z0-9_-]{1,64}$/.test(id ?? '')) throw new Error(`插件 id 不合法：${String(id)}`);

const builtin = pkg.stackpanel?.builtin === true;
// 运行时清单里的 `permissions` 是对象（`{ key, scope }`），目录条目只放稳定 id 字符串；
// 直接透传会让 `build-manifest.mjs` 报「permissions[0] 必须是非空字符串」。
const permissionIds = (definition.manifest.permissions ?? [])
  .map((permission) =>
    typeof permission === 'string' ? permission : (permission?.key ?? permission?.id),
  )
  .filter((key) => typeof key === 'string' && key.length > 0);
const pluginManifest = {
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
  apiVersion: `>=${spec.KERNEL_API_VERSION}`,
};
const version = pluginManifest.version;

// 4) 收集文件集合。`.d.ts` / `.d.ts.map` 属于「源码文件」，内核会直接 422。
const files = new Map();
const encoder = new TextEncoder();
files.set('manifest.json', encoder.encode(`${JSON.stringify(pluginManifest, null, 2)}\n`));

const distDir = path.join(pluginDir, 'dist');
for (const name of readdirSync(distDir)) {
  if (!/\.(js|map)$/.test(name)) continue;
  if (name.includes('.d.ts')) continue;
  files.set(`dist/${name}`, readFileSync(path.join(distDir, name)));
}

let frontendFiles = [];
if (hasFrontend) {
  const manifestRaw = JSON.parse(readFileSync(path.join(frontendDir, 'manifest.json'), 'utf8'));
  const frontendEntry = path.join(frontendDir, 'dist', 'index.js');
  if (existsSync(frontendEntry)) {
    // 内核要求前端清单里的 `revision` 是内容寻址的：同一份 bundle 必须得到同一个
    // revision，否则每次安装都会被当成「新版本」而重挂前端。
    manifestRaw.revision = createHash('sha256')
      .update(readFileSync(frontendEntry))
      .digest('hex')
      .slice(0, 12);
  }
  const declared = Array.isArray(manifestRaw.files) ? manifestRaw.files : [];
  for (const rel of declared) {
    if (typeof rel !== 'string') continue;
    // `files[]` 里的路径是**相对插件包根**的（`frontend/dist/index.js`），不是相对
    // `frontend/`，早先按后者拼接会得到 `frontend/frontend/dist/...` 而全部丢失。
    const absolute = path.join(pluginDir, rel);
    if (!existsSync(absolute)) {
      throw new Error(`frontend/manifest.json 声明的产物不存在：${rel}（先构建前端）`);
    }
    files.set(rel, readFileSync(absolute));
    frontendFiles.push(rel);
  }
  files.set(
    'frontend/manifest.json',
    encoder.encode(`${JSON.stringify(manifestRaw, null, 2)}\n`),
  );
  frontendFiles.push('frontend/manifest.json');
}

// 4b) 体积预检：内核 `validateFrontendFiles` 对单个前端产物（不含 `.map`）有
//     2 MiB 上限（`MAX_FRONTEND_FILE_BYTES`）。在这里挡下来，比让用户点「安装」
//     时收到 422 好得多——而且这类失败发生在下载完整包之后。
const MAX_PACKAGED_FRONTEND_FILE_BYTES = 2 * 1024 * 1024;
for (const [name, data] of files) {
  if (!name.startsWith('frontend/dist/') || name.endsWith('.map')) continue;
  if (data.byteLength > MAX_PACKAGED_FRONTEND_FILE_BYTES) {
    throw new Error(
      `前端产物过大：${name} 为 ${data.byteLength} 字节，超过内核上限 ${MAX_PACKAGED_FRONTEND_FILE_BYTES}`,
    );
  }
}

// 5) 签名：对「除 signature.json 外」的全部文件摘要签名。
const privateKeyPem = readFileSync(keyPath, 'utf8');
const signature = spec.signPackageFiles(files, privateKeyPem);
files.set('signature.json', encoder.encode(`${JSON.stringify(signature, null, 2)}\n`));

// 6) 落成 ZIP（相对路径保持内核期望的目录结构）。
mkdirSync(outDir, { recursive: true });
const staging = path.join(outDir, `.stage-${id}`);
rmSync(staging, { recursive: true, force: true });
for (const [name, data] of files) {
  const target = path.join(staging, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
}
const asset = `${id}-${version}.zip`;
const zipPath = path.join(outDir, asset);
rmSync(zipPath, { force: true });
execSync(`zip -qr -X ${JSON.stringify(zipPath)} .`, { cwd: staging, stdio: 'inherit' });
rmSync(staging, { recursive: true, force: true });

const bytes = readFileSync(zipPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');

// 7) 目录条目：与内核 `build-manifest.mjs` 共用同一套契约校验，不手写字段。
const metaPath = path.join(outDir, `.meta-${id}.json`);
const meta = {
  kind: 'plugin',
  id,
  version,
  channel,
  source: { repository, tag, asset },
  compatibility: {
    kernel: compatKernel,
    kernelApi: compatApi,
    frontendAbi: compatAbi,
    packageFormat: spec.PACKAGE_MANIFEST_FORMAT_VERSION,
  },
  requires: [],
  conflicts: [],
  permissions: permissionIds,
  // 内核目前只支持 M2（受控 iframe/隔离加载）；声明 M1 会被门禁拒绝。
  frontendModes: ['M2'],
  migration: { mode: 'none', rollback: 'code-compatible' },
  automatic: { eligible: false },
  publisher,
  ...(pluginManifest.name ? { name: pluginManifest.name } : {}),
  ...(pluginManifest.description ? { description: pluginManifest.description } : {}),
};
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

const entriesDir = path.resolve(opts['entries'] ?? path.join(outDir, 'entries'));
mkdirSync(entriesDir, { recursive: true });
// 条目文件名按 `<kind>-<id>.json`：插件与主题允许同 id（`minimal` 两边都有），
// 只写 `<id>.json` 时后拷进去的会静默覆盖前一个，目录里凭空少一条。
const manifestPath = path.join(entriesDir, `plugin-${id}.json`);
execSync(
  `node ${JSON.stringify(path.join(kernelRoot, 'scripts/release/build-manifest.mjs'))} ` +
    `--zip ${JSON.stringify(zipPath)} --input ${JSON.stringify(metaPath)} --out ${JSON.stringify(manifestPath)}`,
  { stdio: 'inherit' },
);
rmSync(metaPath, { force: true });

console.log(
  `[pack] ${id} ${version} → ${asset} (${(statSync(zipPath).size / 1024).toFixed(0)} KB, ` +
    `${files.size} files, frontend ${frontendFiles.length}, sha256 ${sha256.slice(0, 12)}…)`,
);
console.log(`[pack] entry → ${manifestPath}`);
