# StackPanel 插件集

StackPanel 的可选插件源码。内核本体在
[stackpanel](https://github.com/worable233/stackpanel) 仓库，公开文档在
[Wiki](https://github.com/worable233/stackpanel/wiki)。

## 插件清单

### 商店与商品

| 插件      | 版本  | 说明                                                                                 |
| --------- | ----- | ------------------------------------------------------------------------------------ |
| `catalog` | 0.4.0 | 为商店商品建立分类树，后台可拖拽排序、指派分类、设置上下架与库存；未分类商品默认隐藏 |
| `invoice` | 0.1.0 | 按客户或商店订单开具发票，录入明细行、税率与折扣，服务端计算小计/税额/合计，支持浏览器打印 |

### 支付与计费

| 插件          | 版本  | 说明                                                                                             |
| ------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `epay`        | 0.3.1 | 接入易支付网关，为钱包充值与订单结算提供支付宝、微信、QQ 钱包，后台配置网关地址、商户 PID 与 RSA 密钥 |
| `llm-gateway` | 0.1.0 | 签发 API 密钥，把 OpenAI、Anthropic、Gemini 等协议请求转发到上游账号池，按 token 用量与模型定价扣减钱包余额 |

### 内容与运营

| 插件     | 版本  | 说明                                                                                                   |
| -------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `cms`    | 0.3.0 | 文章与页面的草稿、版本历史、定时发布与预览；slug 变更生成 301 重定向，并输出 sitemap、feed 与多语言分组 |
| `notice` | 0.2.0 | 站点公告：后台新增、编辑、排序、上下架与删除，前台固定页面展示已发布公告                               |
| `ticket` | 0.2.0 | 用户工单：用户提交并多轮留言，管理员按状态与优先级筛选、回复与指派，账户页有我的工单入口               |

### 认证

| 插件    | 版本  | 说明                                                                                   |
| ------- | ----- | -------------------------------------------------------------------------------------- |
| `wowid` | 0.1.0 | 注册 WowID OpenID Connect 认证提供商，OAuth 2.0 授权码加 PKCE，校验 id_token 与 nonce |

### 第三方系统兼容

| 插件            | 版本  | 说明                                                                                               |
| --------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `zjmf-compat`   | 0.1.0 | 为智简魔方旧客户端提供登录、商品、购物车、主机与开通共 14 个协议接口，并带 4 个管理接口维护连接账号 |
| `zjmf-upstream` | 0.3.0 | 接入 ZJMF V1/V10 账号并定期拉取上游商品，加价后映射为本地商品，同时注册履约 provider 与管理端配置页 |

### 示例与模板

| 插件       | 版本  | 说明                                                              |
| ---------- | ----- | ----------------------------------------------------------------- |
| `hello`    | 0.1.0 | 示例插件：注册 `GET /hello` 路由并监听 `plugin.activated` 事件     |
| `minimal`  | 1.0.0 | 最小示例插件：只注册 `GET /minimal` 路由，用于验证插件加载        |
| `template` | 0.1.0 | 新插件脚手架：可复制改名的起步模板，README 说明构建与打包上传流程 |

## 与内核仓库的关系

内核仓库只保留运行时必需的插件：`login`、`store`、`store-product-card`、
`store-product-server`、`store-wallet`。本仓库的插件 `stackpanel.builtin` 为
`false`，不随内核 seed，只能作为市场包安装。

目录结构保持 `packages/plugins/<id>/`，因此各插件的 `tsconfig.json` 继承
`../../../tsconfig.base.json`、`build` 脚本调用 `../../../scripts/build-plugin.mjs`
均可解析，本仓库已带上这两个文件。

`kernel-tests/` 子目录是从内核仓库迁出的内核侧集成测试，依赖内核测试夹具
（`apps/api/tests/**`），仅作参考，不能在本仓库直接运行。

## 构建

各插件以 `workspace:*` 引用 `@stackpanel/sdk`、`@stackpanel/ui`、
`@stackpanel/spec`、`@stackpanel/net-guard`，这些包尚未发布到 npm，因此本仓库
不能独立执行 `pnpm install`。请先把本目录加入内核工作区（作为 workspace 成员，
或把 `node_modules` 指向内核的 `node_modules`），然后：

```bash
pnpm install
pnpm --filter @stackpanel/plugin-<id> build
```

打包成可上传的 ZIP 由内核仓库的 `pnpm plugin:pack <id>` 完成，产物在
`packages/plugins/<id>/dist-pack/`。

插件开发接口（manifest、路由、扩展点、前端包）见
[Wiki · 插件开发](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction)。

## 目录结构

```
packages/plugins/<id>/
├── src/index.ts          definePlugin 入口：manifest、路由、钩子
├── src/*.ts              实现代码
├── frontend/             可选的浏览器端包（pages、finder、admin route）
│   ├── manifest.json
│   ├── package.json
│   └── src/
├── kernel-tests/         内核侧集成测试（需内核工作区，仅作参考）
├── package.json
└── tsconfig.json
```

## 参与贡献

提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)；安全漏洞请按
[SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

[MIT](./LICENSE) © 2026 worable
