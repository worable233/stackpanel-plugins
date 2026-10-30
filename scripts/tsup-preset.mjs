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
  'zod',
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
export function defineFrontendConfig(overrides = {}) {
  return defineConfig({
    entry: ['src/index.tsx'],
    format: ['esm'],
    outDir: 'dist',
    platform: 'neutral',
    target: 'es2022',
    clean: true,
    sourcemap: true,
    external: HOST_EXTERNALS,
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
    ...overrides,
  });
}

export default defineFrontendConfig;
