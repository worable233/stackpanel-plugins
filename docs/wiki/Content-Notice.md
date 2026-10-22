# 站点公告（notice）

`notice` 管理前台站点公告。公告内容保存在插件自有的 `notice/announcement` 扩展模型中，按 `published` 和 `sortOrder` 索引查询。

## 权限和数据

- 版本：`0.2.0`
- 管理权限：`notice.admin`
- 字段：`title`（1–191 字）、`content`（1–5000 字）、`published`、`sortOrder`（0–9999）。
- 前端：管理端公告页和公开 `/notice` 页面。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/notices` | public | 按排序返回已发布公告。 |
| GET | `/notice/admin/announcements` | admin + `notice.admin` | 返回全部公告。 |
| POST | `/notice/admin/announcements` | admin + `notice.admin` | 新建公告。 |
| PATCH | `/notice/admin/announcements/:id` | admin + `notice.admin` | 更新标题、正文、发布状态或排序。空对象会被拒绝。 |
| DELETE | `/notice/admin/announcements/:id` | admin + `notice.admin` | 删除公告。 |

## 集成边界

公开公告接口适合主题或前台包消费。插件目前没有 Capability 或跨插件 Extension Point；不要依赖 `ext_notice_*` 的物理表名。
