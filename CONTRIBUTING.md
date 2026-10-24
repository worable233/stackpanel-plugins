# 贡献指南

感谢你愿意为 StackPanel 插件集贡献代码。本文件说明环境要求、开发方式与提交流程。

## 环境要求

| 依赖    | 版本                                   |
| ------- | -------------------------------------- |
| Node.js | >= 22（见 `.nvmrc`）                   |
| pnpm    | 11.5.1（由 `packageManager` 字段锁定） |

启用 Corepack 后 pnpm 版本会自动对齐：

```bash
corepack enable
corepack prepare pnpm@11.5.1 --activate
```

## 依赖并排的内核检出

各插件的 `package.json` 以 `workspace:*` 引用 `@stackpanel/sdk`、`@stackpanel/ui`、
`@stackpanel/spec`、`@stackpanel/net-guard`，而这些包尚未发布到 npm，因此本仓库
**必须与内核检出并排放置**：

```
<parent>/
  StackPanel/            # 内核
  StackPanel-plugins/    # 本仓库
```

`pnpm-workspace.yaml` 用 `link:../StackPanel/packages/*` 覆盖这些依赖（以及 `zod`，
保证跨边界只有一个 schema 实例）。相应地，内核必须先完成：

```bash
cd ../StackPanel && pnpm install --frozen-lockfile
pnpm --filter @stackpanel/spec --filter @stackpanel/sdk \
  --filter @stackpanel/ui --filter @stackpanel/net-guard build
```

之后在本仓库执行 `pnpm dev:setup`（= `pnpm install` + 依赖校验，校验未过会直接报错
指出缺哪一步）。换成其他布局时依赖解析会静默拿到别的 `zod` 实例，跨边界 schema
校验失效。

## 目录约定

- 每个插件位于 `packages/plugins/<id>/`，`id` 匹配 `^[a-z0-9_-]{1,64}$`。
- `src/index.ts` 是 `definePlugin` 入口；`frontend/` 是可选的浏览器端包。
- 插件声明的版本以 `src/index.ts` 中的 manifest 为准，`package.json` 的
  `version` 必须与之保持一致。
- 源码中不得出现本机绝对路径、密钥或真实域名。

## 提交前必须通过

```bash
pnpm --filter @stackpanel/plugin-<id> typecheck
pnpm --filter @stackpanel/plugin-<id> build
# 插件带前端时，前端是独立的工作区项目，不会随 install 构建
pnpm --filter @stackpanel/plugin-<id>-frontend build
```

> **前端必须单独构建**：`frontend/package.json` 只有 `build: tsup`、没有 `prepare`，
> 所以全新 clone 里没有 `frontend/dist`。安装到内核时只抄了 manifest 而没有产物，
> 内核会据此判定该包「未就绪」（`GET /ready` 返回 503 且 `pendingFrontends` 里是它）。

### 内核 CI 会安装本仓库的 `main`

内核仓库的 CI 在 `Test` 之前克隆**本仓库默认分支**、对着该内核构建，并把
`referral` / `ticket` / `invoice` 安装进去，然后跑内核侧集成测试（否则那些套件会
因为「插件没装」而 skip，等于 CI 绿但没覆盖）。

因此：**本仓库 `main` 一旦不能对内核 HEAD 构建，表现是内核 CI 红。** 提交后请顺带
看一眼内核最近的 CI 结果。本仓库自身只有 i18n 门禁，没有完整 CI。

`kernel-tests/` 下的文件是从内核仓库迁出的内核侧集成测试，依赖内核测试夹具
（内核仓库的 `apps/api/tests/**`），只能在准备齐全的内核工作区中运行：

```bash
# 在内核仓库中，把对应的测试文件放到 apps/api/tests/integration/ 后运行
pnpm --filter @stackpanel/api test
```

## 多语言

插件前端统一提供 `zh-CN` / `en-US` / `zh-TW` / `zh-HK` 四种语言。`zh-CN` 是唯一
手写源，两种繁体由脚本生成。文案 key、`labelKey`/`titleKey`/`messageKey` 的用法与
manifest 重建流程见 [docs/package-i18n.md](./docs/package-i18n.md)。

提交前请跑：

```bash
pnpm i18n:hant     # 重新生成 zh-TW / zh-HK
pnpm i18n:check    # 目录一致性与繁体同步
```

## 代码规范

- **TypeScript strict**，禁止 `any` 逃逸；不要用 `@ts-ignore` 掩盖类型问题。
- 格式与静态检查由 Prettier + ESLint 统一，提交前跑 `pnpm format`。
- 提交信息遵循 Conventional Commits：`feat` / `fix` / `docs` / `refactor` /
  `perf` / `test` / `build` / `ci` / `chore`，并带 scope，
  例如 `fix(invoice): ...`。
- 新增行为必须带测试。
- 不引入 copyleft 许可的依赖。

## 不要提交的内容

- `node_modules/`、`dist/`、打包出的 `*.zip` / `*.tgz`
- 任何密钥、token、真实域名与本机绝对路径；只提交 `.env.example`
- 本机运行时数据、日志、编辑器与工具配置

## 提交流程

1. 先开 issue 说明问题或提案，比较大的改动请先讨论方案再动手。
2. 从 `main` 切出分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
3. 保持提交粒度清晰，一次提交只做一件事。
4. 发起 PR，说明动机、实现方式、验证方法与影响的用户范围。

## 文档

面向使用者的公开文档是 README 与
[Wiki](https://github.com/worable233/stackpanel/wiki)。开发笔记不对外公开，
公开文档中不引用内部笔记。

## 安全问题

不要用 PR 或公开 issue 报告漏洞，请按 [SECURITY.md](./SECURITY.md) 的流程私下报告。
