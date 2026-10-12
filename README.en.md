# StackPanel Plugins

Source for the optional StackPanel plugins. The kernel lives in the
[stackpanel](https://github.com/worable233/stackpanel) repository and the public
documentation is in the
[Wiki](https://github.com/worable233/stackpanel/wiki).

## Plugins

### Storefront and catalog

| Plugin    | Version | Description                                                                                                                            |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog` | 0.4.0   | A hierarchical category tree for store products: drag-and-drop ordering, product assignment, shelf status and stock. Unassigned products are hidden by default. |
| `invoice` | 0.1.0   | Issues invoices for store orders or customers with line items, tax and discount, server-side totals, and browser printing.              |

### Payments and billing

| Plugin        | Version | Description                                                                                                                  |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `epay`        | 0.3.1   | EasyPay gateway adding Alipay, WeChat and QQ Wallet for wallet top-ups and order settlement, configured with gateway URL, merchant PID and RSA keys. |
| `llm-gateway` | 0.1.0   | Issues API keys, relays OpenAI, Anthropic, Gemini and Responses API calls to a pooled upstream account set, and debits wallet balance per token usage and model pricing. |

### Content and operations

| Plugin   | Version | Description                                                                                                                       |
| -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `cms`    | 0.3.0   | Posts and pages with drafts, revision history, scheduled publishing and preview; slug changes create 301 redirects, plus sitemap, feed and translation groups. |
| `notice` | 0.2.0   | Site announcements: admins create, edit, reorder, publish/unpublish and delete, shown to visitors on a public page.                |
| `ticket` | 0.2.0   | Support tickets: users submit and reply, admins triage by status and priority, reply and assign, with an account-page entry point. |

### Authentication

| Plugin  | Version | Description                                                                                                  |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `wowid` | 0.1.0   | Registers a WowID OpenID Connect provider using the OAuth 2.0 authorization code flow with PKCE, verifying id_token and nonce. |

### Third-party integration

| Plugin          | Version | Description                                                                                                              |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `zjmf-compat`   | 0.1.0   | Translates the legacy ZJMF client protocol (login, products, cart, hosts, provisioning — 14 endpoints) into platform store operations, plus 4 admin endpoints managing connection accounts. |
| `zjmf-upstream` | 0.3.0   | Syncs ZJMF V1/V10 upstream products into the store with markup, registers the zjmf fulfillment provider, and adds an admin configuration page. |

### Examples and scaffolding

| Plugin     | Version | Description                                                                                     |
| ---------- | ------- | ----------------------------------------------------------------------------------------------- |
| `hello`    | 0.1.0   | Demo plugin exposing `GET /hello` and listening for the `plugin.activated` event.                |
| `minimal`  | 1.0.0   | Smallest example plugin: one `GET /minimal` route, used to verify plugin loading.                |
| `template` | 0.1.0   | Scaffold for new plugins: a copy-and-rename starting point whose README covers build and packaging. |

## Relation to the kernel repository

The kernel repository keeps only the plugins it needs at runtime: `login`,
`store`, `store-product-card`, `store-product-server` and `store-wallet`. The
plugins here set `stackpanel.builtin` to `false`, so they are not seeded by the
kernel and can only be installed as marketplace packages.

The `packages/plugins/<id>/` layout is preserved so that each plugin's
`tsconfig.json` can extend `../../../tsconfig.base.json` and its `build` script
can call `../../../scripts/build-plugin.mjs`. Both files are included here.

`kernel-tests/` holds the kernel-side integration tests that moved out of the
kernel repository. They depend on the kernel test fixtures (`apps/api/tests/**`)
and are kept for reference only; they cannot run in this repository.

## Building

Plugins reference `@stackpanel/sdk`, `@stackpanel/ui`, `@stackpanel/spec` and
`@stackpanel/net-guard` through `workspace:*`, and those packages are not
published to npm, so this repository cannot run `pnpm install` on its own. Add
this directory to a kernel workspace first (as a workspace member, or by
pointing `node_modules` at the kernel's), then:

```bash
pnpm install
pnpm --filter @stackpanel/plugin-<id> build
```

Packing an uploadable ZIP is done by the kernel repository's
`pnpm plugin:pack <id>`, which writes to `packages/plugins/<id>/dist-pack/`.

The plugin API (manifest, routes, extension points, frontend packages) is
documented in the
[Wiki · Plugin development](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction).

## Layout

```
packages/plugins/<id>/
├── src/index.ts          definePlugin entry: manifest, routes, hooks
├── src/*.ts              implementation
├── frontend/             optional browser-side package (pages, finders, admin routes)
│   ├── manifest.json
│   ├── package.json
│   └── src/
├── kernel-tests/         kernel-side integration tests (kernel workspace only)
├── package.json
└── tsconfig.json
```

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes. Report
security issues privately as described in [SECURITY.md](./SECURITY.md).

## License

Released under the [MIT](./LICENSE) license.
