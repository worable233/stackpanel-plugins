# 更新日志

本文件记录 StackPanel 插件集的公开变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
各插件版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；
插件版本以各插件 `src/index.ts` 中 manifest 的 `version` 为准。

## [Unreleased]

### 新增（llm-gateway）

- **公开价格目录（按模型名自动填价）**：`GET /admin/price-catalog` 从 LiteLLM
  公开价格表（3500+ 条有效模型条目）查参考价，三级匹配（精确 / 去渠道前缀 /
  后缀）并返回所有候选；汇率可配（`usdRateMinor`，默认 1 USD = 700 分）。
  参考价只落 `ref*` 字段，**从不参与计费**；前端定价页新增「查参考价 →
  填入成本价 / 填入售价」。
- **峰谷时段价**：定价行可挂若干时段窗口（时区 + 星期 + `HH:MM-HH:MM`，
  支持跨午夜），命中窗口后按比例（`percent`）或显式单价覆盖基础价。
  优先级：基础价 < 时段价 < 阶梯价。窗口在**请求入口**一次性烘进价格快照
  （`windows` 清空），结算不再重判——跨时段边界的长请求按到达时刻的价格计。
  **方向语义：基础价 = 峰时价，窗口 = 低谷折扣**（与 DeepSeek 官方口径和
  LiteLLM 数据源一致：「off-peak rates are half of the peak rates」）。
  **已知缺口**：DeepSeek 官方口径包含「中国法定节假日全天低谷」，但公开数据源
  的 `windows` 只有时段+星期，没有节假日字段。目录查询返回 `holidayGap: true`
  并在 UI 显式警示，需管理员手工补全天窗口——不猜节假日表（每年变且无法从
  数据源派生），但不沉默。
- **参考价与汇率语义澄清**：`usdRateMinor` 默认 700 = 1 USD = ¥7.00 = 700 分，
  **仅用于把 LiteLLM 的美元公开标价换算成人民币分**，从不参与计费。界面现在
  同时展示美元原值与换算结果（`$0.30/M × 7.00 = 210 分/M`）并明写「参考价
  不等于这家上游实际收你的钱」——只给换算后的「210」会被误读成人民币标价。
  汇率配成 **0 即关闭参考价功能**（不拉取数据源，返回 `disabled: true`），
  适合上游本身用人民币结算、或不想被美元标价误导的场景。
- **阶梯价编辑器**（前端）：阈值 + 输入/输出价的增删表格；与峰谷编辑器一样
  以 JSON 字符串经扁平表单提交（后端 `jsonArray()` 反序列化，解析失败 400
  而非静默清空）。
- 概览 `costCoverage` 口径修正：按「成本已知的请求占比」计算，不再混入
  折扣请求数。
- 修复：action 成功后的 `NEXT_REDIRECT` 被误报为「保存失败」——声明了
  `successFeedback` 的 action 在服务端 redirect 时会以 rejection 形式到达
  客户端 `await`，现已识别该 digest 并正常跳转。
- 内核：`apps/web/src/i18n/messages/*` 补齐 `locale.*` 七语言端名
  （D3 遗留：语言选择器在新增 ja-KO-fr 后缺 key 告警）。

### 变更

- `@stackpanel/llm-protocol` 0.1.0（新包）：线协议与 IR 从 `llm-gateway` 抽离（D6）——
  `protocol.ts`（IR 类型 + 规范化助手）与 `codecs/`（chat / responses / anthropic /
  gemini 编解码 + SSE 解析）。网关改为依赖该包，产物仍为单文件（见下）。
- 构建：`scripts/build-plugin.mjs` 现在会**内联本仓工作区包**（判定依据是
  `node_modules/<name>` 软链是否指向本仓 `packages/`），其余裸包维持 external；
  并新增一条构建期断言——内联失败直接判红，而不是留到内核运行时
  `ERR_MODULE_NOT_FOUND`。
- `llm-gateway` 0.4.0：异步任务框架 + 产物签名 URL + 8 个 provider 预设 + 参数/头改写 + 自定义上游路由 + Responses 原生直通 + 延迟分位数/转换诊断 + 敏感词过滤与审计（C1/C2/C5/C4/C3/C7，D2/D4/D5）。

  - **异步任务框架（C1）**：新增 `src/tasks.ts`——**数据驱动**的任务描述契约
    （提交路径/请求体模板、轮询路径、状态字段点路径、成功/失败词表、产物来源、
    计费单位），由解释器执行，**不做 JS 沙箱**（与对手的 task plugin runtime
    刻意分道）。内置 `openai-video`（Sora）与 `kling-video`（可灵）两条描述。
    执行器 `task-poller` 每 15 秒推进一批（串行、每轮 ≤10），状态机
    `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED | EXPIRED`。
  - **任务计费**：提交时 `reserve` 冻价快照并按张/秒/次预留（TTL 由描述决定，
    必须覆盖整个轮询窗口），完成时用**同一份快照**结算，失败/取消/超时全额
    `release`。台账 `billingRef` 指向的冻结不会因为任务结束而悬空。
  - **产物与签名 URL（C2）**：新增 `src/artifacts.ts`——HMAC-SHA256 签名绑定
    `taskId + index + 过期时间`（默认 10 分钟，恒定时间比较），密钥存插件 state。
    对外只发站内签名链接，**上游 key 永远不出现在 URL 里**；代理下载按产物类型
    注入账号凭据、过 SSRF 校验（`@stackpanel/net-guard`）、透传 Range 支持拖动。
  - **新增路由**：`GET /llm-gateway/tasks/descriptors`、`POST /llm-gateway/tasks`、
    `GET /llm-gateway/tasks`、`GET /llm-gateway/tasks/:id`、
    `POST /llm-gateway/tasks/:id/cancel`、raw `GET /llm-gateway/artifacts/:id/:index`、
    `POST /llm-gateway/admin/tasks/:id/poll`。
  - **任务模型扩展**：`gatewayTask` 增加 `accountId` / `descriptorId` / `apiKeyId` /
    `currency` / `requestSpec` / `attempts` / `nextPollAt` / `expiresAt` / `artifacts`
    字段，并为 `nextPollAt` 建索引（到期任务查询）。
  - **provider 预设（C5）**：新增火山方舟、阿里云百炼（通义）、智谱 GLM、
    Moonshot(Kimi)、MiniMax、讯飞星火、Cloudflare Workers AI、302.AI 八个
    OpenAI 兼容预设（含各自的 `thinking`/`enable_thinking` 等保留字段与能力位）。
  - **参数/头改写 + 状态码映射（C4）**：新增 `src/rewrite.ts`。账号级配置
    （`rewrites`），支持 `set` / `unset` / `rename`（点路径，最多 3 层、禁原型链与
    数组下标）、`setHeaders` / `unsetHeaders`（头名大小写不敏感，鉴权与协议关键头
    **拒绝改写**）、`statusMap`（上游码 → 对外码，参与分类/重试/返回）。
    **默认关闭**（`enabled !== true` 时链路零改动），写入时校验、非法配置直接 400；
    每笔请求的改写痕迹落 `usage-log.rewrites` 列（如
    `body.set:temperature,header.unset:x-foo,status.529>503`），改配置引发的事故可回溯。
    刻意**不做**通用 JSONPath/JS：改写器坐在计费链路上，只允许「写常量/删字段/改名」。
  - **自定义上游路由（C3）**：新增 `provider: 'custom'` + `src/adaptors/custom-route.ts`。
    账号 `options.route` 声明 `urlTemplate`（`{baseUrl}` `{path}` `{model}` `{stream}`）、
    `method`、`authType`（bearer / x-api-key / query / none）、`authParam`、
    静态 `headers`、`contentType`。**不提供可执行转换器**（对手的渠道脚本 =
    未审代码进入鉴权与计费链路），需要改结构走 C4 白名单改写或写 adaptor。
    写入时校验：模板不得含 `..`/换行/未知占位符，头名不得覆盖
    `authorization`/`host` 等，非法配置直接 400；构造出的最终 URL 仍过 SSRF 校验
    （生产环境）。
  - 修正：账号 `provider` 字段此前只接受四种协议名，导致 C5 的厂商预设与
    `custom` 在管理端**根本无法保存**；现在同时接受已注册 adaptor id。
  - **Responses 原生直通（C7）**：新增 provider `openai-responses`
    （`src/adaptors/openai.ts`），协议位 `openai-responses`。此前的 `openai` 号是
    chat 方言，Responses 请求会被转换成 chat completions，于是服务端工具
    （`web_search_preview`）、`previous_response_id`、`include`、`store` 全部丢失；
    挂这个 provider 的账号与客户端协议相同，请求体原样直通，这些字段（以及
    `sequence_number`、压缩类请求）由上游原样处理。`streamUsage` 刻意关掉：
    Responses 不认 chat 的 `stream_options`，注入即 400。
  - **延迟分位数（D5）**：`src/observability.ts` 增加 16 档延迟直方图（含溢出桶，
    1 小时窗口），`GET /admin/overview` 返回 `latency.total` 与 `latency.firstToken`
    的 p50/p95 与样本数。分位数取**命中档位上界**，不做桶内插值——桶宽本来
    就不支持那个精度，插值只会造假象。
  - **转换诊断（D4）**：新增 `POST /admin/diagnostics/convert`
    （`{from,to,body,model}`）与 `GET /admin/diagnostics/adaptors`。前者跑一遍真实
    转换并返回编码结果、**丢失/新增的顶层字段**与语义提示（服务端工具、
    `previous_response_id`/`store`/`include` 跨协议不可表达、同协议直通等），
    不发上游请求、不接触凭证。**诊断照抄 relay 的真实行为**：同协议是克隆直通，
    不是经 IR 重建（否则会得出「Responses 直通会丢 web_search」的错误结论）。
  - **敏感词过滤（D2）**：新增 `src/sensitive.ts` + 配置项 `sensitiveWords` /
    `sensitiveWordAction`（`block` 默认 / `log`）。在**预留资金之前**扫描文本片段，
    命中即拒不冻结、不扣费、不写流水；命中详情（词、规模、决定）进内核
    `auth.audit`（`llm-gateway.sensitive_content`），**不回显给调用方**——把词表
    回给用户等于附送规避指南。匹配规则：中文按子串并额外用「去空白」形态拦
    拆字规避；拉丁词按**词边界**（`ass` 不命中 `class`）。词表上限 200 条 / 64 字符，
    超限**截断不拒绝**（运维调词表不该因为第 201 个词整份存不进去）。
  - **管理端审计（D2）**：账号增删改（含 key 轮换、改写开关）、价目改删、平台配置
    更新写入内核 `audit_logs`（`llm-gateway.account.*` / `.price.*` / `.config.update`）。
    审计失败只吞错，绝不把已成功的业务动作变成 500。
  - 配置默认值改为单一来源 `runtime.DEFAULT_CONFIG`（`relay.loadConfig` 不再维护
    第二份 fallback，避免加配置项时两处漂移）。
  - **协议包抽离（D6）**：`src/protocol.ts` 与 `src/codecs/` 整体移到
    `packages/protocol`（`@stackpanel/llm-protocol`），网关只留 `import`。收益不是
    「少几行」，而是**线协议不再属于网关**：任何要把上游方言换成统一 IR 的东西
    （模型类插件、诊断工具）都能直接复用，不必装整个网关。
  - **真实端到端验证（首次）**：起了本地 mock 上游，用真实管理 API 走通
    添加账号 → 建 Key → 模型列表 → 非流式调用 → 流式调用 → 计费结算全链路。
    过程中发现并修复 3 个真问题：
    1. **`dist/` 里协议包未内联**：`pnpm prepare` 的 `tsc` 直出会覆盖
       `build-plugin.mjs` 的 esbuild bundle，产出 34 个文件、7 处残留
       `import '@stackpanel/llm-protocol'`，安装后运行时 `Cannot find module`。
       构建期断言只查 `dist/index.js`，因此对「tsc 覆盖 bundle」这种形态无效。
       **安装前必须跑 `node scripts/build-plugin.mjs`，不能只依赖 `prepare`。**
    2. **成功请求的 `httpStatus` 恒为 0**：`relay.ts` 里 `httpStatus` 初始化为 0，
       成功路径忘了赋 `response.status`，导致所有成功调用的用量流水记 `httpStatus=0`，
       对账无法区分 200/201/206。已修，并加回归测试（`mapStatus(0)` 边界）。
    3. **钱包流水备注写「预授权」但实为结算扣款**：内核 `wallet.settleHold`
       不接受 note 参数，结算不会改写预留时写下的备注，因此用户账单上永远
       显示「预授权 -1」而非「模型调用 -1」。已把预留文案改为「模型调用」。
  - **`STACKPANEL_PLUGIN_SOURCES` 无法从 `.env` 生效**：`market.ts` 的
    `PLUGINS_SOURCES` 是模块顶层常量，而 API 用 `dotenv/config` 在 `env.ts`
    里注入，求值顺序不保证；实测只有进程启动时的真实环境变量有效。
    文档里已注明必须用 shell 环境变量启动 API。
  - **真实上游端到端验证（codex666ai.com）**：用 `openai-responses` 协议接入真实
    上游，四种入口协议 × 流式/非流式全部打通，发现并修复 1 个跨协议 bug：
    **Anthropic 入口的 `content` 为纯字符串时被解析成空 parts**。Anthropic 规范
    允许 `messages[].content` 直接是字符串（单轮纯文本最常见写法），而
    `decodeRequest` 用 `asArray(content)` 遍历——`asArray` 对字符串返回 `[]`，
    于是消息变成 `parts: []`，转给 responses 上游后 `input: [{content: []}]`，
    被对方以「消息内容为空」400 拒绝。已在 `anthropic.ts` 补字符串分支，并加
    回归测试（含 encode 到 responses 的端到端断言）。
  - **对标 sub2api**：新增 `docs/llm-gateway-vs-sub2api.md`（逐功能、带源码证据）。
    结论是**未追平**：定位不同（订阅额度分发 vs API Key 中转）、规模差一个量级
    （3,040 Go 文件 vs 66 TS 文件；1,611 测试文件 vs 23）、且我们零真实上游 e2e。
    识别出同定位下的 P0 真缺口：**粘性会话、TPM 限流、上游出口代理池**。
  - **7 语言接线（D3）**：内核界面语言从 4 个扩到 7 个（新增 `ja-JP` / `ko-KR` /
    `fr-FR`），插件 `frontend.locales` 与 7 份 catalog 同步声明。
    **覆盖度要说清楚**：内核三份新 catalog 现在只翻译了 `nav` / `common` / `locale`
    分组（共 58 键），其余键在文件内**以英文兜底**（不是运行时回退，避免「日语界面
    里冒出中文」）；插件新 catalog 翻译了 `nav` / `common` / `admin.playground`
    （52 键），其余同样是英文兜底。后续按分组续译，键集合已由
    `check-package-catalogs` 守住（各国键集必须一致）。
  - **管理端 Playground（D1）**：`POST /llm-gateway/admin/playground` +
    管理端「试用台」页面（`admin/playground`，导航 order 5）。服务端选号、占用账号
    并发位、直连上游非流式，返回文本/用量/耗时/命中账号。**不扣用户钱包、不写用量
    流水**——它是运营排查工具，做成计费路径会让「替用户排查」花用户的钱、并让测试
    流量污染对账。也不走账号改写：Playground 要看到上游原始行为。
  - 前端构建支持**单包重建**：内核 `scripts/build-frontend.mjs` 新增
    `STACKPANEL_FRONTEND_ONLY=plugins/llm-gateway`，只编译指定包并跳过 registry 生成
    （全量构建行为不变）。此前改一个插件的 admin bundle 会重写所有包的 dist 与 `data/`。
  - **OpenAI Videos 兼容面**：`POST|GET /llm-gateway/v1/videos`、
    `GET /llm-gateway/v1/videos/:id`、`GET /llm-gateway/v1/videos/:id/content`、
    `DELETE /llm-gateway/v1/videos/:id`。**投影**自任务框架（不新写一套任务存储）：
    状态四态映射、`progress` 只给 0/50/100、失败原因用固定文案不透传上游原文。
    `input_reference` 收 URL 而非 multipart（网关不做文件上传中转）；`seconds`/`size`
    按描述翻译成 `duration`/`aspectRatio`（可灵）。`/content` 用 key 鉴权、复用产物
    下载的背压与 SSRF 路径，未完成的任务返 409。
  - `artifacts.ts` 拆出 `streamArtifactBytes`（签名链接与 key 鉴权两条入口共用同一段
    下载实现，避免第二份实现漂移）。
  - **Gemini OpenAI 兼容入口**：`matchIngress` 把 `v1beta/openai/*` 剥前缀归一化成
    `v1/*`，客户端把 baseUrl 配成 `<网关>/v1beta/openai` 不再 501。
  - 观测新增指标 `upstream.status_mapped`（20 个）。
  - 新增 27 条界面文案（zh-CN 为源，zh-TW/zh-HK 由 `i18n-hant.mjs` 派生，4 语言共 297 键）。
  - 单测新增 106 条（`tasks.test.ts` / `artifacts.test.ts` / `rewrite.test.ts` /
    `custom-route.test.ts` / `diagnostics.test.ts` / `observability.test.ts` /
    `sensitive.test.ts` / `openai-videos.test.ts`），共 324 条通过；协议包 16 条。
  - 修正：插件 manifest 里的 `version` 自 0.1.0 起未随发布更新，现与 npm 包版本一致。

- `llm-gateway` 0.3.0：套餐额度、表达式计费、预算限额、模型映射、对账单、公开价目。

  - **套餐额度**：新增 `llm-gateway/entitlement` 模型与商品类型 `api_token`
    （`EXTENSION_POINTS.productType`）。商店卖出额度包后由本插件履约，
    结算时优先抵扣套餐、差额再扣钱包（部分覆盖也支持）。
  - **表达式计费**：定价行新增 `strategy`（flat/tiered/expr）与 `expr`。
    表达式只支持 `+ - * /`、括号与白名单变量/函数（无任意代码执行），
    结果即 minor 金额；写入时编译校验，编译失败自动回落固定单价。
  - **预算限额**：新增 `llm-gateway/budget-limit` 模型（日/月、软提醒/硬拒绝），
    结算累加 Redis 计数器，达阈值发通知（每周期每档一次）。
  - **模型映射**：新增 `llm-gateway/model-map` 模型（exact/prefix/regex +
    权重分流 + 优先级），实际转发模型写入用量流水 `upstreamModel`。
  - **对账单**：`/admin/statements`（按用户/模型聚合）+ CSV 导出，
    用户端 `/llm-gateway/statement`；金额一律取流水快照。
  - **公开价目**：`/llm-gateway/public/prices`（`auth: 'optional'`），
    匿名可读、登录后叠加权限组折扣。
  - **管理端**：价格编辑器支持计费模式与表达式；新增「运营」页
    （映射/限额/权益）。

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
