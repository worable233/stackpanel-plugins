# 更新日志

本文件记录 StackPanel 插件集的公开变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
各插件版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；
插件版本以各插件 `src/index.ts` 中 manifest 的 `version` 为准。

## [Unreleased]

暂无。

## [2026-10-13]

### 新增

- 仓库建立，从 StackPanel 内核仓库迁出 13 个非运行时插件，同时带上共享的
  `tsconfig.base.json`、`scripts/build-plugin.mjs` 与内核侧集成测试。

初始插件与版本：

| 插件           | 版本  | 说明                                       |
| -------------- | ----- | ------------------------------------------ |
| `catalog`      | 0.4.0 | 商品分类树与上架状态管理                   |
| `cms`          | 0.3.0 | 文章/页面的草稿、版本、定时发布与 SEO 输出 |
| `epay`         | 0.3.1 | 易支付网关（支付宝 / 微信 / QQ 钱包）      |
| `hello`        | 0.1.0 | 示例插件                                   |
| `invoice`      | 0.1.0 | 发票开具与打印                             |
| `llm-gateway`  | 0.1.0 | 上游模型账号池中转与按量计费               |
| `minimal`      | 1.0.0 | 最小示例插件                               |
| `notice`       | 0.2.0 | 站点公告                                   |
| `template`     | 0.1.0 | 新插件脚手架模板                           |
| `ticket`       | 0.2.0 | 用户工单与后台处理                         |
| `wowid`        | 0.1.0 | WowID OpenID Connect 登录                  |
| `zjmf-compat`  | 0.1.0 | 智简魔方旧客户端协议兼容                   |
| `zjmf-upstream`| 0.3.0 | 魔方上游商品同步与履约                     |
