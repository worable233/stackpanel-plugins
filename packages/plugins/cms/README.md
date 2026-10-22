# CMS 内容管理 (cms)

内容工作流插件：文章 / 页面的草稿、版本历史、定时发布、预览，以及 slug 变更的
301 重定向。

## 存储：Extension 模型，零迁移

插件通过 `defineModel` 声明四个模型，内核在激活时为其生成真实表与索引：

| kind             | 用途                             | 关键索引（可查询字段）                          |
| ---------------- | -------------------------------- | ----------------------------------------------- |
| `cms/post`       | 文章（工作副本 + 线上快照）      | `slug`、`published`、`status`、`publishAt`、`publishedSlug` |
| `cms/page`       | 页面（同上）                     | 同上                                            |
| `cms/revision`   | 每次保存的不可变版本快照         | `resourceId`、`resourceKind`、`revisionNumber`  |
| `cms/redirect`   | 退役 slug 的 301 记录            | `fromPath`（唯一）、`active`                    |

数据完全落在插件自有表中（`ext_cms_*`），**不需要 Prisma schema 变更或迁移**：
表的建立、索引与增量演进由 Extension 引擎在 `onActivate` 前完成。

## 内容模型

- **工作副本**：编辑器读写的 `title`/`slug`/`excerpt`/`body`，带 `status`
  （`draft` / `scheduled` / `published` / `archived`）。
- **线上快照**：`published`/`publishedSlug`/`publishedTitle`/`publishedBody`/
  `publishedRevisionNumber` 是发布那一刻的副本。编辑已发布文章**不会**改变线上内容，
  直到显式发布；因此公开读路径是单次查询、无需 join 版本表。
- **版本**：每次保存写入一条 `cms/revision`（不可变），保存本身可从任意历史版本重新发布。
- **重定向**：已发布 slug 变更或被删除时，旧路径写入 `cms/redirect`。

## HTTP 契约

### 公开读（auth: public）

| 方法 | 路径                              | 说明                                    |
| ---- | --------------------------------- | --------------------------------------- |
| GET  | `/cms/posts`                      | 已发布文章列表（`page`/`pageSize`）      |
| GET  | `/cms/pages`                      | 已发布页面列表                          |
| GET  | `/cms/posts/:slug`                | 单篇已发布文章                          |
| GET  | `/cms/pages/:slug`                | 单个已发布页面                          |
| GET  | `/cms/redirects/resolve?path=`    | 退役路径解析：`{ found, target, status }` |

### 预览（auth: user）

| 方法 | 路径                                  | 说明                                  |
| ---- | ------------------------------------- | ------------------------------------- |
| GET  | `/cms/preview/:kind/:slug?revision=`  | 草稿或指定版本的预览，不影响线上内容  |

### 编辑（auth: admin）

| 方法   | 路径                                        | 说明                          |
| ------ | ------------------------------------------- | ----------------------------- |
| GET    | `/cms/admin/content/:kind`                  | 工作副本列表（可按 `status`） |
| GET    | `/cms/admin/content/:kind/:id`              | 工作副本详情                  |
| POST   | `/cms/admin/content/:kind`                  | 新建草稿（可带 `status`/`publishAt` 直接定时） |
| PATCH  | `/cms/admin/content/:kind/:id`              | 保存并生成新版本（可带 `note`） |
| POST   | `/cms/admin/content/:kind/:id/publish`      | 发布工作副本或指定 `revisionNumber` |
| POST   | `/cms/admin/content/:kind/:id/unpublish`    | 下架（保留线上快照）          |
| POST   | `/cms/admin/content/:kind/:id/revert`       | 回到草稿（线上内容不变）      |
| DELETE | `/cms/admin/content/:kind/:id`              | 删除并退役线上 slug           |
| GET    | `/cms/admin/content/:kind/:id/revisions`    | 版本历史（倒序）              |
| GET    | `/cms/admin/redirects`                      | 重定向列表                    |
| DELETE | `/cms/admin/redirects/:id`                  | 删除一条重定向                |

`:kind` 为 `post` 或 `page`。

## 定时发布

激活时注册内核任务 `cms.publish-sweep`（每 60s 一次），并声明 `publish-due`
处理器；`createDraft`/`saveRevision` 对 `status: 'scheduled'` 的项入队一个按
`publishAt` 延迟的 `cms.publish-due` 任务。处理器执行幂等的「发布所有到期项」，
因此到期时刻即发布，且不漏不重（任务名与处理器均按插件命名空间隔离，
停用时由内核清理）。

## 错误码

`cms.not_ready`(503)、`cms.unknown_kind`(404)、`cms.content.not_found`(404)、
`cms.revision.not_found`(404)、`cms.redirect.path_required`(400)。
