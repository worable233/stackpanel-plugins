# StackPanel 官方插件开发文档

本 Wiki 记录 `worable233/stackpanel-plugins` 中可选插件的**领域接口、配置、依赖与扩展方式**。它面向插件开发者、集成开发者和维护者；内核 SDK、插件打包、隔离、权限、Agent Surface 与 MCP 的通用约束由[内核开发者 Wiki](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction)维护。

## 先选对入口

| 目标 | 应阅读 |
| --- | --- |
| 编写新的 StackPanel 插件 | [插件设计与集成](Design-and-Integration) 与内核 [Plugin Introduction](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction) |
| 调用插件 HTTP 接口 | 对应插件页面的“路由”章节；所有路径均是插件内部路由，宿主会按插件路由规则分发 |
| 把插件能力交给 Open Platform、MCP 或 Agent | [插件设计与集成](Design-and-Integration#capabilityopen-platformmcpagent)；仅文档中列出的 Capability 会投影 |
| 接入支付、通知、登录、上游商品或履约 | `epay`、`smtp`、`wecom-mail`、`wowid`、`zjmf-upstream` 页面 |
| 在本地调试这些插件 | [仓库 README](https://github.com/worable233/stackpanel-plugins#参与开发) |

## 插件目录

| 领域 | 插件 | 文档 |
| --- | --- | --- |
| 商店 | `catalog` | [商品分类](Commerce-Catalog) |
| 发票 | `invoice` | [发票](Finance-Invoice) |
| 支付 | `epay` | [易支付](Finance-EPay) |
| 内容 | `cms` | [CMS](Content-CMS) |
| 内容 | `notice` | [站点公告](Content-Notice) |
| 支持 | `ticket` | [工单](Operations-Ticket) |
| 推广 | `referral` | [推广](Growth-Referral) |
| 通知 | `smtp` | [SMTP 邮件通道](Notifications-SMTP) |
| 通知 | `wecom-mail` | [企业微信邮箱](Notifications-WeCom-Mail) |
| 身份 | `wowid` | [WowID 登录](Identity-WowID) |
| AI | `llm-gateway` | [模型服务](AI-LLM-Gateway) |
| 兼容 | `zjmf-compat` | [智简魔方兼容](Integration-ZJMF-Compat) |
| 上游和履约 | `zjmf-upstream` | [智简魔方上游](Integration-ZJMF-Upstream) |
| 示例 | `hello`、`minimal`、`template` | [示例与模板](Examples-and-Template) |

## 版本与事实来源

页面的插件版本、路由、权限和 Capability 均按仓库 `main` 分支的 `packages/plugins/<id>/src/index.ts` 核验。每次修改插件 manifest、路由、扩展点或公开业务契约时，必须同一提交更新本 Wiki 页面；仅改前端页面而未改变接口时不必重写接口表。

## 安全基线

插件是服务器端可执行代码。安装前应确认发布者、内核兼容版本、所需权限和外部凭据边界；所有密钥必须进入 `ctx.secrets` 或内核受管配置，不得出现在浏览器包、日志、事件或接口响应中。对外回调应校验签名和业务状态，对写操作应声明幂等策略。
