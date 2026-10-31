<h1 align="center">StackPanel Plugins</h1>

<p align="center">Official optional StackPanel plugin sources for extending commerce, payments, content, support, and AI services.</p>

<p align="center">
  <a href="https://github.com/worable233/stackpanel"><img src="https://img.shields.io/badge/StackPanel-Kernel-111827?style=flat-square" alt="StackPanel Kernel"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/worable233/stackpanel-plugins?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong> ·
  <a href="https://github.com/worable233/stackpanel">Kernel</a> ·
  <a href="https://github.com/worable233/stackpanel-plugins/wiki">Plugin docs</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

> [!TIP]
> This repository is still in early development. Plugin interfaces, configuration, and distribution may introduce breaking changes. Read release notes and back up your instance before upgrading. Issues, documentation improvements, and pull requests are welcome.

This repository contains **source code for optional StackPanel plugins**. The kernel ships only the minimal plugins required at runtime; business plugins evolve independently and are installed into an instance through marketplace packages or trusted ZIP uploads.

## Start here

| You want to | Start here |
| --- | --- |
| Install a plugin in a running StackPanel instance | When Plugin Marketplace is configured, browse published packages in the administrator console; you can also upload a ZIP from a trusted distribution channel through **System → Plugins**. This repository is source code, not a Compose project to deploy to a server. |
| Understand and configure a plugin | Browse the plugin directories below, then use the relevant guide in the [plugin Wiki](https://github.com/worable233/stackpanel-plugins/wiki). |
| Develop or fix a plugin | Read “Contributing”, then start with the shared [plugin development contract](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction). |
| Package and publish a plugin | Follow the [plugin packaging guide](https://github.com/worable233/stackpanel/wiki/Plugin-Packaging) so the API version, frontend artifacts, and signing policy match the kernel. |

> [!WARNING]
> Plugins execute code on your server. Install packages only from trusted sources and validate compatibility with your current kernel version on a test instance first.

## Official plugins

### Commerce and finance

| Plugin | Version | Purpose |
| --- | --- | --- |
| [`catalog`](./packages/plugins/catalog) | 0.4.0 | Product categories, product assignment, listing status, and inventory management. |
| [`invoice`](./packages/plugins/invoice) | 0.1.0 | Customer and order invoices with tax, discounts, and printing. |
| [`epay`](./packages/plugins/epay) | 0.3.1 | EasyPay gateway for wallet top-ups and order settlement through Alipay, WeChat, and QQ Wallet. |
| [`zjmf-upstream`](./packages/plugins/zjmf-upstream) | 0.3.0 | Syncs ZJMF V1/V10 upstream products, maps marked-up products into the local store, and provides fulfillment. |

### Content, support, and growth

| Plugin | Version | Purpose |
| --- | --- | --- |
| [`cms`](./packages/plugins/cms) | 0.3.0 | Posts and pages with drafts, revisions, scheduled publishing, preview, redirects, sitemap, and feeds. |
| [`notice`](./packages/plugins/notice) | 0.2.0 | Public site announcements with publishing, ordering, and visibility control. |
| [`ticket`](./packages/plugins/ticket) | 0.2.0 | Customer tickets, threaded replies, assignment, priorities, and status management. |
| [`referral`](./packages/plugins/referral) | 0.1.0 | Referral links, registration attribution, wallet rewards, and referral administration. |
| [`smtp`](./packages/plugins/smtp) | 0.1.0 | SMTP delivery for in-app notifications and registration challenges, with TLS, auth, pooling, and rate limits. |
| [`wecom-mail`](./packages/plugins/wecom-mail) | 0.1.0 | Delivers in-app notifications and registration challenges through the WeCom “app send email” API, with no SMTP server or sending domain to run. |

### AI, identity, and third-party systems

| Plugin | Version | Purpose |
| --- | --- | --- |
| [`llm-gateway`](./packages/plugins/llm-gateway) | 0.1.0 | Issues user API keys, routes OpenAI, Anthropic, Gemini, and related protocol requests to upstream accounts, then settles usage. |
| [`wowid`](./packages/plugins/wowid) | 0.1.0 | WowID OpenID Connect sign-in using the authorization code flow and PKCE. |
| [`zjmf-compat`](./packages/plugins/zjmf-compat) | 0.1.0 | Adapts legacy ZJMF client requests to StackPanel login, store, and provisioning capabilities. |

### Examples and scaffolding

| Plugin | Version | Purpose |
| --- | --- | --- |
| [`hello`](./packages/plugins/hello) | 0.1.0 | Small example for routes, lifecycle hooks, and event listeners. |
| [`minimal`](./packages/plugins/minimal) | 1.0.0 | One-route plugin for minimal load verification. |
| [`template`](./packages/plugins/template) | 0.1.0 | Copy-and-rename starting point for a new plugin. |

## Kernel boundary

The kernel repository retains only `login`, `store`, `store-product-card`, `store-product-server`, and `store-wallet`, which are required at runtime. Every plugin here has `stackpanel.builtin: false`: it is not installed in a new instance and cloning this repository never makes it appear in production automatically.

The kernel maintains the shared contract. Plugins use the SDK to declare manifests, permissions, routes, extension points, events, and frontend packages. A plugin can be installed, upgraded, enabled, disabled, or removed without restarting the API. See [plugin lifecycle](https://github.com/worable233/stackpanel/wiki/Plugin-Lifecycle) and [plugin security](https://github.com/worable233/stackpanel/wiki/Plugin-Security) for compatibility and trust boundaries.

Keep each plugin's business guide, configuration examples, upstream requirements, and troubleshooting in this repository’s [Wiki](https://github.com/worable233/stackpanel-plugins/wiki). The kernel Wiki documents only shared APIs and platform contracts.

## Contributing

For development, place the kernel and plugin repositories alongside each other as `StackPanel/` and `StackPanel-plugins/`. The plugin repository owns its own `node_modules` and lockfile; do not symlink its full dependency directory to the kernel. `pnpm-workspace.yaml` explicitly links the kernel SDK, UI, Spec, and network-guard packages.

```bash
git clone https://github.com/worable233/stackpanel.git StackPanel
git clone https://github.com/worable233/stackpanel-plugins.git StackPanel-plugins

cd StackPanel
pnpm install --frozen-lockfile
pnpm build

cd ../StackPanel-plugins
pnpm dev:setup --frozen-lockfile
pnpm deps:check
pnpm --filter @stackpanel/plugin-<id> test
pnpm --filter @stackpanel/plugin-<id> build
```

Use `pnpm dev:setup --no-frozen-lockfile` only when intentionally creating or updating the lockfile. After switching kernel branches or upgrading kernel dependencies, reinstall the kernel first, then run `dev:setup` and `deps:check` in this repository.

When the kernel checkout is not at `../StackPanel`, point `STACKPANEL_KERNEL_ROOT` at it and update the `link:` paths in `pnpm-workspace.yaml` accordingly. `pnpm deps:check` verifies that the kernel is installed and built, and that `@stackpanel/*` plus `zod` all resolve to the kernel's copy.

To read these plugin sources in a kernel development environment, point `STACKPANEL_PLUGIN_SOURCES` at `../StackPanel-plugins/packages/plugins`, then run `pnpm build:frontend` in the kernel repository. An external source with the same plugin id takes precedence over the built-in copy. In production, use a tested marketplace package or ZIP rather than a development source directory.

For plugin structure, manifests, frontend ABI, Agent Surface, MCP capabilities, notification extensions, and packaging requirements, start with the [plugin development guide](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction).

## Security and license

Read the [contributing guide](https://github.com/worable233/stackpanel/blob/main/CONTRIBUTING.md) before submitting a change, and include tests and documentation for the plugin you modify. Report vulnerabilities privately under the [kernel security policy](https://github.com/worable233/stackpanel/blob/main/SECURITY.md).

Released under the [MIT](./LICENSE) license.
