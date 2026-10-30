# 模型服务（llm-gateway）

`llm-gateway` 是面向终端用户的模型服务和计费插件：用户可开关计费、创建网关 key、查看模型价格和用量；运行时将兼容协议请求路由到上游账号池，并按实际用量结算钱包余额。

## 权限、模型和扩展

- 版本：`0.4.0`
- 用户权限：`llm-gateway.use`，声明 refined scope `gateway`。
- 管理权限：`llm-gateway.admin`。
- 使用自定义模型保存上游账号、key 策略、用户设置、用量、价格、账单条目、任务和 Agent provider 配置。
- 激活时注册模型提供者和通知类型；管理端可配置 Agent 使用的 provider。

不要把网关 key、上游 token 或账号池凭据写进前端、日志和 Capability 响应。

## 用户路由和 Capability

| Capability | 内部 route | `/api/v1` alias | scope | 写入 |
| --- | --- | --- | --- | --- |
| `gateway.billing.read` | `GET /llm-gateway/billing` | `GET /api/v1/gateway/billing` | `gateway:read` | 否 |
| `gateway.billing.write` | `POST /llm-gateway/billing` | `POST /api/v1/gateway/billing` | `gateway:write` | 是 |
| `gateway.prices.read` | `GET /llm-gateway/prices` | `GET /api/v1/gateway/prices` | `gateway:read` | 否 |
| `gateway.models.read` | `GET /llm-gateway/models` | `GET /api/v1/gateway/models` | `gateway:read` | 否 |
| `gateway.usage.read` | `GET /llm-gateway/usage` | `GET /api/v1/gateway/usage` | `gateway:read` | 否 |
| `gateway.keys.read` | `GET /llm-gateway/keys` | `GET /api/v1/gateway/keys` | `gateway:read` | 否 |
| `gateway.keys.create` | `POST /llm-gateway/keys` | `POST /api/v1/gateway/keys` | `gateway:write` | 是 |
| `gateway.keys.update` | `PATCH /llm-gateway/keys/:id` | `PATCH /api/v1/gateway/keys/:id` | `gateway:write` | 是 |
| `gateway.keys.delete` | `DELETE /llm-gateway/keys/:id` | `DELETE /api/v1/gateway/keys/:id` | `gateway:write` | 是 |

写入 Capability 经 MCP 使用时必须提供 `idempotencyKey`，并要求平台 Token 具备 `mcp.write`。这些 alias 与普通 route 复用同一权限和资源归属校验。

## 协议网关面

插件还注册 `POST`、`GET`、`DELETE /llm-gateway/*` raw 路由，用于转发 OpenAI 兼容及相关协议请求。常用的模型发现入口为 `GET /llm-gateway/v1/models`；其余请求由 relay 根据路径和方法匹配支持的 endpoint 和上游适配器。

raw relay 路由不是 Capability，也不会自动成为 MCP 工具。调用方必须使用用户网关 key 或受支持的用户认证方式；不得把内部管理 token 当作模型调用凭据。

## 管理面

管理员使用 `llm-gateway.admin` 管理上游账号、路由、模型价格、用户 key 策略、用量和 Agent provider。Agent provider 配置路由为：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/llm-gateway/admin/agent-provider` | 读取 Agent provider 配置。 |
| PUT | `/llm-gateway/admin/agent-provider` | 写入 Agent provider 配置。 |
| DELETE | `/llm-gateway/admin/agent-provider` | 删除 Agent provider 配置。 |

### 上游账号池：多 Key、测活与余额（0.2.0）

- **多 Key**：一个账号可挂最多 20 把上游 key（主 key 仍为 `apiKeyRef`，额外 key 存 `keys[]`）。
  选号先选账号，再在账号内按 `weight` 挑一把 key；某把 key 被限流/封禁时只冷却这一把
  （`llm:gw:key-cool:<accountId>:<keyId>` 哨兵，默认 60s，或按上游 `Retry-After`），
  同账号其它 key 继续服务；全部 key 冷却才换账号。
  - `POST /llm-gateway/admin/accounts/:id/keys`：追加一把 key（`label`/`apiKey`/`weight`）。
  - `DELETE /llm-gateway/admin/accounts/:id/keys/:keyId`：删除并清理 secret。
- **测活**：`POST /llm-gateway/admin/accounts/:id/test`，可选 `{ keyId, model }`。只拉上游模型清单
  （不产生推理费用），返回 `ok / latencyMs / models / hasModel`。
- **余额**：`GET /llm-gateway/admin/accounts/:id/balance`，支持 OpenRouter / DeepSeek / Moonshot /
  硅基流动；其它厂商明确返回 `supported: false`（不伪造 0）。查到后写入账号余额快照，
  另有一个 6 小时一次的 `balance-refresh` job 巡检（只读上游）。

### 计费：成本、阶梯价与权限组折扣

- **成本价**：`costInputPrice/costOutputPrice/costCacheReadPrice/costCacheWritePrice`
  与售价同单位，只用于毛利核算；不参与扣款，也不受 `multiplier`/折扣影响。
- **阶梯价**：`tiers: [{ from, inputPrice?, outputPrice?, cacheReadPrice?, cacheWritePrice?, reasoningPrice? }]`，
  按本次输入 token 落到 `from` 最大且不超过用量的那一阶，未填字段继承基础价。
- **权限组折扣**：`groupDiscount`（默认开）。取用户各组 `PermissionGroup.discount` 的最大值
  （与内核商店同一口径），只作用于售价，并写进账单快照的 `discountPercent`。
- **预留上限**：`maxOutputTokens`。客户端不传 `max_tokens` 时按它估预授权，避免长输出模型欠费。
- **中断计费**：客户端断开后仍按已发生的 usage（缺失则保守估算）结算，用量流水标记
  `aborted=true`，便于人工复核。

### 自动摘号与用量排查

- 自动摘号：配置项 `autoDisableKeywords`（默认含余额不足/欠费/invalid api key 等）、
  `autoDisableStatusCodes`、`autoDisableCooldownMs`。命中即冷却整号并写入账号
  `lastError/lastErrorAt`，指标 `account.auto_disabled` 计数。
- 用量日志页：管理端 `/admin/plugin/llm-gateway/usage`，按天数/模型/状态筛选，分页读；
  导出 `GET /llm-gateway/admin/usage-logs.csv`（raw 路由，带 BOM，Excel 直开）。
  查询接口 `GET /llm-gateway/admin/usage-logs` 支持 `days`(1–90)、`page`、`pageSize`、
  `userId`、`apiKeyId`、`accountId`、`model`、`status`。
- 新增指标：`upstream.key_rotate`、`account.auto_disabled`、`account.key_exhausted`
  （总计 19 个分钟桶计数器）。

### 套餐额度（0.3.0，商品类型 `api_token`）

商店（`store` 插件）卖「模型额度包」，本插件通过 `EXTENSION_POINTS.productType`
履约，权益落在 `llm-gateway/entitlement`：

- 商品类型配置字段：`quotaAmount`（额度，minor，`0`=不限量）、`validityDays`、
  `models`（限定模型，空=全部）、`label`（展示名）。
- 结算顺序：套餐优先、钱包兜底。预留阶段被套餐覆盖的部分**不冻钱包**，
  结算时用条件更新（`usedAmount <= quota - amount`）原子扣减，
  并发下不会扣穿；差额（含实际用量超过预估的情况）走钱包。
- 续费 = 追加一份额度并把到期时间对齐（额度包语义是「再来一包」）；
  终止/退款把权益置 `REVOKED`，已用额度不回滚。
- 手工发放：`POST /llm-gateway/admin/entitlements`（`source=admin`）；
  撤销：`DELETE /llm-gateway/admin/entitlements/:id`；用户查看：
  `GET /llm-gateway/entitlements`。

### 表达式计费（0.3.0）

定价行新增 `strategy`（`flat`/`tiered`/`expr`）与 `expr`。表达式语言是最小
算术集，**不支持任意代码**：

- 运算符 `+ - * /`、括号、一元负号；
- 变量：`prompt_tokens`、`completion_tokens`、`total_tokens`、
  `cache_read_tokens`、`cache_write_tokens`、`reasoning_tokens`、
  `image_count`、`audio_seconds`、`multiplier`；
- 函数：`min`/`max`/`round`/`ceil`/`floor`/`abs`；
- 结果即实收金额（minor），不再乘倍率；再叠加权限组折扣。
- 写入时编译校验（`PATCH/POST /llm-gateway/admin/prices`），编译失败会拒绝；
  运行期若表达式异常则回落到固定单价，不会 500。
- 节点数 ≤ 200、金额夹在 `[0, 1e11]`，写错量级不会扣穿余额。

### 预算限额与提醒（0.3.0）

- `llm-gateway/budget-limit`：`userId`（空=全局默认）、`period`（`day`/`month`）、
  `amountLimit`（minor，0=不限）、`warnPercent`、`action`（`warn` | `block`）。
- 计数走 Redis 计数器 `llm:gw:spend:<period>:<userId>`（结算时累加），
  预留前读一次判断；state 故障 fail-open。
- 达阈值发 `gateway.budget.warned` / `gateway.budget.exceeded` 通知，
  按「用户+周期+档位」去重；`block` 超限返回 402 `budget_exceeded`。
- 管理端：`GET/POST/PATCH/DELETE /llm-gateway/admin/budget-limits`，或「运营」页。

### 模型映射（0.3.0）

- `llm-gateway/model-map`：`from` + `mode`（`exact`/`prefix`/`regex`）+ `targets`
  （`[{model, weight}]`）+ `priority` + `enabled`。
- 优先级：定价行 `upstreamModel`（死绑定）> 映射表（priority 降序 →
  精确 > 前缀（更长优先）> 正则）；全部未命中时原样透传。
- 实际转发的模型名写进用量流水 `upstreamModel`，排障时可直接对照。
- 非法正则/空目标在写入时拒绝；运行期匹配失败回退原名，不会打到错误的模型。

### 对账单与公开价目（0.3.0）

- `GET /llm-gateway/admin/statements?month=YYYY-MM`：按用户与模型聚合
  （请求数/token/实收/成本/套餐抵扣）；`statements.csv` 同参数导出明细。
- `GET /llm-gateway/statement?month=YYYY-MM`：用户自己的当月账单（含按模型明细）。
- 金额一律取流水快照（`amount`/`costAmount`/`discountPercent`），**不重新计价**，
  改价不会篡改历史账单。
- `GET /llm-gateway/public/prices`（`auth: 'optional'`）：匿名可读价目，
  登录后叠加该用户权限组折扣（返回 `discountPercent` 与折后单价）。

### 异步任务框架（0.4.0）

厂商的「提交 → 轮询 → 取产物」异步接口（视频、音乐、长图）不适合走同步透传，
插件内自带一个执行器：

| 路由 | 作用 |
| --- | --- |
| `GET /llm-gateway/tasks/descriptors` | 列出可用任务类型与其参数白名单 |
| `POST /llm-gateway/tasks` | 提交任务（`{descriptorId, model, params}`） |
| `GET /llm-gateway/tasks`｜`/tasks/:id` | 我提交的任务（含产物签名链接） |
| `POST /llm-gateway/tasks/:id/cancel` | 取消并全额释放冻结 |
| `POST /llm-gateway/admin/tasks/:id/poll` | 管理端强制推进一次（排障用） |

**任务描述是数据，不是代码**。一条描述 = 提交路径 + 请求体模板（`{prompt}` 等
占位）+ 轮询路径（`{upstreamId}`）+ 状态字段点路径 + 成功/失败词表 + 产物来源 +
计费单位。对手的 task 插件用 ESM `buildSubmitRequest/parseTaskResult` 执行任意
代码；我们把「任意代码执行」留在内核插件沙箱，网关只解释 JSON——一次插件升级
不可能改掉计费逻辑。

内置描述：`openai-video`（Sora，`/videos`，产物需带凭据取 `/videos/{id}/content`）、
`kling-video`（可灵，产物是厂商 CDN 公开链接）。

状态机与资金：

```
QUEUED ──▶ RUNNING ──▶ SUCCEEDED（按产物数结算）
              │├────▶ FAILED / CANCELLED / EXPIRED（全额释放）
```

- 提交时 `reserve` 冻结「1 个单位」的金额并**冻结当时的价目快照**，完成时用
  同一份快照结算；中途改价不会算出第二笔账。
- 冻结 TTL 由描述里的 `ttlMs` 决定，且必须覆盖整个轮询窗口（写入时校验），
  否则任务还在跑、钱已经被内核自动归还。
- 轮询失败（网络/5xx）**不算任务失败**：只推后下次重试，不释放冻结——上游可能
  只是暂时联系不上，任务仍在跑。
- 每 15 秒一轮、串行、每轮最多 10 个：一个限流的上游不会拖垮整批任务。

### 产物签名 URL（0.4.0）

`GET /llm-gateway/artifacts/:taskId/:index?expires=&sig=`

- 签名 = `HMAC-SHA256(secret, taskId|index|expiresAt)`，默认 10 分钟，恒定时间
  比较；密钥存插件 state，不落 DB、不进日志。
- 路由 `auth: 'optional'`：视频要能被 `<video src>` 直接播放（浏览器不会在
  `<video>` 上带 Authorization），鉴权完全靠签名。
- 上游凭据只在**代理这一侧**注入：对外链接里永远不出现上游 key。
- 产物 URL 来自上游响应，等于不可信输入，代理性拉取必须过 SSRF 校验；
  支持 `Range` 透传（视频拖动进度）。

### 参数/头改写与状态码映射（0.4.0）

「说是 OpenAI 兼容、其实不是」的上游（多塞一个字段就 400、头名不一样、状态码含义
不同）用账号级改写配置兜住。配置在账号行 `rewrites`，**默认关闭**：

```json
{
  "enabled": true,
  "set": { "temperature": 0.2, "stream_options.include_usage": true },
  "unset": ["logprobs"],
  "rename": { "max_tokens": "max_completion_tokens" },
  "setHeaders": { "x-api-version": "2024-06-01" },
  "unsetHeaders": ["openai-beta"],
  "statusMap": { "529": 503 }
}
```

- 写配置：`POST/PATCH /llm-gateway/admin/accounts[/:id]` 带 `rewrites` 字段。
  非法配置（路径含 `__proto__`、超过 3 层、头名不合法、状态码越界、超过 20 条）
  一律 400，不会留到运行期才炸。
- 作用点：`buildUpstreamCall` 之后、发出请求之前，一次性作用于该账号的最终请求。
- **只允许四种白名单操作**：写常量 / 删字段 / 改名 / 增删头。不做通用 JSONPath，
  更不执行 JS——改写器就在计费链路上，能算任意东西就等于给改配置的人一个执行面。
- 以下头**拒绝改写**：`authorization`、`host`、`content-length`、`transfer-encoding`、
  `connection`、`accept-encoding`、`content-encoding`（凭证注入与流式契约由 adaptor 掌握）。
- 非 JSON 请求体（multipart、音频、文件上传）不做改写：解析一次就等于弄坏它们。
- 每笔请求实际被改了什么，写进用量流水 `rewrites` 列
  （`body.set:temperature,header.unset:x-foo,status.529>503`），排障与事后复盘都靠它。

### 敏感词过滤与审计（0.4.0）

合规兜底，不是内容审核系统：真正的审核交给上游 moderation 或专门插件，这里
只保证「网关上能拦住一组明确违规词」。

配置（`PATCH /llm-gateway/admin/config`）：

```json
{ "sensitiveWords": ["敏感词A", "badword"], "sensitiveWordAction": "block" }
```

- 动作：`block`（默认）→ 400 `sensitive_content`，**不冻结、不扣费、不写流水**，
  因为扫描发生在预留资金之前；`log` → 放行但留审计。
- 扫描范围：system + 各消息的文本片段。图片与工具参数不解析（无意义且慢）。
- 匹配规则：中文子串匹配，并额外用「去掉空白」的形态拦住「敏 感 词」拆字；
  拉丁词按**词边界**匹配（`ass` 不会命中 `class`）。
- 不回显命中内容给调用方：只说「命中 N 条内容策略」。命中词与规模进审计
  （`llm-gateway.sensitive_content`），不存请求正文。
- 词表上限 200 条 / 每条 64 字符，超限**截断**并在响应里给出 `droppedWords`。

**管理端审计**：账号增删改（含 key 轮换、改写开关）、价目改删、平台配置更新都会写
内核 `audit_logs`（`llm-gateway.account.create|update|delete`、
`llm-gateway.price.update|delete`、`llm-gateway.config.update`），与内核其它管理
动作落在同一条时间线上。审计失败只吞错，不会把成功的业务动作变成 500。

### 延迟分位数与转换诊断（0.4.0）

**延迟分位数（D5）**：`GET /llm-gateway/admin/overview` 的 `latency` 字段给出
最近 1 小时的 `p50` / `p95` / 样本数（总延迟与首 token 各一组）。指标以 16 档
直方图计数（50ms … 60s + 溢出桶）落 state，分位数取**命中档位的上界**：
桶宽决定了精度，做桶内插值只会造出「p95 = 733ms」这种假精度。

**转换诊断（D4）**：两个只读管理端路由，排障用，不发上游请求、不接触凭证。

| 路由 | 作用 |
| --- | --- |
| `POST /admin/diagnostics/convert` | `{from, to, body, model}` → 编码结果 + 丢失/新增字段 + 语义提示 |
| `GET /admin/diagnostics/adaptors` | provider × 方言 × 能力位 × 保留字段矩阵 |

典型结论示例：Responses → Chat 会报「服务端工具 `web_search_preview` 会被丢弃」
「`previous_response_id` 只对 responses 出口有意义」「这是一次有损转换」；
同协议则报「直通」，因为 relay 在同协议时**克隆原始体**（只覆盖 `model`），
不走 IR 重建。诊断与真实链路必须一致，否则比没有诊断更糟。

### 自定义上游路由（0.4.0）

一家一条私有协议的上游（路径、鉴权、方法都不一样）用 `provider: 'custom'`：

```json
{
  "provider": "custom",
  "baseUrl": "https://api.vendor.example",
  "options": {
    "route": {
      "urlTemplate": "{baseUrl}/v2/chat/{model}",
      "method": "POST",
      "authType": "x-api-key",
      "headers": { "x-tenant": "acme" }
    }
  }
}
```

- 占位符只有四个：`{baseUrl}`、`{path}`（codec 给出的相对路径）、`{model}`
  （上游模型名）、`{stream}`（`true|false`）。写了未知占位符 → 400。
- 鉴权四种：`bearer`（`Authorization`）、`x-api-key`、`query`（参数名可配）`none`。
- **不提供可执行转换器**：对手允许在渠道里挂一段转换脚本，我们刻意不做——
  那等于把鉴权与计费链路的入参交给一段不受审的代码。要改请求结构，用
  C4 的白名单改写，或者写一个 adaptor（静态、有测试）。
- 写入即校验：模板含 `..`/换行、头名非法、试图覆盖 `authorization`/`host` 等
  关键头，一律 400；构造出的最终 URL 仍要过 SSRF 校验（生产环境）。
- 能力位取保守值（不声明 operations、不注入 `stream_options`）：自定义路由下
  我们无从得知上游支持什么，宁可少做也不猜。

### Responses 原生直通（0.4.0）

`provider: 'openai-responses'` 是一个**协议直通**账号类型：

- `openai` 号说的是 chat completions 方言，Responses 请求会被转换 → 服务端工具
  （`web_search_preview`）、`previous_response_id`、`include`、`store` 全部丢失。
- 挂 `openai-responses` 的账号与客户端同协议，请求体原样转发：这些字段、流式
  `sequence_number`、以及上游的压缩能力都由上游处理，网关不参与改写。
- 该 provider 不注入 `stream_options`（Responses 会 400），也不声明非对话
  operations（Responses 没有 embeddings 等端点）。

### provider 预设（0.4.0）

新增 8 个「也说 OpenAI Chat」的预设，选账号时直接选，不必填 `openai-compatible`：

火山方舟（豆包）｜阿里云百炼（通义）｜智谱 GLM｜Moonshot（Kimi）｜MiniMax｜
讯飞星火｜Cloudflare Workers AI｜302.AI

各自声明了真实差异：保留字段（`thinking` / `enable_thinking` / `seed` /
`audio_setting` 等）、能力位（是否支持 embeddings / images / audio / rerank）、
是否可注入 `stream_options`（Cloudflare 与 Mistral 会拒绝未知字段）。

管理员路由的完整字段和上游适配器行为随插件版本演进较快。扩展适配器时应实现既有 adaptor contract、正确声明协议能力、保留用量计量和余额预授权/结算链路，并为 endpoint 匹配和计费写测试。

## 界面语言（7 种）

`zh-CN` / `zh-TW` / `zh-HK` / `en-US` / `ja-JP` / `ko-KR` / `fr-FR`，catalog 在
`frontend/messages/`，并在 `frontend.locales` 与 `manifest.messages` 里声明。

覆盖度（不是「已全部翻译」）：

- 已译：`nav.*`、`common.*`、`admin.playground.*`（新增语言 52 键/语言）
- 未译：其余键在 catalog 文件里**以英文兜底**——刻意不是运行时回退，否则会出现
  「日语界面里冒出一句中文」
- `zh-TW` / `zh-HK` 由 `pnpm i18n:hant` 从 `zh-CN` 派生，**不要手改**

新增文案的顺序：`zh-CN` → `en-US` → `i18n:hant` 派生繁中 → 同步新语言 → `manifest.messages`
重新内嵌 → 跑三项检查（`check-package-catalogs` / `scan-i18n-literals` / `i18n-hant --check`）。

## 管理端 Playground（`/admin/playground`）

运营/客服排查「这个账号这个模型现在通不通」的工具：管理端「试用台」页 → `POST
/llm-gateway/admin/playground`（`llm-gateway.admin`）→ 服务端按优先级选一个健康账号、
占用它的并发位、直连上游非流式调用 → 返回文本、用量、耗时、命中账号。

两条刻意的取舍：

- **不扣用户钱包、不写用量流水**。做成计费路径会有两个坏结果：客服替用户排查要花
  用户的钱；测试流量混进对账数据。代价是运营可能刷上游额度，所以它只对
  `llm-gateway.admin` 开放，并且**占用真实并发位**（不会绕过限流把账号压垮）。
- **不走账号参数/头改写**。Playground 要看的是上游原始行为；经改写后的结果反而无法
  用来回答「上游到底返回了什么」。

上游错误经 adaptor 分类器翻成稳定码再上屏，原始响应体只进服务端日志（前 400 字）。

## OpenAI Videos 兼容面（`/v1/videos`）

媒体类客户端（OpenAI SDK 的 `client.videos`）只认这套接口，所以在这里做一层**投影**，
底层仍是任务框架（`tasks.ts`）的行——提交、轮询、产物签名、结算、取消都已跑通并有单测，
重写一套只会多一条会漂移的代码路径。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/llm-gateway/v1/videos` | 提交（`model` + `prompt`，可选 `seconds`/`size`/`input_reference`） |
| GET | `/llm-gateway/v1/videos` | 列表（`?limit=` 夹在 1..100） |
| GET | `/llm-gateway/v1/videos/:id` | 查询（video 对象） |
| GET | `/llm-gateway/v1/videos/:id/content` | 取 mp4（支持 Range）；未完成返 `409 video_not_ready` |
| DELETE | `/llm-gateway/v1/videos/:id` | 取消（台账行保留用于对账） |

模型按前缀路由到任务描述：`sora*` → `openai-video`，`kling*` → `kling-video`，其它一律
`400 unsupported_model`（不猜描述去提交）。

刻意的偏离，都写在 `src/openai-videos.ts` 文件头：

- `input_reference` 收 **URL 字符串**，不收 multipart 文件——网关不做文件上传中转。
- `progress` 只有 `0/50/100`：上游不给百分比，编造中间值等于撒谎。
- 失败原因固定文案：`task.error` 可能含上游片段或内部主机名，不回传。
- `CANCELLED`/`EXPIRED` 都映射成 `failed`（对方没有第三态）。
- `seconds`/`size` 会按描述翻译：OpenAI 描述直传，可灵描述转成 `duration`/`aspectRatio`。

## 入口路径归一化

`matchIngress`（协议包）负责把入口路径认成四种方言。两个容易踩的点：

- **Gemini 的 OpenAI 兼容入口**：客户端把 baseUrl 配成 `<网关>/v1beta/openai`，请求落到
  `v1beta/openai/chat/completions`。这里剥掉前缀归一化成 `v1/chat/completions`，否则
  endpoint registry 认不出、直接 501。
- **认不出来的路径不在这里拒绝**：按 OpenAI Chat 原样透传，是否支持由 endpoint registry
  决定（未知端点一律 `501`）。

## 协议包（`@stackpanel/llm-protocol`）

线协议与 IR 不在网关里：`protocol.ts`（IR 类型、`textOf`/`asString` 等规范化助手）与
`codecs/`（`openai-chat` / `openai-responses` / `anthropic` / `gemini` 编解码 + SSE 解析）
住在 `packages/protocol`。网关通过 `import ... from '@stackpanel/llm-protocol'` 使用。

- **为什么抽**：这段代码解决的是「一段 JSON 是什么方言」，与售卖、计费、账号池无关。
  留在网关里，任何第二个要用它的插件都得复制一份，然后两份慢慢漂移。
- **为什么产物还是单文件**：`scripts/build-plugin.mjs` 会把**本仓工作区包内联**进
  `dist/index.js`（判定依据：`node_modules/<name>` 软链指向本仓 `packages/`）；
  `@stackpanel/sdk`、`zod` 这类内核提供的裸包仍保持 external。内联失败会让构建直接
  失败——否则错误会推迟到内核加载时的 `ERR_MODULE_NOT_FOUND`。
- **认不出的入口路径不在这里拒绝**：`matchIngress` 对未知路径按 OpenAI Chat 透传，
  是否支持由 endpoint registry 决定（未知端点返 `501`）。

## 实时通道（Realtime / WebSocket）

当前**不支持**，`/v1/realtime` 等端点返回 `501`——这是刻意行为（未知端点不猜），
不是缺口遗漏。原因在内核而非插件：插件路由只有 `handler`（JSON）与 `raw`
（原生 req/res 流）两种，**拿不到 `upgrade` 事件与 socket**，插件无法自己完成 WS 握手。

内核侧设计见 [`docs/realtime-ws-rfc.md`](../realtime-ws-rfc.md)：推荐新增
`kind: 'upgrade'` 路由 + 握手前鉴权 + 背压/断开传播，插件侧复用现有
`resolveGatewayKey`、预算检查、`reserve`/`settle` 完成按秒/按分钟计费。

## 集成边界

外部系统应优先使用用户级 `/api/v1/gateway/*` Capability 管理自己可见的 key 和计费状态；不要调用管理端 route 修改其他用户配置。需要新增自动化写操作时，先定义是否可逆、如何幂等、是否需要 Agent 审批，再扩展 manifest Capability。
