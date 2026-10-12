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

## 本工作区无法独立安装

各插件的 `package.json` 以 `workspace:*` 引用 `@stackpanel/sdk`、`@stackpanel/ui`、
`@stackpanel/spec`、`@stackpanel/net-guard`，而这些包尚未发布到 npm，因此本仓库
**不能单独执行 `pnpm install`**。请按下面任一种方式准备依赖：

1. 把本仓库放到内核仓库的工作区内（例如 `<kernel>/packages/plugins-external/`），
   并在 `pnpm-workspace.yaml` 中加入该路径，使本目录成为内核工作区的一部分；
2. 或者在内核仓库构建出这些包后，把本目录的 `node_modules` 指向内核的 `node_modules`。

之后即可构建单个插件：

```bash
pnpm --filter @stackpanel/plugin-catalog build
```

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
```

`kernel-tests/` 下的文件是从内核仓库迁出的内核侧集成测试，依赖内核测试夹具
（内核仓库的 `apps/api/tests/**`），只能在准备齐全的内核工作区中运行：

```bash
# 在内核仓库中，把对应的测试文件放到 apps/api/tests/integration/ 后运行
pnpm --filter @stackpanel/api test
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
