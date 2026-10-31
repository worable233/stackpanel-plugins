/**
 * Shared build preset for plugin frontend packages.
 *
 * Every plugin used to carry its own `tsup.config.ts` with a hand-written
 * `external` list, and those lists drifted: `smtp` imported `next/navigation`
 * without externalizing it, so its frontend stopped building entirely while
 * everything else stayed green. esbuild matches externals by **exact specifier**
 * (`next` does not cover `next/link`), so one forgotten subpath is enough to
 * break a package.
 *
 * One list, one place. Every entry below is provided by the host at runtime
 * (the browser-side frontend ABI or the web app's own dependencies); bundling
 * any of them would duplicate React or an SDK singleton in the same page.
 *
 * Anything *not* listed here is bundled into `dist/index.js`, which is what a
 * package-private dependency (e.g. `emoji-picker-react`) wants.
 */
import { existsSync } from 'node:fs';
import { defineConfig } from 'tsup';

/** Host-provided modules. Never bundle these. */
export const HOST_EXTERNALS = [
  '@stackpanel/sdk',
  '@stackpanel/ui',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  // `zod` is deliberately NOT here. It is not a host ABI slot, so the kernel's
  // publish-time rewrite cannot map it to `/api/frontend-abi/*` and refuses to
  // derive `admin.runtime.js` at all (`rewriteHostAbiImports` returns null on an
  // unmappable bare specifier). The package then installs, reports a revision,
  // and every admin page it owns dies with "插件页面加载失败" plus a 404 on the
  // runtime bundle. Bundle it instead — the kernel's own `build-frontend.mjs`
  // already does exactly that for `src/admin.tsx`.
  'sonner',
  'lucide-react',
  'recharts',
  'next',
  'next/link',
  'next/navigation',
  'next/router',
  'next/form',
  'next/headers',
  'next/image',
  'next/dynamic',
  'next/font',
];

/**
 * Build config for a plugin frontend.
 *
 * `platform: 'neutral'` keeps Node built-ins out of the bundle; `jsx:
 * 'automatic'` is set here because tsup's CLI has no flag for it (only
 * `--jsxFactory` / `--jsxFragment`), which is why the older build script's
 * `--jsx automatic` silently did nothing.
 */
/**
 * Entry points that actually exist on disk.
 *
 * `admin.tsx` is optional: many packages have no interactive admin surface, and
 * an entry that does not exist makes tsup fail the whole build.
 */
function entries() {
  return ['src/index.tsx', 'src/admin.tsx'].filter((file) => existsSync(file));
}

export function defineFrontendConfig(overrides = {}) {
  return defineConfig({
    // Two entries, two consumers:
    //   index.js  the *server* manifest entry the kernel imports (RSC graph);
    //   admin.js  the *client* admin components, which the browser loads from
    //             `admin.runtime.js` (host-ABI specifiers rewritten at publish).
    // A package with admin routes but no `src/admin.tsx` cannot be fixed by the
    // kernel: its React hooks would have to run in the RSC graph, which is
    // exactly the crash this entry split exists to prevent.
    entry: entries(),
    format: ['esm'],
    outDir: 'dist',
    platform: 'neutral',
    target: 'es2022',
    clean: true,
    sourcemap: true,
    external: HOST_EXTERNALS,
    // Never emit shared chunks: the kernel publishes exactly `dist/index.js`
    // and `dist/admin.js` (see the manifest `files[]` allowlist), so a
    // `chunk-*.js` both entries import would 404 in the browser and in the RSC
    // graph. Duplicating the shared i18n helper into each entry is the cost.
    splitting: false,
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
    ...overrides,
  });
}

export default defineFrontendConfig;
