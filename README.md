<h1 align="center">StackPanel Plugins</h1>

<p align="center">StackPanel 官方可选插件源码：将商店、支付、内容、支持与 AI 服务扩展为可安装的业务能力。</p>

<p align="center">
  <a href="https://github.com/worable233/stackpanel"><img src="https://img.shields.io/badge/StackPanel-Kernel-111827?style=flat-square" alt="StackPanel Kernel"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/worable233/stackpanel-plugins?style=flat-square" alt="MIT 许可证"></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a> ·
  <a href="https://github.com/worable233/stackpanel">内核</a> ·
  <a href="https://github.com/worable233/stackpanel-plugins/wiki">插件文档</a> ·
  <a href="#参与开发">参与开发</a>
</p>

---

> [!TIP]
> 本仓库仍处于早期开发阶段。插件的接口、配置和发行方式可能发生破坏性更改；升级前请阅读发行说明并备份实例。欢迎提交 Issue、完善文档和 Pull Request。

这里存放 **StackPanel 可选插件的源码**。内核只随附身份、商店和运行时必需的最小插件集；业务插件独立演进，通过市场包或受信任的 ZIP 安装到实例中。

## 从这里开始

| 你要做什么 | 从这里开始 |
| --- | --- |
| 为正在运行的 StackPanel 安装插件 | 已配置插件市场时，可在管理员后台浏览已发布包；也可在 **系统 → 插件** 上传来自可信发行渠道的 ZIP。此仓库是源码，不是直接部署到服务器的 Compose 项目。 |
| 了解某个插件能做什么、怎样配置 | 查看下方插件目录，并进入 [插件 Wiki](https://github.com/worable233/stackpanel-plugins/wiki) 的对应说明。 |
| 开发或修复插件 | 阅读“参与开发”，再参考 [插件开发契约](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction)。 |
| 打包和发布插件 | 使用 [插件打包规范](https://github.com/worable233/stackpanel/wiki/Plugin-Packaging)，确保包的 API 版本、前端产物和签名策略与内核匹配。 |

> [!WARNING]
> 插件会在你的服务器上执行代码。只安装可信来源的包，并先在测试实例验证插件与当前内核版本的兼容性。

## 官方插件

### 商店与财务

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| [`catalog`](./packages/plugins/catalog) | 0.4.0 | 商品分类树、商品归类、上架状态和库存管理。 |
| [`invoice`](./packages/plugins/invoice) | 0.1.0 | 面向客户或订单的发票、税率、折扣与打印。 |
| [`epay`](./packages/plugins/epay) | 0.3.1 | 易支付网关，为钱包充值和订单结算接入支付宝、微信和 QQ 钱包。 |
| [`zjmf-upstream`](./packages/plugins/zjmf-upstream) | 0.3.0 | 同步智简魔方 V1/V10 上游商品、加价映射为本地商品，并提供履约能力。 |

### 内容、支持与增长

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| [`cms`](./packages/plugins/cms) | 0.3.0 | 文章和页面的草稿、版本、定时发布、预览、重定向、sitemap 与 feed。 |
| [`notice`](./packages/plugins/notice) | 0.2.0 | 面向访客的站点公告发布、排序和上下架。 |
| [`ticket`](./packages/plugins/ticket) | 0.2.0 | 用户工单、多轮回复、分配、优先级和状态管理。 |
| [`referral`](./packages/plugins/referral) | 0.1.0 | 邀请链接、注册归因、余额奖励和推广管理。 |
| [`smtp`](./packages/plugins/smtp) | 0.1.0 | 通过 SMTP 发送站内通知与注册验证码，支持 TLS、认证、连接池和限速。 |
| [`wecom-mail`](./packages/plugins/wecom-mail) | 0.2.0 | 通过企业微信「应用发送邮件」接口发送站内通知与注册验证码，无需自建 SMTP 与发信域名。 |
| [`captcha`](./packages/plugins/captcha) | 0.1.0 | 在登录、注册、改密码等敏感操作前加人机验证，支持 Turnstile / hCaptcha / reCAPTCHA / Cap 与任意 siteverify 兼容接口。 |

### AI、身份与第三方系统

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| [`llm-gateway`](./packages/plugins/llm-gateway) | 0.1.0 | 为用户签发 API 密钥，将 OpenAI、Anthropic、Gemini 等协议请求路由到上游账号池，并按用量结算。 |
| [`wowid`](./packages/plugins/wowid) | 0.1.0 | WowID OpenID Connect 登录，使用授权码流程与 PKCE。 |
| [`zjmf-compat`](./packages/plugins/zjmf-compat) | 0.1.0 | 将智简魔方旧客户端协议转换为 StackPanel 的登录、商店与开通能力。 |

### 示例与脚手架

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| [`hello`](./packages/plugins/hello) | 0.1.0 | 最小的路由、生命周期和事件监听示例。 |
| [`minimal`](./packages/plugins/minimal) | 1.0.0 | 仅含一个路由的最小加载验证插件。 |
| [`template`](./packages/plugins/template) | 0.1.0 | 可复制改名的新插件起步模板。 |

## 与内核的边界

内核仓库只保留运行时必需的 `login`、`store`、`store-product-card`、`store-product-server` 和 `store-wallet`。本仓库全部插件的 `stackpanel.builtin` 都是 `false`：它们不会随新实例自动安装，也不会因克隆此仓库而自动出现在生产环境。

共享接口由内核维护：插件通过 SDK 声明 manifest、权限、路由、扩展点、事件和前端包。插件可在不重启 API 的情况下安装、升级、启用、停用或卸载；兼容性与信任边界见 [插件生命周期](https://github.com/worable233/stackpanel/wiki/Plugin-Lifecycle) 和 [插件安全](https://github.com/worable233/stackpanel/wiki/Plugin-Security)。

每个插件的业务说明、配置示例、上游服务要求和故障排查应维护在本仓库的 [Wiki](https://github.com/worable233/stackpanel-plugins/wiki)；内核 Wiki 只维护共享 API 和平台契约。

## 参与开发

开发时请将内核与插件仓库并排放置为 `StackPanel/` 和 `StackPanel-plugins/`。插件仓有自己的 `node_modules` 和锁文件；不要把整个依赖目录软链到内核。`pnpm-workspace.yaml` 会显式链接内核的 SDK、UI、Spec 与网络防护包。

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

首次生成锁文件或有意更新依赖时使用 `pnpm dev:setup --no-frozen-lockfile`。切换内核分支或升级内核依赖后，先重新安装内核，再运行插件仓的 `dev:setup` 与 `deps:check`。

内核检出不在 `../StackPanel` 时，把 `pnpm-workspace.yaml` 里 4 处 `link:` 与 `zod` 那一行的路径改成实际位置。**这是内核位置的唯一事实来源**：pnpm 不对 `link:` 做环境变量插值（写 `${VAR}/…` 会被当成字面量目录名），所以不能靠环境变量代替改文件。`check-dependencies.mjs` 与 `install-into-kernel.mjs` 都从这一行读取内核根目录，保证「装到哪个内核」和「校验哪个内核」不会各说各话。`STACKPANEL_KERNEL_ROOT` 与 `--kernel <path>` 仍可临时覆盖（优先级高于文件）。`pnpm deps:check` 会校验「内核已安装、内核包已构建、`@stackpanel/*` 与 `zod` 都解析到内核那一份」。

> `pnpm install` 会触发各包的 `prepare`。`llm-gateway` 的 `prepare` 是 `tsc`，而它交付的是 `build-plugin.mjs` 的 esbuild 单文件产物——**安装后必须重跑一次 `build-plugin.mjs`**，否则 `dist/index.js` 会被拆成 30+ 个模块，装进内核时报 `Cannot find module '@stackpanel/llm-protocol'`。

若要在内核开发环境中读取本仓插件源，将 `STACKPANEL_PLUGIN_SOURCES` 指向 `../StackPanel-plugins/packages/plugins`，然后在内核仓库运行 `pnpm build:frontend`。外部同名插件源优先于内核内置副本；生产环境请使用已验证的市场包或 ZIP，而不是开发源目录。

插件目录结构、manifest、前端 ABI、Agent Surface、MCP 能力、通知扩展与打包要求，请从 [插件开发文档](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction) 开始。

## 贡献与安全

提交前请阅读 [贡献指南](https://github.com/worable233/stackpanel/blob/main/CONTRIBUTING.md)，并为变更的插件补充对应测试和文档。安全漏洞请按 [内核安全策略](https://github.com/worable233/stackpanel/blob/main/SECURITY.md) 私下报告，不要公开提交 Issue。

## 许可证

[MIT](./LICENSE)。
