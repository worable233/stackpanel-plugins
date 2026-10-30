# llm-gateway

模型服务插件：把上游模型厂商聚合成一个 OpenAI / Anthropic / Gemini 兼容的出口，带上账号池、
计费、限流、任务与观测。

- 对外协议：`openai-chat`、`openai-responses`、`anthropic`、`gemini`（入口可混合，按需转码）
- 计费走内核钱包：**先预留、再结算**，失败全额释放并留补偿
- 网关 key 就是内核 `ApiToken`（9 个 Capability），没有第二套凭证表

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 路由注册（数据面透传、管理端、任务、产物）、插件生命周期 |
| `src/relay.ts` | 数据面主链路：鉴权 → 敏感词 → 预留 → 选号 → 上游 → 结算 |
| `src/routing.ts` | 候选构造与占位（亲和 / 同协议 / 优先级 / 加权随机） |
| `src/billing.ts` · `src/pricing*.ts` | 预留/结算、价目与表达式定价、成本与毛利 |
| `src/adaptors/` | 各厂商适配器（鉴权头、请求构造、用量提取、错误分类、自定义路由） |
| `src/tasks.ts` · `src/artifacts.ts` | 异步任务框架与产物签名 URL |
| `src/playground.ts` | 管理端试用台（不扣钱包、不写流水） |
| `src/openai-videos.ts` | `/v1/videos` 兼容面（投影自任务框架） |
| `src/sensitive.ts` · `src/rewrite.ts` · `src/limits.ts` | 内容策略、参数/头改写、预算限额 |
| `src/observability.ts` · `src/diagnostics.ts` | 指标与延迟分位数、协议转换诊断 |
| `frontend/src/` | 用户端与管理端界面（`admin/overview|accounts|usage|ops|playground|*-editor`） |

协议与 IR 不在这里：见同仓 `packages/protocol`（`@stackpanel/llm-protocol`）。

## 常用命令

```bash
pnpm --filter @stackpanel/plugin-llm-gateway build        # tsc → dist（内核装载这个）
pnpm --filter @stackpanel/plugin-llm-gateway test         # vitest
pnpm --filter @stackpanel/plugin-llm-gateway typecheck    # tsc --noEmit
```

前端产物由内核的 `scripts/build-frontend.mjs` 编译（esbuild），**不要**用 `build-plugin.mjs`
打前端。只想重建本插件时：

```bash
cd ../StackPanel   # 内核检出
STACKPANEL_PLUGIN_SOURCES=<本仓>/packages/plugins \
STACKPANEL_FRONTEND_ONLY=plugins/llm-gateway \
node scripts/build-frontend.mjs
```

## 主要接口

数据面（需要网关 key）：

```
POST /llm-gateway/v1/chat/completions      POST /llm-gateway/v1/responses
POST /llm-gateway/v1/messages              POST /llm-gateway/v1beta/models/{m}:generateContent
GET  /llm-gateway/v1/models
POST /llm-gateway/v1/videos                GET  /llm-gateway/v1/videos/:id[/content]
POST /llm-gateway/tasks                    GET  /llm-gateway/tasks/:id
GET  /llm-gateway/artifacts/:id/:index     （HMAC 短时链接，10 分钟）
```

管理端（需要 `llm-gateway.admin`）：

```
GET/PATCH /llm-gateway/admin/config         账号 / 价目 / 策略 CRUD
GET       /llm-gateway/admin/overview       成本、毛利、延迟分位数
GET       /llm-gateway/admin/usage-logs     用量流水（+ /csv）
POST      /llm-gateway/admin/playground     试用台（不扣钱包）
POST      /llm-gateway/admin/diagnostics/convert   协议转换诊断
GET       /llm-gateway/admin/diagnostics/adaptors  适配器能力矩阵
```

## 设计纪律（改代码前先读）

- **资金顺序**：先预留再选号；失败释放；结算用**提交时的价目快照**，永不按现价补算。
- **未知端点一律 `501`**：不做「猜一个上游路径」的兜底。
- **改写是白名单不是语言**：只允许 set/unset/rename/headers/statusMap，禁 auth 与协议头。
- **上游错误原文不出网**：界面/响应只给稳定 code + `tr(...)` 文案，原文进日志。
- **单测覆盖纯逻辑**（选号、定价、改写、任务状态机、兼容面投影），relay 主链路靠类型与集成测试。

## 文档

- `../../docs/wiki/AI-LLM-Gateway.md`：功能与取舍说明
- `../../docs/llm-gateway-vs-new-api.md`：与 new-api 的逐功能对比
- `../../docs/realtime-ws-rfc.md`：Realtime/WebSocket 的内核 RFC（C6）
