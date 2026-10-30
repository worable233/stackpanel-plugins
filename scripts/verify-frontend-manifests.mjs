#!/usr/bin/env node
/**
 * Verify each plugin's `frontend/src/index.tsx` against its committed
 * `frontend/manifest.json`, using the same host-ABI aliases the kernel's own
 * frontend build uses.
 *
 * `check-frontend-manifests.mjs` answers "does the manifest agree with itself".
 * This answers "does the manifest agree with the code the host will actually
 * load", which is the failure that shipped: the bundles exported one set of
 * finders while the manifests described page data the kernel had to delete.
 *
 * The probe bundles the package source with `react`, `next/*`, `@stackpanel/ui`
 * and friends aliased to the host's copies (exactly as `build-frontend.mjs` in
 * the kernel does), imports it, and compares the exported `FrontendPackage`
 * with the manifest:
 *
 *   - every `finders` key is declared, and every declared finder exists;
 *   - every `data[].finder` on pages/admin/account routes resolves;
 *   - the route tables (`path`/`component`/`permission`) match.
 *
 * Requires a kernel checkout with built host packages — this repo already
 * depends on that (`scripts/check-dependencies.mjs`), and the preset links
 * against it. Exits non-zero on any mismatch.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { kernelRoot } from './check-dependencies.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = join(repoRoot, 'packages', 'plugins');
const esbuildBin = resolve(kernelRoot, 'node_modules', '.bin', 'esbuild');

const STUB = [
  'export default function Link(props) { return props.children ?? null; }',
  'export function redirect(url) { throw new Error("NEXT_REDIRECT;" + url); }',
  'export function notFound() { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); }',
  'export function usePathname() { return "/"; }',
  'export function useSearchParams() { return new URLSearchParams(); }',
  'export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {} }; }',
].join('\n');

const scratch = mkdtempSync(join(tmpdir(), 'sp-frontend-probe-'));
const stubPath = join(scratch, 'next-stub.mjs');
writeFileSync(stubPath, `${STUB}\n`);

const problems = [];
let probed = 0;

try {
  for (const id of readdirSync(pluginsRoot)) {
    const frontendDir = join(pluginsRoot, id, 'frontend');
    const sourceEntry = join(frontendDir, 'src', 'index.tsx');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(frontendDir, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }

    const outDir = join(scratch, id);
    try {
      execFileSync(
        esbuildBin,
        [
          sourceEntry,
          '--bundle',
          '--format=esm',
          `--outdir=${outDir}`,
          '--platform=node',
          '--target=node22',
          '--log-level=error',
          `--alias:next/link=${stubPath}`,
          `--alias:next/form=${stubPath}`,
          `--alias:next/navigation=${stubPath}`,
          `--alias:react/jsx-runtime=${resolve(kernelRoot, 'apps/web/node_modules/react/jsx-runtime.js')}`,
          `--alias:react=${resolve(kernelRoot, 'apps/web/node_modules/react')}`,
          `--alias:@stackpanel/ui=${resolve(kernelRoot, 'packages/ui/dist/index.js')}`,
          `--alias:lucide-react=${resolve(kernelRoot, 'apps/web/node_modules/lucide-react')}`,
          '--main-fields=module,main',
        ],
        { cwd: resolve(kernelRoot, 'apps/web'), stdio: 'pipe' },
      );
    } catch (error) {
      problems.push(
        `${id}: probe build failed — ${
          String(error.stderr ?? error.message)
            .trim()
            .split('\n')[0]
        }`,
      );
      continue;
    }

    let pkg;
    try {
      const mod = await import(pathToFileURL(join(outDir, 'index.js')).href);
      pkg = mod.default ?? mod.frontend;
    } catch (error) {
      problems.push(`${id}: probe import failed — ${error.message.split('\n')[0]}`);
      continue;
    }
    if (!pkg || typeof pkg !== 'object') {
      problems.push(`${id}: frontend module has no default export`);
      continue;
    }
    probed += 1;

    const exported = new Set(Object.keys(pkg.finders ?? {}));
    for (const finder of manifest.finders ?? []) {
      if (!exported.has(finder)) {
        problems.push(
          `${id}: manifest declares finder "${finder}" but the package does not export it`,
        );
      }
    }
    for (const finder of exported) {
      if (!(manifest.finders ?? []).includes(finder)) {
        problems.push(`${id}: package exports finder "${finder}" but the manifest omits it`);
      }
    }

    const sections = [
      ['pages', pkg.pages, pkg.ui?.pages],
      ['adminRoutes', manifest.adminRoutes, pkg.ui?.adminRoutes],
      ['accountRoutes', manifest.accountRoutes, pkg.ui?.accountRoutes],
    ];
    for (const [label, fromManifest, fromPackage] of sections) {
      const routes = fromManifest ?? [];
      for (const route of routes) {
        for (const requirement of route.data ?? []) {
          // `fetch` requirements are performed by the host — no package export
          // needed and no execution admission required (ADR-0027). Only the
          // finder form has to be backed by a real export.
          if (typeof requirement.fetch?.path === 'string') {
            if (
              !requirement.fetch.path.startsWith('/') ||
              requirement.fetch.path.startsWith('//') ||
              requirement.fetch.path.startsWith('/api/') ||
              requirement.fetch.path.split('/').some((seg) => seg === '..' || seg === '.')
            ) {
              problems.push(
                `${id}: ${label} ${route.path} declares a non kernel-relative fetch path "${requirement.fetch.path}"`,
              );
            }
            continue;
          }
          if (!exported.has(requirement.finder)) {
            problems.push(
              `${id}: ${label} ${route.path} requires unexported finder "${requirement.finder}"`,
            );
          }
        }
      }
      if (fromPackage === undefined) continue;
      const manifestPaths = routes.map((route) => route.path).sort();
      const packagePaths = (fromPackage ?? []).map((route) => route.path).sort();
      if (JSON.stringify(manifestPaths) !== JSON.stringify(packagePaths)) {
        problems.push(
          `${id}: ${label} paths differ — manifest [${manifestPaths.join(', ')}] vs source [${packagePaths.join(', ')}]`,
        );
      }
      for (const route of fromPackage ?? []) {
        const stored = routes.find((entry) => entry.path === route.path);
        if (!stored) continue;
        if (stored.component !== route.component) {
          problems.push(
            `${id}: ${label} ${route.path} component "${stored.component}" != source "${route.component}"`,
          );
        }
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error('[verify-frontend-manifests] failing:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n${problems.length} problem(s) across ${probed} probed package(s).`);
  process.exit(1);
}

console.log(`[verify-frontend-manifests] OK — ${probed} package(s) match their source`);
