# llm-gateway vs new-api（QuantumNous）逐功能对比与后续规划

> 对象：本仓 `packages/plugins/llm-gateway`（v0.1.0）对比 <https://github.com/QuantumNous/new-api>（含 `new-api-plugins`、`relaykit`）。
> 目的：回答三个问题——我们缺什么、哪些不该抄、下一步怎么排期。
> 结论先行，证据在后。所有对方结论均标注来源文件，便于复核。

---

## 0. TL;DR

1. **不是同一层的东西**。new-api 是独立网关平台（自带用户、额度、支付、控制台、渠道管理、插件市场）；我们是 **StackPanel 内核上的一个插件**。用户/登录/支付/订单/通知/权限组在内核里已有实现（或由其他插件承担），这部分**不是缺口，是边界**。
2. **协议面我们领先**：4 协议 × 任意上游互转、31 条 endpoint 注册表（25 supported / 6 明确 unsupported）、`files`/`batches`/`fine-tunes`/`count_tokens` **已实现**——new-api 这几条恰恰是 `RelayNotImplemented` 或注释掉的。
3. **渠道面我们明显落后**：他们 37 个 adaptor + 自定义路由 + 多 Key + OAuth 订阅账号 + 通道测活/查余额 + 参数/头改写 + 状态码映射；我们 13 个 provider、单 Key、无测活/查余额/改写。
4. **计费模型我们更"金融正确"，他们更"运营灵活"**：我们是 `hold → settle → compensation` 台账 + 价格快照 + 幂等；他们是 `ratio / tiered_expr（JS 表达式）` + 分组倍率 + 缓存分档 + 套餐/兑换码/签到/推广。两者应互补：把他们的**定价表达力**接到我们的**结算正确性**上。
5. **最大的真空缺是「商业化 + 异步任务 + 控制台深度」**：套餐/配额包、模型广场/排行榜、用量日志页、视频/音乐任务插件、上游账号 OAuth 接入。
6. **规划**：A（生产可用性补齐，0.2.0）→ B（商业闭环，0.3.0）→ C（渠道与异步任务，0.4.0）→ D（体验/生态，持续）。详见 §5。

规模对照（客观量）：

| 维度 | llm-gateway | new-api |
| --- | --- | --- |
| 后端代码 | 14,380 行 TS（含测试），46 个文件（36 源 + 10 测试） | 2,660 个 blob，Go ~1,300+ 文件 |
| 协议 | OpenAI Chat / Responses / Anthropic / Gemini，IR 互转 | 同四协议（RelayKit，带转换质量分级） |
| Endpoint | 31 条注册表，25 supported | 路由 30+，其中 files/fine-tunes 未实现 |
| 上游 provider | 13（1 个 `openai-compatible` 家族预设） | 37 个 adaptor + AdvancedCustom + Task Plugin |
| 管理端 | 3 个页面（概览 / 账号+定价 / 定价编辑） | 16 个业务模块 + 7 类系统设置、7 种语言 |

---

## 1. 对比口径

对比分三类结论，避免把「分工」误判成「缺陷」：

- **【内核已有】**：StackPanel 内核或其他插件已提供，网关只应调用、不应重造。例：用户与登录、钱包、支付、订单、通知、权限组、插件市场。
- **【插件该补】**：属于网关产品能力，今天没有或很薄。
- **【架构不做】**：对方有、但我们主动不抄（理由写清）。

证据来源：
- 我们：`packages/plugins/llm-gateway/src/**`、`frontend/src/**`、内核 `docs/API-COMPATIBILITY.md`、`docs/TROUBLESHOOTING-llm-gateway.md`。
- 对方：`README.md`、`router/relay-router.go`、`relay/relay_adaptor.go`、`model/channel.go`、`model/token.go`、`model/subscription.go`、`setting/ratio_setting/model_ratio.go`、`setting/billing_setting/tiered_billing.go`、`relay/helper/price.go`、`controller/channel-billing.go`、`model/request_policy.go`、`docs/plugin-api/README.md`、`relaykit/README.md`、`new-api-plugins/README.md`、`web/src/routes/**`。

---

## 2. 逐功能对比

图例：✅ 有且完整　🟡 有但薄/局部　❌ 无　🚫 明确不做（附理由）

### 2.1 协议与端点

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | ✅ | ✅ | 平 |
| OpenAI Responses（含流式） | ✅（`/v1/responses`、`/responses/compact`、WebSocket） | ✅（SSE；无 compact、无 WS） | 我们缺 compaction / WS |
| Anthropic Messages | ✅ | ✅ | 平 |
| `messages/count_tokens` | ❌（路由被注释） | ✅ | **我们领先** |
| Gemini generateContent / stream | ✅（+ `/v1beta/models/*path` 原生透传） | ✅ | 平 |
| Gemini openai 兼容入口 `/v1beta/openai/*` | ✅ | ❌ | 小缺口（客户端兼容性） |
| Embeddings / Rerank / Moderations | ✅ | ✅ | 平 |
| Images generations / edits | ✅（含任务插件承接） | ✅ | 平（他们多了视频/图片任务生态） |
| Images variations | ❌ `RelayNotImplemented` | ❌ 未注册（404） | 平 |
| Audio speech / transcriptions / translations | ✅ | ✅（speech 二进制流式） | 平 |
| Files（list/create/delete） | ❌ 全为 not implemented | ✅ 透传 + 512MiB 上限 | **我们领先** |
| Batches | ❌ 未注册 | ✅ | **我们领先** |
| Fine-tuning jobs | ❌ `RelayNotImplemented` | ✅ | **我们领先** |
| Realtime WebSocket `/v1/realtime` | ✅ | ❌ 明确 501 | 真实缺口，**卡在内核**（SDK 无 upgrade 通道，`packages/sdk/src/plugin.ts` 只有 `handler`/`raw`） |
| Responses WebSocket | ✅ | ❌ 501 | 同上 |
| 未知路径处理 | Gin 404/`RelayNotImplemented` 混用，部分路径静默回落 | ✅ 注册表三态：supported / 501 / 404，且**禁止回落成 Chat** | **我们领先（产品纪律）** |
| Assistants / Threads / Vector Stores / Uploads | ❌ | ❌（显式 501 + 指引） | 平（我们更友好） |
| DeepSeek 独立工具 `/v1/tools/search|fetch`、`/v1/alpha/search` | ✅ | ❌ | 小缺口（可后置） |
| 转换质量分级 + golden 测试 | ✅ RelayKit：四协议两两转换，`good/fair/discouraged` + `Steps` + 诊断 | 🟡 有 IR + codec，无质量分级/诊断报告 | 可借鉴「转换诊断」 |
| 流式工具调用拼接、usage 汇总、终止事件补发 | ✅ `ResponseStreamState` + `FinalizeStreamResponse` | 🟡 codec 内处理，未见统一的「终止补发 + sequence_number」 | 需核对补齐 |

### 2.2 上游渠道 / 账号池

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 内置 provider 数 | 37（ali/baidu/tencent/xunfei/zhipu/zhipu_4v/moonshot/minimax/jimeng/volcengine/cohere/jina/perplexity/dify/cloudflare/replicate/palm/xai/coze/mistral/ollama/vertex/aws/codex/sub2api/newapi/…） | 13（openai/azure/anthropic/gemini/vertex/bedrock/deepseek/mistral/cohere/ollama/openrouter/siliconflow/openai-compatible） | **主要差距（渠道广度）** |
| 自定义上游路由（URL/method/header/auth + 指定协议转换器） | ✅ `advancedcustom` adaptor（`relay/channel/advancedcustom/adaptor.go`） | ❌ 只有预设 provider，新厂商要改代码 | **缺（运营刚需）** |
| 账号多 Key（同账号多把 key、轮询/故障切换、单 key 状态） | ✅ `IsMultiKey`/`MultiKeyMode`/`MultiKeyStatusList`（`model/channel.go`） | ❌ 一个账号一个 secret | **缺（P0，直接影响可用性）** |
| 账号测活（test channel / test model） | ✅ `controller/channel-test.go`、`channel_test_request_test.go` | ❌ 只有转发时失败 | **缺** |
| 上游余额查询 | ✅ 12 家适配（CloseAI/OpenAI-SB/AIProxy/API2GPT/SiliconFlow/DeepSeek/AIGC2D/OpenRouter/Moonshot/Sub2API/NewAPI/AdvancedCustom，`controller/channel-billing.go`） | ❌ | **缺（成本/风控必需）** |
| 上游模型清单同步 | ✅ `controller/model_sync.go`、`missing_models.go` | 🟡 `admin/upstream-models` + `upstream-model-catalog`（手动拉取，不落库） | 薄 |
| 模型映射（对外名 → 上游名） | ✅ `ModelMapping`（支持正则/多级） | ✅ `upstreamModel`（一对一） | 我们缺「一对多/正则/按分组映射」 |
| 状态码映射 | ✅ `StatusCodeMapping` | ❌ | 缺 |
| 参数改写 / 请求头改写 | ✅ `ParamOverride` / `HeaderOverride` | ❌ | 缺 |
| 渠道额外设置（Azure apiVersion、Vertex project 等） | ✅ `Settings` JSON | ✅ `options` JSON | 平 |
| 渠道标签/备注/分组/权重/优先级 | ✅（tag/remark/group/weight/priority） | 🟡（affinity/weight/priority，无 tag/备注） | 薄 |
| 自动禁用/自动启用（按码、按关键词、按失败率阈值） | ✅ `request_policy` + `AutomaticDisableKeywords` + `ChannelDisableThreshold` | 🟡 熔断+冷却（429/408 冷却，5xx 只重试） | 我们缺「按关键词/按状态码自动摘号」 |
| 渠道亲和（affinity，含模板） | ✅ `channel_affinity_setting` + `ChannelAffinity` | ✅ `x-gateway-affinity`（只调序不筛除） | 平，我们少模板 |
| 渠道约束过滤（按路径/task/WS 选择候选） | ✅ `model/channel_constraint.go` | ❌ | 低优先 |
| OAuth/订阅账号接入（Codex、Claude Max 等） | ✅ `service/codex_oauth.go`、`codex_credential_refresh.go` | ❌（无凭据刷新框架） | **不优先**（ToS/合规风险，见 §4） |
| 嵌套网关（把别家网关当上游） | ✅ `sub2api` / `newapi` adaptor | ❌ | 可选 |
| 异步任务渠道（任务插件绑定） | ✅ Task Plugin + `task_plugin_channel_select` | ❌ | 见 2.6 |
| 账号凭据加密存储 | ✅ DB 加密 | ✅ 插件 secrets（`apiKeyRef`） | 平 |

### 2.3 路由、限流与调度

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 优先级 + 权重随机 | ✅ | ✅ | 平 |
| 同协议优先（减少跨协议转换损失） | 🟡（按渠道能力） | ✅ 显式「同协议优先，无则放开转换」 | **我们更细** |
| 亲和命中优先 | ✅ | ✅ | 平 |
| 多级 RPM（key/user/model/provider/全局） | ✅（token/model/全局中间件） | ✅ 四级（key/用户/模型/provider） | 平，甚至更细 |
| 并发上限（key/账号/全局） | ✅（用户额度 + 渠道） | ✅ + 全局 + 租约续期 | **我们领先** |
| 租约续期（长流不丢并发位） | ❌ | ✅ `LeaseKeeper` | **我们领先** |
| 熔断 + 半开探针 + 冷却 | 🟡（自动禁用/自动启用，偏粗） | ✅ 连续失败阈值 + 半开 + 429/408 冷却 | **我们领先** |
| 请求内重试 + 换号 | ✅ `RetryTimes` + 跨渠道重试 | ✅ `retryAttempts` + `account.failover` | 平 |
| 按状态码/关键词重试策略 | ✅ `AutomaticRetryStatusCodes` | 🟡 固定 retryable 判定 | 缺可配置 |
| 跨分组重试（auto group） | ✅ `CrossGroupRetry` | ❌（无分组概念） | 见 2.5 |
| 限流失败策略 | 未显式 | ✅ 显式 fail-open(计数)/fail-close(租约)，写进注释与测试 | **我们领先** |
| 多实例共享计数 | ✅ Redis | ✅ 内核 `StateService`（Redis） | 平 |
| 请求体大小限制 | ✅ `request_body_limit` | ✅ 每 endpoint `bodyLimit` | 平（我们更精确） |
| 模型级限流中间件 | ✅ `middleware/model-rate-limit.go` | ✅ `modelRpm` | 平 |

### 2.4 计费与价格模型

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 计费单位 | `quota`（内部整数）+ 美元展示 | 钱包 minor 单位 + 币种 | 不同体系，取决于内核 |
| 预扣 | ✅ `quota_reserve`（Redis Lua，user+token 双向扣减），`trust_quota_usd` 免预扣 | ✅ `wallet.hold`（进 `held`），可配 hold TTL | 平；我们缺「可信用户免冻结」优化 |
| 结算 | ✅ 差额结算 + 表达式/倍率 | ✅ `settleHold` + 差额退回 | 平 |
| 结算失败补偿 | 🟡 见 `service/tiered_settle.go`（未确认等价补偿队列） | ✅ 状态机 `RESERVED/SETTLED/RELEASED/COMPENSATING/COMPENSATED/FAILED` + 重试 + 上限 + 欠费 | **我们领先** |
| 价格版本快照 | ❌（按当前配置算） | ✅ `priceSnapshot` 写入台账，历史可复算 | **我们领先（资金正确性）** |
| 计费维度 | 输入/输出/缓存读/缓存写(5m/1h/12h)/图片/音频/音频输出，`ratio` 体系 | 输入/输出/缓存读/缓存写/推理/图片/音频 | 平；他们缓存分档更细 |
| 定价方式 | `ratio`（倍率）**或** `tiered_expr`（内置/自定义 **JS 表达式**，可按 token 区间、分辨率、时长计价） | 固定单价（每百万 token / 每张 / 每秒）+ 模型倍率 | **主要差距（定价表达力）** |
| 阶梯计价（tiered） | ✅ `setting/billing_setting/tiered_billing.go` + `billingexpr` | ❌ | 缺 |
| 用户分组倍率 / 组间特殊倍率 | ✅ `group_ratio`、`GetGroupGroupRatio` | ❌（内核有权限组 + 折扣，但网关未使用） | **缺（可低成本接内核权限组）** |
| 免费模型 / 未定价模型 | ✅ 未定价默认报错，可放开 `AcceptUnsetRatioModel` | ✅ 兜底价 `*`，不报错 | 策略不同：我们更宽松（需可配） |
| 套餐/订阅 | ✅ 完整：`SubscriptionPlan`（时长/配额/重置周期/升级降级组/钱包兜底/限购）+ 订单 + 4 家支付 | ❌ | **主要差距** |
| 充值/兑换码/签到/推广 | ✅ topup（epay/stripe/creem/waffo）+ redemption + checkin + aff | 🟡 内核：钱包 + epay 插件 + referral 插件；网关无兑换码/签到 | 【内核已有】不重造 |
| 用量预警/限额 | ✅ 用户额度、令牌额度、通知 | 🟡 key `quotaLimit`，无预警通知 | 缺（轻量） |
| 计费幂等 | ✅（扣减原子） | ✅ `referenceId` 一号贯穿 | 平 |
| 对账/发票导出 | 🟡 `log_export` | ❌ | 缺（B5） |
| 试算 API（前端展示价） | ✅ `pricing` 接口族 | ✅ `/llm-gateway/prices`（只读价目，无按请求试算） | 薄 |

### 2.5 密钥、用户与访问控制

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 密钥实体 | `Token`（独立表，自有额度/分组/IP/模型限制/过期/无限额度） | 内核 `ApiToken` + 插件 `key-policy`（模型白名单/RPM/并发/额度） | **我们更好**：与开放 API 凭证统一，策略层归插件 |
| 密钥额度 | ✅ `RemainQuota` + `UnlimitedQuota` | 🟡 `quotaLimit` + `quotaUsed`（无「无限」显式位，null 即无限） | 薄 |
| 模型白名单 | ✅ | ✅ | 平 |
| IP 白名单 | ✅ `AllowIps` | ✅ 内核 token IP + `ipAllowed`（v4/v6 CIDR） | 平 |
| 过期时间 | ✅ | ✅（内核 token） | 平 |
| 分组 / auto 分组 | ✅ | ❌ | 见 2.4 |
| 用户体系 / 登录 / OAuth / 2FA / Passkey | ✅（GitHub/Discord/OIDC/微信/Telegram、passkey、2FA、会话管理、Turnstile） | 【内核已有】登录插件；**2FA/Passkey 内核暂未发现** | 平台级缺口，不属本插件 |
| 角色与细粒度授权 | ✅ Casbin + authz 服务 + 自定义权限 | ✅ 内核权限 + `llm-gateway.admin/use` + scope（`gateway:read/write`） | 平 |
| 敏感词 / 违规计费 | ✅ `sensitive.go`、`violation_fee.go` | ❌ | 缺（合规向，P2） |
| 审计日志 | ✅ `audit_log` + `controller/audit.go` | 🟡 内核审计（需确认覆盖网关写操作） | 待确认 |

### 2.6 异步任务与多模态生成

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 异步任务框架 | ✅ `model/task.go` + 轮询 + 状态机 + 退款 | ✅ `gateway/task` 模型（记录上游 id/状态） | 我们只有壳，没有执行器 |
| JS 任务插件契约 v1 | ✅ 单文件同步 ESM：`buildSubmitRequest/parseSubmitResponse/parseTaskResult`，宿主管连接/重试/计费，插件只做数据变换；沙箱禁 `fetch`/`eval`/`require` | ❌ | **主要差距** |
| 官方任务插件 | ✅ 11+：sora/veo(google)/kling/jimeng/vidu/hailuo/doubao/alibaba/suno/xai/vertex/incho | ❌ | **主要差距** |
| 任务产物（artifact）与签名 URL | ✅ 长时签名能力 URL + Range 代理 + 防 SSRF | ❌ | 缺 |
| 视频/音乐 OpenAI 兼容任务面 | ✅ `/v1/tasks/*` + `openai_video` 协议投影 | ❌（`gatewayTask` 未接公网路由） | 缺 |
| 插件计费表达式（按分辨率/时长/单位） | ✅ `plugin_billing_expr` + usage schema | ❌ | 缺 |
| 任务插件市场（独立仓 + index.json + sha256 + CI 校验） | ✅ `QuantumNous/new-api-plugins` | 🟡 内核有插件市场，但没有「任务插件」这类轻量扩展点 | 架构可复用，契约缺 |

### 2.7 可观测性与运维

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 请求指标 | ✅ perf metrics（渠道/模型/延迟分位） | ✅ 16 个分钟桶指标（`admin/metrics`） | 平，我们缺直方图/分位 |
| 日志 | ✅ 用量日志（分页/筛选/导出/ClickHouse 可选）+ 审计日志 | 🟡 usage-log 表；管理端无查询页 | **缺页面** |
| 排行/统计 | ✅ `rankings`、`usedata` | 🟡 概览 top10 模型 | 薄 |
| 成本与毛利 | ✅ 渠道余额 + 消耗 | ❌ 只有售价与营收 | 缺（P0 商业必需） |
| 告警/通知 | ✅ 邮件/Telegram/Discord/Webhook + 渠道自动测活 | 🟡 注册通知类型；无阈值告警 | 薄 |
| 健康检查 / 部署自检 | ✅ `perf_metrics`/`uptime_kuma`/`deployment` | 🟡 内核运行手册 | 不属插件 |
| 系统定时任务 | ✅ `system_task`（额度重置、渠道自动更新等） | 🟡 补偿队列需手动/外部触发 | **缺调度**（可用内核 cron/event） |
| 排障文档 | 🟡 分散在 docs + 调试日志 | ✅ `docs/TROUBLESHOOTING-llm-gateway.md`（错误码→处置） | **我们领先** |

### 2.8 控制台与终端用户体验

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 管理后台模块 | 21 个：Dashboard/渠道/模型/定价/用量日志/审计/用户/兑换码/订阅/钱包/任务插件/系统设置（站点/内容/认证/计费/模型/运维/请求策略/安全）/系统信息 | 3 个：概览、上游账号、定价 | **主要差距** |
| 用户侧 | 密钥/额度/订阅/充值/邀请/签到/用量/个人资料/安全 | 概览、模型定价、API 密钥 + 账户 widget | 中 |
| 模型广场 / 价格页 / 详情 / 排行榜 | ✅ `/pricing`、`/pricing/:modelId`、`/rankings` | 🟡 账户内价格列表（不公开、无详情/排行） | 缺（增长向） |
| Playground（站内试用） | ✅ `/playground`、`/pg/chat/completions` | ❌ | 缺（P2） |
| 渠道编辑体验 | ✅ 多 Key、测活、查余额、映射、改写、状态码、约束 | 🟡 名称/URL/provider/模型/优先级/权重/并发/状态 | 薄 |
| 用量图表 | ✅ 多维 | ✅ 按小时/日 + 按模型 | 平 |
| 国际化 | 7 语言（en/zh-CN/zh-TW/fr/ja/ru/vi） | 4（zh-CN/zh-TW/zh-HK/en-US） | 差 3 种 |
| 主题/深色/响应式 | ✅ | ✅（内核 UI + 插件前端） | 平 |
| 客户端接入文档（base_url/key 指引） | ✅ | 🟡 有 API 兼容矩阵，缺「快速接入」页 | 薄 |

### 2.9 扩展生态

| 能力 | new-api | 我们 | 结论 |
| --- | --- | --- | --- |
| 插件市场 | ✅ 官方市场 + 任务插件独立仓 + 版本不可变 + sha256 | ✅ 内核插件市场（整插件级） | 层次不同：我们是「装一个插件」，他们是「装一个能力」 |
| 轻量扩展点（不改宿主、不发版本） | ✅ JS 任务插件 + billing expr + advanced custom | ❌（改 provider 要发插件版本） | **值得借鉴：任务/计费表达式应由数据驱动** |
| RelayKit 可嵌入 | ✅ 独立 Go module，可被别的网关复用 | 🟡 codec 在插件内，未抽公共包 | 可选：抽 `@stackpanel/llm-protocol` 共享包 |
| Agent/MCP 面 | 🟡 无（有 OpenAPI 文档） | ✅ 9 个 Capability + `/api/v1` alias + MCP 工具面 + agent-provider | **我们领先** |

---

## 3. 我们到底缺什么

按「是否阻断业务」排序。ID 用于 §5 排期映射。

### P0 —— 会直接卡住生产运营

| ID | 缺口 | 为什么是 P0 | 我们的现状 |
| --- | --- | --- | --- |
| G1 | **上游账号多 Key + 轮询/故障切换** | 单 Key 账号是单点；上游封 key/限流时整号下线 | 一账号一 secret（`gateway.account.apiKeyRef`） |
| G2 | **上游余额/额度查询 + 账号测活** | 不知道上游快没钱、不知道 key 是否还有效，只能等用户报错 | 无（失败才发现） |
| G3 | **成本与毛利** | 卖了多少钱≠赚了多少钱；无成本价无法定价 | 只有售价（`model-price`），无 `costPrice`，无上游消耗 |
| G4 | **定价表达力：阶梯/按量单位** | 视频按时长、图片按分辨率、长上下文阶梯价，固定单价表达不了 | 固定单价 + 全局倍率 |
| G5 | **用户分组定价（接内核权限组折扣）** | 会员/企业客户折扣是基本商业能力；内核已有权限组 + 折扣，我们没用 | 只有 per-model `multiplier` |
| G6 | **管理端用量日志页 + 导出** | 出事无法自查（谁、哪个 key、哪个账号、多少 token、为什么 502） | 只有概览 Top10 + `/usage` API（无页面/无筛选/无导出） |
| G7 | **结算补偿的自动调度** | 现在要人工点 `/admin/compensations/run`，漏跑=坏账 | 有队列与幂等，无内建定时 |

### P1 —— 竞争力/体验明显落后

| ID | 缺口 | 说明 |
| --- | --- | --- |
| G8 | 自定义上游路由（URL/method/header/auth + 转换器） | 长尾厂商接入不必发版；对齐 `advancedcustom` |
| G9 | 参数/请求头改写 + 状态码映射 | 运维刚需（改 temperature 上限、去掉不支持的字段、把 400 归一） |
| G10 | 按状态码/关键词自动摘号 + 自动恢复 | 现在只有熔断/冷却；关键词命中（如「余额不足」）应直接摘号 |
| G11 | 渠道测活定时任务 + 模型清单落库 | 对齐 `model_sync` / `missing_models` |
| G12 | 套餐/配额包（订阅） | 对齐 `SubscriptionPlan`（周期/配额/重置/升降级/钱包兜底） |
| G13 | 异步任务平台 + 任务插件契约 | 视频/音乐是现在最赚钱的长尾；壳已就绪（`gateway/task`） |
| G14 | 用量预警与限额通知（软/硬限） | 对齐用户额度 + 通知 |
| G15 | 模型映射升级（一对多/正则/按分组） | 现在一对一 `upstreamModel` |
| G16 | 公开模型广场 / 价格详情 / 排行榜 | 增长与转化向 |
| G17 | 计费正确性加固：客户端中断仍按上游实际用量结算 | 见 §3.1 |
| G18 | Realtime / Responses WebSocket | 需内核 upgrade 通道（跨仓） |

### P2 —— 生态与打磨

| ID | 缺口 |
| --- | --- |
| G19 | Playground（站内试用） |
| G20 | 审计日志覆盖网关写操作 + 敏感词/违规计费 |
| G21 | i18n 扩到 7 语言；插件 README/wiki |
| G22 | 转换诊断（类 RelayKit `Quality`/`Steps`）与 golden 测试扩展 |
| G23 | 指标升级：分位延迟、按账号/模型直方图、OpenMetrics 导出 |
| G24 | 协议公共包抽离（`@stackpanel/llm-protocol`）供其他插件/Agent 复用 |
| G25 | Responses compaction、DeepSeek tools / alpha search 等新面 |

### 3.1 代码层观察（读完源码后值得单独立项的加固点）

1. **客户端中断的计费盲区**：`gateway.ts` 流式分支 `reply.onClientClose(() => reader.cancel())` 会提前结束读取，随后 `resolveUsage()` 用已收到的文本估算 —— 上游实际已生成的 token 可能更多，**倾向少收**。建议：中断时按「最后已知 usage + 已完成部分」并标记 `estimated/aborted`，或在上游 usage 事件到达即持久化。
2. **估算器偏粗**：`estimateFrom()` 对流式用 `stripSse()` 后的原文估算，SSE 结构残留会抬高 completion 估算；prompt 用整段请求体（含 JSON 键名）。
3. **预留口径**：`DEFAULT_RESERVE_MAX_TOKENS = 4096`，客户端不给 `max_tokens` 时对长输出模型会低估 → 结算可能超过冻结额，退化为「先跑后欠」。建议按模型 `maxOutputTokens` 元数据定预留上限。
4. **误配置暴露**：`provider` 非法值 502（好），但 `models` 为空 = 不限（便于运维，也容易放大误配）——建议账号编辑页给出显式「不限」勾选。
5. **无请求级幂等/去重**（合理，非幂等接口），但**重试预算**是全局 `retryAttempts`，缺少「按错误类别的重试预算」与「跨账号预算」。
6. **无 `trust` 免冻结**：new-api 对高信任用户跳过预扣以省一次 Redis/DB 往返（`trust_quota_usd`）。我们可加「余额 > 阈值时跳过 hold」开关，降低高频小请求成本。

---

## 4. 已有优势（别在重构中丢掉）

1. **协议严谨性**：`endpoints.ts` 三态注册表 + 文档矩阵由代码导出并由测试断言（防漂移），未知路径**绝不**回落成 Chat。这是对客户端最友好的行为，new-api 反而用 `RelayNotImplemented`/静默回落混着。
2. **结算账本**：`hold → settle → compensation` + `priceSnapshot` + `referenceId` 幂等 + 欠费终态。资金正确性明显强于对手的「按当前配置扣 quota」。
3. **并发与限流的工程纪律**：租约续期、fail-open/fail-close 显式选择、多级 RPM、慢客户端背压（`BackpressureWriter`）。
4. **凭证统一**：网关 key 即内核 `ApiToken`，与 Open Platform API 同一把钥匙、同一套 scope/IP 白名单/过期——对手是自成一套 `Token` 表。
5. **Agent/MCP 面**：9 个 Capability + 别名 + 幂等键 + MCP 写权限，这是对手完全没有的。
6. **扩展面覆盖**：files/batches/fine-tunes/count_tokens 已经跑通，别因为「对手没做」就删。
7. **排障契约**：稳定错误码 + 错误码→处置表（`TROUBLESHOOTING-llm-gateway.md`）。

---

## 5. 后续开发规划

原则：
- **优先补「阻断运营」的**（P0），再补「能卖钱」的（P1），最后补「好看」的（P2）。
- **能在内核解决的不要写进插件**；**能用数据驱动的不要写进代码**（借对手的 `advancedcustom` / `billing_expr` 思路）。
- 每阶段都必须有：数据迁移说明、错误码、指标、测试、文档（Wiki + API 矩阵）。本仓的「文档与注册表由测试同步」纪律继续沿用。

### 阶段 A —— v0.2.0「可运营」（建议 3 周）

主题：让一个人能 7×24 值守这个网关。

| 任务 | 覆盖 | 交付物 | 验收 |
| --- | --- | --- | --- |
| A1 账号多 Key | G1 | `gateway.account.keys[]`（各 key 独立状态/冷却/用量），选号时在 key 维度再做一次加权与冷却 | 单 key 429 时同账号自动切 key；key 全灭才降级账号 |
| A2 测活 + 余额 | G2、G11 | `POST /admin/accounts/:id/test`（探活/探模型）、`GET /admin/accounts/:id/balance`（按 provider 适配 5 家起步：OpenAI 兼容、Anthropic、Gemini、DeepSeek、OpenRouter）；余额快照落 `gateway.account-balance` | 测活返回延迟与首 token；余额定时刷新并在概览告警 |
| A3 成本与毛利 | G3 | `model-price.costInput/costOutput/costImage/costAudio`（可空=未知）；usage-log 增加 `costAmount`；概览增加「营收/成本/毛利」 | 历史账单可按价快照复算毛利 |
| A4 定价表达力 | G4、G5 | ①阶梯价（`tiers: [{from, to, inputPrice, outputPrice}]`）②按量单位（张/秒/百万像素）③`discountSource: permissionGroups` 读内核权限组折扣 | 单测覆盖边界；试算 API 返回明细 |
| A5 用量日志页 | G6 | 管理端「用量」页：时间/key/账号/模型/状态码/错误码筛选、分页、CSV 导出 | 10 万行导出 < 10s（流式） |
| A6 补偿调度 | G7 | 内建定时（内核 cron/event，间隔可配）+ `compensations.pending` 指标告警 | 进程重启后自动续跑；幂等重放不二次扣 |
| A7 自动摘号 | G10 | 按状态码区间 + 关键词（如余额不足/封禁）→ 账号冷却或禁用；自动恢复需人工或半开 | 命中关键词立即摘号并在概览可见 |
| A8 计费加固 | G17 | 中断结算按上游 usage 优先、缺则保守估算；预留上限按模型元数据 | 中断场景单测：账单不低于上游已知 usage |

### 阶段 B —— v0.3.0「能卖」（建议 4 周）

| 任务 | 覆盖 | 说明 |
| --- | --- | --- |
| B1 配额包/套餐 | G12 | 与内核 `store-product-membership` 对齐：套餐=有效期 + 配额 + 限额；网关侧优先抵扣套餐额度，再走钱包；到期回收、超额行为可配 |
| B2 计费模式抽象 | G4 | 抽 `PricingStrategy`：`flat`（现有）/`tiered`/`expr`（受限表达式，禁任意代码）。价格快照存「策略 + 参数 + 结果」 |
| B3 预警与限额 | G14 | 额度阈值通知（复用内核通知类型）、软限（只告警）/硬限（402） |
| B4 模型映射升级 | G15 | 一对多（按 key 分组）、正则、按分组映射；映射结果进 usage-log |
| B5 对账单 | G6 | 按用户/月导出账单（含价快照与用量明细） |
| B6 公开价格页 | G16 | `auth: 'optional'` 路由 + 匿名价目（登录后应用权限组折扣），模型详情/能力/限流说明 |

### 阶段 C —— v0.4.0「扩面」（建议 6 周，视内核支持）

| 任务 | 覆盖 | 依赖/风险 |
| --- | --- | --- |
| C1 异步任务框架 | G13 | 先做 **执行器**（本地任务表 + 轮询 + 结算/退款），再抽 **任务描述契约**（数据驱动，不做 JS 沙箱；Sandbox 交给内核插件沙箱）。首批：OpenAI 图像任务、可灵、即梦、Veo |
| C2 产物与签名 URL | G13 | 复用内核存储插件（`storage`）签发短时 URL；禁止把上游 token 拼进 URL |
| C3 自定义上游路由 | G8 | `provider: 'custom'` + `route {urlTemplate, method, headers, authType, converter}`；配 SSRF 校验（`@stackpanel/net-guard`） |
| C4 参数/头改写 + 状态码映射 | G9 | JSONPath/白名单式改写；**默认关闭**，改动进审计日志 |
| C5 更多 provider | 渠道广度 | 优先 OpenAI 兼容预设（Volcengine/DashScope/Zhipu/Moonshot/MiniMax/Xunfei/Cloudflare/302.AI）；有真实差异的再写 adaptor |
| C6 Realtime/WS | G18 | **需内核** `PluginRoute` 增加 upgrade 通道；先立内核 RFC，再做客户端 |
| C7 Responses 增强 | G25 | compaction、web search 工具编码、`sequence_number` |

### 阶段 D —— 持续

D1 Playground（G19）｜D2 审计 + 敏感词（G20）｜D3 i18n 7 语言 + Wiki/README（G21）｜D4 转换诊断与 golden 扩展（G22）｜D5 指标升级（G23）｜D6 协议包抽离（G24）

### 明确不做（🚫）

| 不抄 | 理由 |
| --- | --- |
| 用户注册/登录/OAuth/2FA/Passkey/会话管理 | 内核身份域能力；网关只消费 `ApiToken` 与权限 |
| 支付渠道、充值、订单、发票 | 内核 `store-wallet` + `epay` 等插件；网关只做「扣款」语义 |
| 兑换码/签到/推广 | 内核 `referral` 等插件；避免同一笔钱两条账 |
| 自成一套用户/令牌表 | 会破坏 Open API 凭证一致性（我们的核心优势） |
| OAuth 订阅账号（Codex/Claude Max）接入 | 合规与上游 ToS 风险高；若要做，先出法务/风控评审 |
| 无沙箱的 JS 执行（对手的 task plugin runtime） | 内核插件隔离已覆盖；不要在网关里再造一个高危执行面 |
| 把 `files`/`batches`/`fine-tunes` 下线去对齐对手 | 我们是透传，成本低、差异优势 |

---

## 6. 建议的最小下一步（本周就能开）

1. **A1 多 Key** + **A2 测活/余额**：这两项直接决定「半夜要不要人爬起来」。
2. **A3 成本字段**：先加 schema（`costInput/costOutput` 可空）与 usage-log `costAmount`，页面后置——schema 越晚加，历史数据越难补。
3. **A5 用量日志页**：管理端目前只有概览，值班时无法定位单个 502。
4. **A8 计费加固**：中断结算 + 预留上限，两个小改动，影响真金白银。
5. 立一份内核 RFC：`PluginRoute` upgrade 通道（为 C6 铺路，不阻塞其他任务）。

---

## 附录 A：关键证据索引

**我们**
- 端点多态与纪律：`src/endpoints.ts`、`docs/API-COMPATIBILITY.md`（内核仓）
- 结算生命周期：`src/billing.ts`（11 步 + 幂等 + 快照）、`src/data.ts`（`gatewayBillingEntryModel`）
- 调度：`src/scheduler.ts`（RPM/并发/熔断/租约续期）、`src/routing.ts`（亲和/同协议/优先级/加权）
- 鉴权：`src/auth.ts`、`src/keys.ts`、`src/data.ts`（`gatewayKeyPolicyModel`）
- 管理端：`src/index.ts`（路由清单）、`frontend/src/admin.tsx`（3 个页面）
- 指标：`src/observability.ts`（16 个 MetricName）

**new-api**
- 协议路由与未实现清单：`router/relay-router.go`
- provider 清单：`relay/relay_adaptor.go`（37 个 case）
- 渠道模型：`model/channel.go`（多 Key、模型映射、状态码映射、改写、分组、权重、优先级）
- 令牌/用户：`model/token.go`、`model/user.go`
- 计费：`relay/helper/price.go`、`setting/ratio_setting/model_ratio.go`、`setting/billing_setting/tiered_billing.go`、`model/quota_reserve.go`、`setting/operation_setting/quota_setting.go`
- 订阅：`model/subscription.go`
- 运维策略：`model/request_policy.go`、`model/channel_constraint.go`、`controller/channel-billing.go`
- 任务插件：`docs/plugin-api/README.md`、`new-api-plugins/README.md`、`plugins/tasks/**`
- 协议转换：`relaykit/README.md`（质量分级/诊断/流式状态）
- 控制台路由：`web/src/routes/**`（16 个业务模块 + 7 类系统设置）

## 附录 B：口径提醒

- new-api 的「37 个 provider」里有一部分是同一协议家族的特化（如 `zhipu` vs `zhipu_4v`），数量不等于能力差异；我们 13 个里 `openai-compatible` 是家族总括（新增厂商 ~20 行）。
- 对方月度活跃、版本号与功能可能继续变化；本文以 main 分支 2026-10 快照为准，落地前复核。
- 计费金额一律以「我们自己的价快照 + 用量事实」为准，不参考对方口径换算。
