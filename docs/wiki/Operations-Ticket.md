# 工单（ticket）

`ticket` 提供用户工单和管理员处理流程。工单与消息使用 `ticket/ticket`、`ticket/message` 自定义模型；用户只能读取自己的工单，管理员使用独立管理路由。

## 权限和扩展

- 版本：`0.2.0`
- 用户权限：`ticket.view`、`ticket.create`。
- 管理权限：`ticket.admin`。
- 激活时注册工单通知类型和“最近工单”管理端仪表盘组件。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/tickets` | user + `ticket.view` | 当前用户的工单列表。 |
| POST | `/tickets` | user + `ticket.create` | 创建工单。 |
| GET | `/tickets/:id` | user + `ticket.view` | 读取一张属于当前用户的工单。 |
| POST | `/tickets/:id/messages` | user + `ticket.create` | 在自己的工单中追加消息。 |
| GET | `/ticket/admin/tickets` | admin + `ticket.admin` | 管理列表。 |
| GET/PATCH | `/ticket/admin/tickets/:id` | admin + `ticket.admin` | 获取并处理工单。 |

## Open Platform、MCP 与 Agent

| Capability | 内部路由 | Open Platform alias | 写入 |
| --- | --- | --- | --- |
| `ticket.list` | `GET /tickets` | `GET /api/v1/tickets` | 否 |
| `ticket.read` | `GET /tickets/:id` | `GET /api/v1/tickets/:id` | 否 |

这两项始终经过“当前调用者拥有该工单”的业务校验。创建工单、追加消息和管理员处理尚未声明 Capability，因此不会作为 MCP 工具或 Agent 平台工具暴露。
