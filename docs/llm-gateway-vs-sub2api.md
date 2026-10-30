# llm-gateway vs sub2api（Wei-Shaw）逐功能对比

> 姊妹文档：[`llm-gateway-vs-new-api.md`](./llm-gateway-vs-new-api.md)（对标 QuantumNous/new-api）。
> 两份文档的对象不同，**结论不可互相套用**。

对比时间：基于 `Wei-Shaw/sub2api` `main` 分支仓库树与源码（CDN 直取，非 README 转述）。
仓库规模快照：**4,471 个文件 / 3,040 个 Go 文件 / 1,611 个 `_test.go` / 42 张 ent 表 / 299 个 SQL 迁移 / 319 个 `.vue`**。

---

## 0. TL;DR

**先说结论：我们的网关与 sub2api 不是同一层产品，整体「对标并超越」不成立。**

| 维度 | sub2api | llm-gateway | 判定 |
| --- | --- | --- | --- |
| 定位 | 订阅额度分发（把 Claude Code / Codex / Grok 这类**订阅账号**的额度分给多用户） | 标准 API Key 中转计费网关 | 不同层 |
| 后端规模 | 3,040 Go 文件 / 596 个 service 模块 | 66 TS 文件 / 20,426 行 | 差一个量级 |
| 测试文件 | 1,611 | 23（324 用例） | 差两个量级 |
| 数据模型 | 42 张表 / 299 迁移 | 内核 Extension 引擎代管，无自有迁移 | 架构不同 |
| 真实上游 e2e | 有（`api_contract_test.go`、`gateway_test.go` 等） | **零** | 我们缺 |
| 管理端 API | 307 条路由 | 40 条 | 差一个量级 |

**三条结论分开看：**

1. **该补的真缺口**：TPM 限流、粘性会话、用户/分组级配额、上游出口代理池、内容审核、健康巡检与自动降级、告警通知、凭证刷新。这些在「API Key 中转」这个定位里也是真实需求，不是它特有的。
2. **不必追的差异**：OAuth 订阅账号池、客户端指纹伪装、WS 会话抢占、内置支付/兑换/推广、邮件系统、订阅套餐、插件运行时。这些是「订阅额度分发」这个定位逼出来的，我们没有那个业务就没有那个复杂度，硬追是负资产。
3. **我们真正领先的**：资金闭环（预留→结算→补偿 + 价格快照 + 幂等）、显式 endpoint registry（未知端点 501 而非静默透传）、协议 IR 归一化与七语言、权益接内核 commerce。这些在它的实现里是弱点或不存在。

**关于「测试完善」：不能这么讲。** 1,611 : 23 的测试文件差距之外，我们**从未跑过任何一次真实上游端到端调用**——没有真实凭据，没有管理员会话，Playground 只做到编译通过。这一条在下面的 §5 单独交代。

---

## 1. 对比口径与定位差异

sub2api 的自我定位（README 原文）：

> **AI API Gateway Platform for Subscription Quota Distribution**
> Sub2API 是一个 AI API 网关平台，用于分发和管理 AI 产品订阅的 API 配额。

这句话决定了它的全部复杂度投向：

- **账号侧**：不是「一把 API Key」，而是 OAuth 订阅账号（Claude Code、Codex、Gemini CLI、Grok、Antigravity、Ollama Cloud…），每个 provider 一套 `*_oauth_service.go` / `*_token_refresher.go` / `*_quota_fetcher.go`。
- **客户端侧**：要冒充官方 CLI 才能用订阅额度，于是有 `openai_codex_fingerprint.go`、`claude_code_version_sync_service.go`、`tls_fingerprint_profile_service.go`、`openai_ws_session_preemption.go`。
- **额度侧**：订阅有窗口（5 小时 / 周 / 日），于是有 `session_window_start/end/status`、`claude_reset_credits.go`、`openai_quota_auto_reset.go`。

我们做的是**用真金白银买的 API Key 做中转计费**：没有「订阅窗口」概念，但有「用户钱包不能被透支」的强约束。所以我们的复杂度投向 hold/settle/补偿、价格快照、幂等台账。

**这决定了对比的正确读法**：下面每一节里，标 🚫 的是「定位差异，不该追」，标 ❌ 的是「同一定位下的真缺口」。

---

## 2. 逐功能对比

### 2.1 协议与端点

它的 gateway 路由（`server/routes/gateway.go`，约 60 条）：

```
POST /chat/completions   /responses   /responses/*subpath   /messages   /messages/count_tokens
POST /embeddings   /images/generations   /images/edits   /images/generations/async   /images/edits/async
POST /images/batches  GET /images/batches(/:id)  GET /images/batches/:id/{download,items}
POST /videos   /videos/edits   /videos/extensions   /videos/generations
GET  /videos/:request_id(+/content)  /videos/edits/:id(+/content)  /videos/extensions/:id(+/content)
POST /tts   /stt   /custom-voices   GET|PATCH|DELETE /custom-voices/:voice_id(+/audio)
POST /cachedContents   GET|PATCH|DELETE /cachedContents/:cacheID
GET  /realtime   POST /realtime/calls   GET|POST /live(/:call_id)
POST /alpha/search   /x_search   /web_search   /systemone
GET  /models(/:model)   POST /models/*modelAction
GET  /sub2api/billing   /usage
```

我们的 endpoint registry（`src/endpoints.ts`，30 条，未命中一律 501）：

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| OpenAI Chat / Responses | ✅ | ✅（C7 走协议透传） | 平 |
| Anthropic Messages + count_tokens | ✅ | ✅ | 平 |
| Gemini 原生 `v1beta/models/*` | ✅ | ✅ | 平 |
| Gemini OpenAI 兼容入口 | ✅ | ✅（`v1beta/openai/*` 归一化） | 平 |
| Embeddings / Rerank | ✅ / — | ✅ / ✅ | 我们多 rerank |
| Images 生成/编辑 | ✅ | ✅ | 平 |
| Images **异步批任务** | ✅ `batch_image_*` 14 个模块 | ❌ | **缺口**（我们只同步） |
| TTS / STT / 自定义音色 | ✅ | ✅ 端点存在（透传） | 我们无音色管理 |
| Videos（生成/编辑/扩展/内容） | ✅ 全套 | 🟡 `/v1/videos` 生成+查询+内容+取消，无 edits/extensions | 部分 |
| Cached contents（显式缓存对象） | ✅ | ❌ | 缺口（我们只有 `promptCache` 隐式统计） |
| Realtime WebSocket | ✅ `openai_ws_*` 12 个模块 | ❌ 显式 501 | **缺口**（C6，卡内核 upgrade 通道） |
| Live API（双向音视频） | ✅ | ❌ | 缺口 |
| `alpha/search`、`x_search`、`web_search`、`systemone` | ✅ | ❌ | 缺口（特定 provider 私有面） |
| Files / Batches / Fine-tunes | — | ✅ | **我们多** |
| 未知端点行为 | 未命中走 404 | **显式 501 + 说明** | **我们领先** |

**判定**：协议广度它更宽（多出实时、异步批图、缓存对象、搜索面），但我们的**端点纪律**更好——它把不认识的路径交给 Gin 默认 404，我们有一张显式表把「打错路径」（404）与「平台没实现」（501）分开，这对客户端排障是实质差别。

### 2.2 上游账号与凭证

`backend/ent/schema/account.go` 共 **28 个字段**，其中与调度/凭证相关的：

```
platform  type  proxy_id  proxy_fallback_origin_id  parent_account_id  status  schedulable
concurrency  priority  rate_multiplier  quota_dimension(global|spark)
rate_limited_at  rate_limit_reset_at
session_window_start  session_window_end  session_window_status
auto_pause_on_expired  temp_unschedulable_reason  error_message
```

凭证形态（从 service 目录推断，均有对应文件）：OAuth（`*_oauth_service.go` × 8）、API Key（`anthropic_apikey_auth.go`、`openai_apikey_health_breaker.go`）、Cookie / Setup Token（`cookie-auth`、`setup-token-cookie-auth` 路由）、Codex PAT（`create-from-codex-pat`）、Vertex 服务账号（`vertex_service_account.go`）、AWS SigV4（`bedrock_signer.go`）。

我们的 `gatewayAccountModel` 共 **18 个字段**：

```
name provider baseUrl apiKeyRef models status priority weight maxConcurrency
options rewrites rpmLimit enabled affinity lastUsedAt
keys balance balanceCurrency balanceUpdatedAt lastError lastErrorAt
```

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| 多协议 adaptor | ✅ | ✅ 23 个 provider id | 平 |
| 一个账号多把 Key（故障转移） | ✅ `parent_account_id` | ✅ `keys[]` + key 级冷却哨兵 | 平（我们语义更明确） |
| OAuth 凭证 + 自动刷新 | ✅ 每 provider 一套 | ❌ | **缺口** |
| Cookie / Setup Token / PAT | ✅ | ❌ | 🚫 定位差异 |
| Bedrock SigV4 | ✅ | ✅ `adaptors/aws.ts` | 平 |
| Vertex 服务账号 | ✅ | ✅ | 平 |
| 上游**出口**代理池 | ✅ `proxy.go` / `proxy_fallback.go` / `proxy_latency_cache.go` | ❌ | **缺口** |
| 账号余额查询 | ✅ `/accounts/:id/balance` `/quota` | ✅ balance + `balance-refresh` job | 平 |
| 凭证脱敏展示 | ✅ `account_credentials_redact.go` | ✅ 只存 `apiKeyRef`，明文只写一次 | 平 |
| 账号到期自动暂停 | ✅ `auto_pause_on_expired` | ❌ | 小缺口 |

**判定**：凭证形态的差距本质是定位差异（我们没有订阅账号可接）。**出口代理池是同一个定位下我们也需要的**——没有它，被上游按 IP 限流时只能换 Key，换不了出口。

### 2.3 调度、限流与并发

它在这一块的代码量：`ratelimit_service.go` **111 KB / 40+ 函数**、`openai_account_scheduler.go` **112 KB**、`concurrency_service.go` 25 KB。

关键函数（`ratelimit_service.go`）：`HandleUpstreamError`、`CheckErrorPolicy`、`PreCheckUsage`、`PreCheckUsageBatch`、`handle429`（含 `calculateOpenAI429ResetTime` 解析 `x-ratelimit-reset-*`、`selectAnthropicExhaustedWindow` 选窗口）、`apply429FallbackRateLimit`、`applyAccountSchedulingThreshold`、`GeminiCooldown`、`handle403` / `handleOpenAI403` / `handleAntigravity403`（403 分类处理）、`isCloudflareBotBlockResponse`。

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| 优先级 + 加权 | ✅ `priority`（小者优先） | ✅ `priority` + `weight` 加权随机 | 平 |
| 账号级并发上限 | ✅ `concurrency` | ✅ `maxConcurrency` + Redis 租约 | 平 |
| **用户/Key 级并发上限** | ✅ `user_concurrency` 路由 | ✅ key `concurrencyLimit` | 平 |
| RPM 限制 | ✅ 多层（user / group / model / key） | ✅ key `rpmLimit` + `modelRpm` | 平 |
| **TPM（Token 速率）限制** | ✅ `model_rate_limit.go`（19 函数，含快照 COW 测试） | ❌ **grep `tpm` 零命中** | **缺口** |
| 模型白名单 | ✅ `group_model_allowlist.go` + `/model-allowlist-candidates` | 🟡 key `models[]` + account `models[]`（取交集） | 我们无分组维度 |
| **粘性会话** | ✅ `session_binding.go`、`openai_sticky_compat.go`、`openai_guardian_affinity.go`、`session_id.go` + 请求头 `session_id`（Nginx 需 `underscores_in_headers on`） | ❌ **grep `sticky` 零命中** | **缺口** |
| 429 退避与恢复时间解析 | ✅ `calculateOpenAI429ResetTime` 解析 Codex 5h/7d 窗口（`ParseCodexRateLimitHeaders`）、`selectAnthropicExhaustedWindow` 解析 Anthropic 5h/7d 重置头；未耗尽时**刻意回到**可配置兜底冷却（源码有注释说明理由） | 🟡 固定冷却 `autoDisableCooldownMs` | 我们较粗 |
| 临时不可调度 / 手动摘除 | ✅ `temp-unschedulable` | 🟡 `status` 启停 | 部分 |
| 账号健康巡检 | ✅ `channel_monitor_*` 14 个模块 + `scheduled_test_*` | 🟡 `probe.ts` + 手动 `/test` | 部分 |
| 影子流量 / 灰度 | ✅ `shadow_routing.go`、`/shadow` | ❌ | 缺口（小） |
| 亲和标签（按渠道钉流量） | — | ✅ `x-gateway-affinity` | **我们多** |

**判定**：这一节是差距最实的一节。**TPM 与粘性会话是两个真缺口**：粘性会话对 Claude Code / Codex 这类长会话客户端是刚需（同一会话要落同一账号，否则 prompt cache 全失效、成本翻倍），TPM 对防止单用户用短请求打满账号配额是刚需。它的 429 处理按上游响应头算恢复时间，比我们的固定冷却精确。

### 2.4 计费与资金

它的 `usage_log` 表 **41 个字段**：

```
user_id api_key_id account_id request_id model requested_model upstream_model upstream_response_model
upstream_model_mismatch channel_id model_mapping_chain billing_tier billing_mode group_id subscription_id
input_tokens output_tokens cache_creation_tokens cache_read_tokens
input_cost output_cost cache_creation_cost cache_read_cost total_cost actual_cost
rate_multiplier long_context_billing_applied account_rate_multiplier billing_type
stream duration_ms first_token_ms user_agent ip_address
image_count image_size image_input_size image_output_size image_size_source
video_count video_resolution video_duration_seconds cache_ttl_overridden created_at
```

我们的 `gatewayUsageLogModel` **32 个字段**：

```
apiKeyId userId accountId model upstreamModel protocol endpoint
promptTokens completionTokens cacheReadTokens cacheWriteTokens reasoningTokens
imageCount audioSeconds totalTokens amount costAmount discountPercent
upstreamKeyId rewrites aborted entitlementId entitlementAmount currency status
estimated priceRef httpStatus latencyMs firstTokenMs clientIp error
```

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| Token 级计费 | ✅ | ✅ | 平 |
| 成本与售价分离 | ✅ `input_cost`/`total_cost`/`actual_cost` + `rate_multiplier` | ✅ `costAmount` / `amount` / `discountPercent` | 平 |
| 缓存 token 分别计价 | ✅ cache_creation / cache_read | ✅ cacheRead / cacheWrite | 平 |
| 长上下文差异计价 | ✅ `long_context_billing_applied` | 🟡 表达式定价可覆盖 | 平 |
| 图片/视频按尺寸计价 | ✅ `image_size` / `video_resolution` | 🟡 `imageCount` / `audioSeconds` | 我们较粗 |
| **在途预留（防透支）** | ✅ `billing_inflight_reservation.go` 29 KB：引用计数 + TTL 续期协程 + 订阅/Key 双维度 scope + 未实现时 fail-open | ✅ `billing.ts` hold / settle / 补偿 | 平（思路不同，都成立） |
| **价格快照（事后不重算）** | ❌ 未在 `usage_log` 中存价格快照；`gateway_request_pricing.go` 用请求时上下文取价 | ✅ `priceSnapshot` 定稿写回，补偿只按快照 | **我们领先** |
| **结算失败补偿队列** | ❌ 无对应模块 | ✅ `runCompensation` + `/admin/compensations` | **我们领先** |
| **幂等** | ✅ `idempotency.go`（24h TTL，payload 不同则 409） | ✅ `referenceId` 命中内核 hold 唯一约束 | 平 |
| 权益 / 套餐抵扣 | ✅ `subscription_service.go` + `user_subscription` | ✅ `entitlements.ts`（接内核 commerce） | 平 |
| 预算限额 | 🟡 靠余额 + 订阅 | ✅ `limits.ts` 日/月双档 | **我们多** |
| 对账单导出 | ✅ 用量导出 | ✅ `statement` + `statement.csv`（绝不重算价） | 平 |
| 倍率（账号/分组/服务档） | ✅ `rate_multiplier` × `group` × `service_tier_billing` | ✅ `groupDiscount`（读内核 `PermissionGroup.discount`） | 平 |
| 计费熔断 / 利润控制 | ✅ `gateway_profit_control.go`、`gateway_billing_block.go` | 🟡 预算 + 余额前置检查 | 部分 |

**判定**：资金这块是我们唯一可以说「设计更好」的地方，且有据：它的在途预留解决「并发透支」，我们的 hold/settle/补偿 + 价格快照解决「事后对账可复现」。**在途预留我们没有**（我们的 hold 是逐请求的，它多了 scope 维度聚合与续期），这一条该学；**价格快照与补偿队列它没有**，这一条是我们领先。

### 2.5 密钥、用户与访问控制

它有 `api_key` / `group` / `user` / `user_allowed_group` / `user_attribute_definition` / `user_attribute_value` / `user_platform_quota` / `identity_adoption_decision` / `auth_identity` / `security_secret` 等表，以及 `custom_admin_keys.go`（自定义管理员 Key 可限定 group / models / proxy / 事务）。

我们的模型：网关 Key **就是内核 `ApiToken`** + 9 个 Capability；策略在 `gatewayKeyPolicyModel`（`apiTokenId` / `models` / `rpmLimit` / `concurrencyLimit` / `quotaLimit` / `quotaUsed`）。

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| 用户自助建 Key | ✅ | ✅ | 平 |
| Key 级模型白名单 | ✅ | ✅ | 平 |
| Key 级配额 / 有效期 | ✅ | ✅ `quotaLimit` / `expiresAt` | 平 |
| 分组（group）维度 | ✅ 完整（分组定价、分组模型、分组容量） | 🟡 读内核 `PermissionGroup.discount` | 部分 |
| 用户属性 / 标签 | ✅ `user_attribute_*` | 🟡 内核 RBAC | 平（内核代管） |
| 用户封禁 / 阶梯风控 | ✅ `invalid_auth_abuse_limiter.go`、`/users/:id/unban` | 🟡 内核 | 平 |
| 二次验证 / 通行密钥 / 验证码 | ✅ passkey / TOTP / Turnstile / 阿里云 / 腾讯 | 🚫 内核 auth | 不同层 |
| 自定义管理员 Key | ✅ | 🚫 内核 RBAC | 不同层 |

**判定**：这一节大部分由内核代管，不该在插件里重做。真缺的是**分组维度的模型白名单与容量**（它按 group 限模型、限并发、限速率），我们是 key 级平铺。

### 2.6 异步任务与多模态

它的相关模块：`batch_image_*`（14 个）、`image_task.go`、`video_billing*.go`、`seedance.go`、`grok_media.go`、`grok_audio.go`、`openai_images_*`（9 个）、`image_storage*.go`（S3 存储）、`antigravity_gateway_*`（6 个）。

我们的：`tasks.ts`（800 行，descriptor 驱动）+ `artifacts.ts`（HMAC 签名链接、Range、10 分钟 TTL）+ `openai-videos.ts`（`/v1/videos` 投影）+ `task-poller` 15s job。

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| 通用异步任务框架 | 🟡 每类任务一套（batch image / video 各自） | ✅ descriptor 驱动，注册即用（`openai-video`、`kling-video`） | **我们更通用** |
| 产物访问控制 | 🟡 S3 签名 URL + `/content` | ✅ HMAC 签名 + TTL + Range + 背压 | 平 |
| 视频生成兼容面 | ✅ 生成/编辑/扩展/内容 | 🟡 生成/查询/内容/取消 | 部分 |
| 图片**批**任务 | ✅ 队列 + worker + 结算 + 恢复 | ❌ | **缺口** |
| 图片按尺寸/质量计价 | ✅ `image_billing_size.go` / `_multiplier.go` | 🟡 按张数 | 缺口 |
| 音频 TTS/STT + 音色 | ✅ 含音色 CRUD 与音频下载 | ✅ 端点透传，无音色管理 | 部分 |
| 产物存储后端可配（S3） | ✅ | ❌（走网关签名直取） | 缺口（小） |

### 2.7 可观测性与运维

它的 `ops_*` 有 **20 个 service 模块**：`ops_metrics_collector`、`ops_histograms`、`ops_realtime`、`ops_realtime_traffic`、`ops_alert_evaluator_service`、`ops_health_score`、`ops_cleanup_service`、`ops_scheduled_report_service`、`ops_ingress_reject`、`ops_request_details`、`ops_trends`、`ops_window_stats`…

管理端 307 条路由里的观测面：

```
/dashboard/{overview,snapshot-v2,error-distribution,error-trend,latency-histogram,throughput-trend,openai-token-stats}
/qps  /concurrency  /realtime  /realtime-traffic  /usage-summary  /user-breakdown  /users-ranking
/errors(/:id)  /request-errors(/:id)(/upstream-errors)  /upstream-errors(/:id)  /system-logs(/health)
/alert  /alert-rules  /alert-events  /metric-thresholds  /trend  /matrix  /capacity-summary
```

我们的：20 个指标名 + `observability.ts` 16 桶延迟直方图（D5）+ `GET /admin/overview` + 用量日志 + `/admin/metrics` + `/admin/statements`。

| 能力 | sub2api | 我们 | 结论 |
| --- | --- | --- | --- |
| 请求/Token/成本指标 | ✅ | ✅ 20 指标 | 平 |
| 延迟分位 | ✅ `latency-histogram` | ✅ 16 桶、上界、不插值 | 平 |
| 首 token 时延 | ✅ `first_token_ms` | ✅ `firstTokenMs` | 平 |
| 实时 QPS / 并发看板 | ✅ WebSocket 推送 | 🟡 分钟桶聚合 | 部分 |
| **错误分布与上游错误归因** | ✅ 三层（request / upstream / error 各自成表可下钻） | 🟡 日志 `error` 字段 | **缺口** |
| **告警规则 + 事件 + 静默** | ✅ `alert-rules` / `alert-silences` / `alert-events` | ❌ | **缺口** |
| 定时报表（邮件） | ✅ `ops_scheduled_report_service` | ❌ | 缺口（小） |
| 系统日志清理任务 | ✅ `cleanup-tasks` | 🟡 无 | 缺口（小） |
| 健康评分 | ✅ `ops_health_score` | ❌ | 缺口（小） |
| 吞吐趋势 / 容量汇总 | ✅ | ❌ | 缺口（小） |

### 2.8 控制台与国际化

| 项 | sub2api | 我们 |
| --- | --- | --- |
| 前端文件 | 319 `.vue`（Vue 3 + Vite + Tailwind） | 5 `.tsx` / 3,734 行 |
| 管理端页面 | 307 路由对应的大量页面 | 8 个 admin 页（overview / accounts / pricing / keys / usage / ops / playground / usage-logs） |
| 语言 | README 三语（EN / 中 / 日）；界面 i18n 规模未逐一核对 | **7 语言**（zh-CN/zh-TW/zh-HK/en-US/ja-JP/ko-KR/fr-FR），内核 + 插件双端接线 |
| 主题化 | 固定 | 内核主题包（atlas / default） |

**判定**：界面体量差距巨大（319 : 5）。语言数量我们领先，但**覆盖度是分阶段的**（新增三语只译了 `nav` / `common` / `admin.playground`，其余键以英文兜底），这一点已在 CHANGELOG 与 wiki 里写明，不能当作「七语言已完成」。

#### 2.9 部署与自身运营

sub2api 是一个**独立可部署的产品**，这一节与网关能力无关，但它是「工程成熟度」的一部分：

| 项 | sub2api | 我们 |
| --- | --- | --- |
| 分发形态 | 预编译二进制（amd64/arm64）+ `deploy/install.sh` 一键装 | 内核插件（随平台发布） |
| 服务管理 | systemd unit + `systemctl enable` | 内核进程内 |
| 依赖 | PostgreSQL 15+ / Redis 7+ | 内核 Postgres + 可选 Redis |
| 自升级 | ✅ `update_service.go`、`/check-updates`、`/update`、`/rollback`、`rollback-versions` | 🚫 内核负责 |
| 备份恢复 | ✅ `backup_service.go`、`backup_archive.go`、`backup_retention.go` | 🚫 运维层 |
| 多实例 | ✅ `leader_lock.go`、`ops_advisory_lock.go` | ✅ 内核 `StateService` |
| 数据管理 | ✅ `data_management_service.go` + **gRPC**（`data_management_grpc.go`） | ❌ |

这一节整体属 🚫（不同层）：部署、备份、自升级是平台职责，不是网关插件职责。唯一值得记下的是它**有 gRPC 数据面**（跨实例数据管理），我们只有 HTTP。

## 2.10 平台能力（多数不该追）

| 能力 | sub2api | 我们 | 判定 |
| --- | --- | --- | --- |
| 内置支付（易支付 / 支付宝 / 微信 / Stripe） | ✅ 17 个 `payment_*` 模块 + 退款 + 订单生命周期 | 🚫 内核 commerce | 不同层 |
| 兑换码 / 优惠码 / 推广返佣 | ✅ `redeem_code` / `promo_code` / `affiliate_service` | 🚫 内核 | 不同层 |
| 订阅套餐 | ✅ `subscription_plan` / `user_subscription` | 🟡 entitlements | 不同层 |
| 邮件（队列 / 模板 / SMTP） | ✅ 5 个模块 | 🚫 内核通知 | 不同层 |
| 公告 | ✅ `announcement` | 🚫 内核 | 不同层 |
| 备份 / 恢复 / 回滚 | ✅ `backup_service` / `rollback-versions` / `/update` | 🚫 运维层 | 不同层 |
| 插件运行时 | ✅ `plugin_manager` / `plugin_runtime` / `/plugin-ui/:token/*` | ✅ 内核插件体系（我们本身是插件） | 不同层 |

---

## 3. 真实缺口（同一定位下该补的）

### P0 —— 影响成本正确性或客户端兼容

| 缺口 | 为什么是 P0 | 工作量估计 |
| --- | --- | --- |
| **粘性会话（sticky session）** | Claude Code / Codex 这类长会话客户端，同一会话落不同账号会导致 prompt cache 全失效，成本翻倍且行为不稳定 | 中（Redis 绑定 `session_id → accountId`，调度时优先命中） |
| **TPM 限流** | 只有 RPM 时，短请求可绕过限流打满账号配额 | 小（复用分钟桶，按 `totalTokens` 累加） |
| **上游出口代理池** | 被上游按 IP 限流时只能换 Key、换不了出口 | 中（代理配置 + 探测 + 失败回退） |

### P1 —— 运营质量

| 缺口 | 说明 |
| --- | --- |
| 错误分布与上游错误归因 | 现在只有一个 `error` 字符串，无法回答「今天 429 集中在哪个账号」 |
| 告警规则 + 事件 | 只有内核通知 61/62 两条固定语义 |
| 内容审核引擎 | 只有敏感词（D2），无分类器/多引擎 |
| 凭证刷新（OAuth） | 若将来接订阅账号则必需；纯 API Key 场景不需要 |
| 分组维度的模型白名单 / 容量 | 现在是 key 级平铺，无 group 聚合 |

### P2 —— 打磨

图片批任务、图片按尺寸计价、显式 cached contents、视频 edits/extensions、产物存储可配、健康评分、吞吐趋势、定时报表、备份回滚。

### 🚫 明确不追

OAuth 订阅账号池、客户端指纹伪装、WS 会话抢占、`alpha/search` / `x_search` / `systemone` 等 provider 私有面、内置支付/兑换/推广/邮件/公告/备份。

---

## 4. 我们真正领先的地方（有证据）

| 项 | 证据 |
| --- | --- |
| **价格快照 + 补偿队列** | `billing.ts` `priceSnapshotOf` / `runCompensation`；`/admin/compensations`。sub2api 的 `usage_log` 无价格快照字段，事后重算依赖当前定价表 |
| **显式端点注册表** | `endpoints.ts` 30 条，`status: supported \| unsupported(501) \| reserved(404)`。sub2api 未命中走 Gin 默认 404，无法区分「路径错」与「未实现」 |
| **协议 IR 归一化 + 独立协议包** | `@stackpanel/llm-protocol`（7 语言无关 codec，16 测试），网关只做编排。sub2api 是 provider × ingress 的矩阵式桥接（`openai_gateway_*` 上百文件），能跑但难以复用 |
| **通用任务框架** | `tasks.ts` descriptor 驱动，新增 provider 只写一个 descriptor。sub2api 的 batch image 与 video 各自成体系 |
| **预算限额（日/月双档）** | `limits.ts` `checkBudget`，fail-open 且有测试 |
| **端点级 body limit / 请求头 denylist** | 每 endpoint `bodyLimit`；`rewrite.ts` 拒绝 `authorization`/`host`/`content-length` 等 |
| **七语言接线** | 内核 `LOCALES` 7 项 + 插件 7 份 catalog，键集一致性由 `check-package-catalogs` 强制 |
| **未知错误不外泄上游原文** | 视频面 `errorOf()` 固定文案；敏感词命中只回「命中 N 个词」不回命中词 |

---

## 5. 测试与验证现状（诚实交代）

| 项 | sub2api | 我们 |
| --- | --- | --- |
| 测试文件 | 1,611 `_test.go` | 23 `.test.ts` |
| 用例数 | 未逐一统计（仅 `service/` 下测试文件即 1,000+） | 324 |
| 覆盖层次 | 单测 + `api_contract_test.go` 契约测试 + 集成测试（`internal/integration`）+ `testutil` | **纯函数层单测** |
| 真实上游 e2e | 有（gateway / session binding / billing 等） | **无** |
| 管理端点击验证 | 未核实 | **无**（无管理员会话） |

我们的 324 个用例集中在：pricing、pricing-strategy、rewrite、sensitive、tasks、artifacts、openai-videos、custom-route、model-map、limits、entitlements、account-keys、probe、diagnostics、codecs。**没有一条覆盖真实 HTTP 往返**。

所以「测试完善」这个说法我不接受。当前准确表述是：**纯逻辑层有测试守；集成层与真实上游层未验证。**

要让这句话变成「测试完善」，最小清单：

1. 用真实凭据跑一次 `/v1/chat/completions`（流式 + 非流式）、`/v1/messages`、`/v1beta/models/*:generateContent`。
2. 跑一次视频全链路：提交 → 轮询 → 产物签名下载 → 取消。
3. 跑一次计费闭环：hold → settle 差额 → 制造结算失败 → 补偿 → 对账单与台账一致。
4. 跑一次 Playground，确认不产生流水、不扣钱包、占用并发位。
5. 注入上游 429/500，确认冷却、failover、错误码映射。

---

## 6. 结论

- **「已经完全对标 sub2api」：不成立。** 定位不同，规模差一个量级，测试差两个量级。
- **「功能都做好」：不成立。** P0 三项（粘性会话、TPM、出口代理）在同一定位下也是真缺口。
- **「测试完善」：不成立。** 零真实上游 e2e。
- **「设计比它还好」：不成立为整体判断。** 只有在资金可复现性、端点纪律、协议归一化、任务框架通用性这四点上，我们有据可说更好；在账号池、限流精度、可观测性深度、运营功能面上，它明显更强。
- **可以成立的表述**：我们是「**标准 API Key 中转计费**」这个定位下的一个**设计纪律较好、但功能面较窄、集成验证缺失**的实现；sub2api 是「**订阅额度分发**」定位下一个功能面极宽、工程量极大的实现。两者只在网关协议层与计费层部分重叠。

下一步建议按 §3 的 P0 三项推进，并把 §5 的 5 条 e2e 清单作为「可宣称测试完善」的前置条件。
