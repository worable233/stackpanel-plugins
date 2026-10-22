# CMS 内容管理（cms）

`cms` 提供文章和页面的草稿、版本、预览、定时发布和 slug 迁移。它把编辑工作副本和线上发布快照分开，因此编辑已发布内容不会立即修改公开页面。

## 模型与权限

- 版本：`0.3.0`；支持 `zh-CN`、`en-US`。
- 自定义模型：`cms/post`、`cms/page`、`cms/revision`、`cms/redirect`。
- 内容权限：`custom.cms.post.read/write`、`custom.cms.page.read/write`；管理员路由还要求 admin 身份。
- 激活时注册 `seo.provider`，并每 60 秒运行一次到期发布扫描。

`cms/revision` 是不可变快照；发布可指定某个 `revisionNumber`。已发布 slug 被替换或内容被删除时，插件维护 301 重定向记录。

## 路由

| 面 | 路径 | 说明 |
| --- | --- | --- |
| 公开 | `GET /cms/posts`、`GET /cms/pages` | 分页列出已发布内容，可带 `locale`。 |
| 公开 | `GET /cms/posts/:slug`、`GET /cms/pages/:slug` | 读取单项已发布内容。 |
| 公开 | `GET /cms/posts/:slug/translations`、`GET /cms/pages/:slug/translations` | 获取译文集合。 |
| 公开 | `GET /cms/redirects/resolve?path=` | 解析退役路径，返回命中状态和目标。 |
| 登录 | `GET /cms/preview/:kind/:slug?revision=` | 预览草稿或指定版本；`:kind` 为 `post` 或 `page`。 |
| 管理 | `GET/POST /cms/admin/content/:kind` | 列表和新建草稿。 |
| 管理 | `GET/PATCH/DELETE /cms/admin/content/:kind/:id` | 读取、保存新版本、删除内容。 |
| 管理 | `POST /cms/admin/content/:kind/:id/publish` | 发布当前或指定版本。 |
| 管理 | `POST /cms/admin/content/:kind/:id/unpublish`、`/revert` | 下架或回到草稿。 |
| 管理 | `GET /cms/admin/content/:kind/:id/revisions` | 分页列出版本。 |
| 管理 | `GET /cms/admin/redirects`、`DELETE /cms/admin/redirects/:id` | 管理重定向。 |

## 定时发布

创建或保存带 `status: 'scheduled'` 和 `publishAt` 的内容会安排延迟任务；激活后的周期扫描会幂等发布所有到期内容。开发者不应自行启动定时器或绕过工作流直接改扩展模型。

## 扩展边界

CMS 不声明 Open Platform Capability。需要使用 CMS 数据的主题和插件应调用公开路由或消费其公开 SEO 行为；不要依赖扩展模型表名或内部快照字段。
