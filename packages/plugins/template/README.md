# StackPanel Plugin Template

Scaffold for a distributable StackPanel plugin. The kernel loads plugins from
`data/plugins/<id>/` at boot and supports **hot install/upgrade/removal** — no
restart required.

## Steps to create a plugin

0. Prefer the generator — it scaffolds the folder, wires the workspace and
   prints next steps:

   ```bash
   pnpm plugin:create <your-id> --name "显示名称" --frontend
   ```

   Manual alternative:

1. Copy this folder to `packages/plugins/<your-id>` (id: `^[a-z0-9_-]{1,64}`, no
   built-in/reserved id).
2. Rename the package to `@stackpanel/plugin-<your-id>` and update the manifest
   id in `src/index.ts`.
3. Implement routes/hooks. Use `@stackpanel/sdk` (`definePlugin`, extension
   points, `ctx.registerExtension`/`getExtensions`, `ctx.events`).
4. Build: `pnpm --filter @stackpanel/plugin-<your-id> build`
5. Pack a distributable ZIP:
   `pnpm plugin:pack <your-id>` → `packages/plugins/<your-id>/dist-pack/<your-id>-<version>.zip`
6. Upload the ZIP in the admin Plugins page (`POST /admin/plugins/upload`) — it
   goes live immediately. Enable/disable and remove also hot-reload.

## Package layout

- `manifest.json` — id/name/version/description/author/entry/export/apiVersion
- `dist/index.js` — compiled ESM entry (default export = `PluginDefinition`)
- `assets/*` — optional static files

The kernel rejects source files (`.ts`/`.tsx`/…) and validates
`apiVersion` compatibility. Plugins are executable code — treat uploads as
trusted (same trust model as npm).
