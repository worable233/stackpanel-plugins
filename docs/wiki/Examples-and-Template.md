# 示例与模板（hello、minimal、template）

这三个包用于验证插件加载和创建新插件，不应作为生产业务依赖。

| 插件 | 路由 | 作用 |
| --- | --- | --- |
| `hello` | `GET /hello` | 演示声明路由、生命周期和 `plugin.activated` 事件监听。 |
| `minimal` | `GET /minimal` | 最小定义：一个路由和激活日志。 |
| `template` | `GET /myname` | 可复制的新插件模板，带 activate/deactivate 钩子。 |

## 从模板创建插件

1. 优先在内核仓库执行 `pnpm plugin:create <id> --name "显示名称" --frontend`，或复制 `template` 目录。
2. 将包名改为 `@stackpanel/plugin-<id>`，并修改 `src/index.ts` 的 manifest id、名称和版本。
3. 在 manifest 声明权限、依赖、消费/提供的 Extension Point；所有 route 必须在边界声明 auth 和 permission。
4. 使用 `ctx.extensions` 存储自定义模型，使用 `ctx.secrets` 保存秘密；不得访问裸数据库或跨插件内部代码。
5. 若要对外公开操作，先实现普通 route，再声明 Capability，并定义 Agent Surface 和幂等语义。
6. 按内核插件打包规范构建、打包和测试 ZIP。

保留 `hello` 的事件监听只用于学习事件形状；生产代码必须定义明确的事件版本、错误处理和幂等边界。
