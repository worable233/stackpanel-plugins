#!/usr/bin/env node
/**
 * Check every plugin's committed `frontend/manifest.json` against the kernel's
 * current frontend contract and against the plugin's own source.
 *
 * Why this exists: the manifests are hand-maintained (the bundles are not
 * committed), and they drifted. Ten packages described page data with a shape the
 * kernel did not accept at the time, the installer "fixed" it by deleting the data
 * requirement, and every settings form silently rendered blank.
 *
 * Since ADR-0027 the kernel accepts two mutually exclusive forms:
 *
 *     { "fetch": { "path": "/smtp/admin/config" }, "as": "status" }   // host GET
 *     { "finder": "smtp.status", "as": "status" }                     // package code
 *
 * The check is deliberately structural, not a TS parse: it verifies the things
 * that actually break —
 *
 *   1. every `data[].finder` is declared in `manifest.finders`;
 *   2. every declared finder exists as a literal key in the package source,
 *      so the manifest cannot promise a finder the bundle does not export;
 *   3. a `fetch` requirement has a kernel-relative path (the kernel rejects the
 *      package otherwise: no absolute URLs, no `..`, no `/api/` prefix).
 *
 * Usage: node scripts/check-frontend-manifests.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = join(repoRoot, 'packages', 'plugins');

const problems = [];
let checked = 0;

function report(pkg, message) {
  problems.push(`${pkg}: ${message}`);
}

for (const entry of readdirSync(pluginsRoot)) {
  const frontendDir = join(pluginsRoot, entry, 'frontend');
  const manifestPath = join(frontendDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue; // no frontend package
  }
  checked += 1;

  const declared = new Set(manifest.finders ?? []);
  const routes = [
    ...(manifest.pages ?? []),
    ...(manifest.adminRoutes ?? []),
    ...(manifest.accountRoutes ?? []),
  ];
  for (const route of routes) {
    for (const requirement of route.data ?? []) {
      const hasFinder = typeof requirement.finder === 'string';
      const hasFetch = typeof requirement.fetch?.path === 'string';
      if (hasFinder === hasFetch) {
        report(
          entry,
          `${route.path}: data requirement must declare exactly one of "finder" or "fetch"`,
        );
        continue;
      }
      if (hasFetch) {
        const path = requirement.fetch.path;
        if (
          !path.startsWith('/') ||
          path.startsWith('//') ||
          path.includes('\\') ||
          path.split('/').some((segment) => segment === '..' || segment === '.') ||
          path.startsWith('/api/')
        ) {
          report(entry, `${route.path}: fetch.path "${path}" is not a kernel-relative path`);
        }
        continue;
      }
      if (!declared.has(requirement.finder)) {
        report(entry, `${route.path}: finder "${requirement.finder}" is not in manifest.finders`);
      }
    }
  }

  // Every promised finder must be implemented in the package source, otherwise
  // the host renders the page with `finder 未注册` and empty data.
  const srcDir = join(frontendDir, 'src');
  let source = '';
  try {
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
      if (statSync(join(srcDir, file)).isFile()) source += readFileSync(join(srcDir, file), 'utf8');
    }
  } catch {
    /* no src dir: only flag it if the manifest promises finders */
  }
  for (const finder of declared) {
    const pattern = new RegExp(`['"]${finder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`);
    if (!pattern.test(source)) {
      report(entry, `manifest.finders lists "${finder}" but no source file defines that finder`);
    }
  }
}

if (problems.length > 0) {
  console.error('[check-frontend-manifests] failing:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    `\n${problems.length} problem(s) across ${checked} package(s). ` +
      'A package that reaches the kernel with these fails install validation.',
  );
  process.exit(1);
}

console.log(`[check-frontend-manifests] OK — ${checked} frontend package(s) match the contract`);
