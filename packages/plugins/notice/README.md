# 站点公告 (notice)

管理站点公告：管理员在后台新增、编辑、排序、上下架和删除公告，前台在固定页面按
排序展示已发布的公告。

## 存储：Extension 模型，零迁移

插件通过 `defineModel` 声明 `notice/announcement` 模型，内核在激活时生成真实表与索引：

| 字段        | 类型    | 说明                       |
| ----------- | ------- | -------------------------- |
| `title`     | string  | 标题，1–191 字             |
| `content`   | string  | 正文，1–5000 字            |
| `published` | boolean | 是否发布，默认 `true`      |
| `sortOrder` | integer | 排序，0–9999，默认 0       |

索引建在 `published` 与 `sortOrder` 上，列表查询按排序值返回。数据落在插件自有表中
（`ext_notice_*`），不需要 Prisma schema 变更或迁移。

## HTTP 契约

### 公开读（auth: public）

| 方法 | 路径       | 说明                     |
| ---- | ---------- | ------------------------ |
| GET  | `/notices` | 已发布公告列表，按排序值 |

### 编辑（auth: admin）

| 方法   | 路径                                    | 说明     |
| ------ | --------------------------------------- | -------- |
| GET    | `/notice/admin/announcements`           | 全部公告 |
| POST   | `/notice/admin/announcements`           | 新建     |
| PATCH  | `/notice/admin/announcements/:id`       | 更新     |
| DELETE | `/notice/admin/announcements/:id`       | 删除     |

`PATCH` 至少需要一个字段，空对象返回 400。

## 前端页面

`frontend/` 提供两个入口：

- 管理端「站点公告」页（`/overview`），配套 3 个 manifest actions 覆盖新建、上下架
  与删除；
- 前台固定页面 `/notice`，展示已发布公告列表。

## 错误码

`notice.id_required`(400)、`notice.params_invalid`(400)、`notice.not_found`(404)、
`notice.not_ready`(503)。
