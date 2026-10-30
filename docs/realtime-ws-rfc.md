# RFC：Realtime / WebSocket 转发通道（C6）

> 状态：**待内核评审**（本文是 llm-gateway 的输入，不是最终内核设计）
> 影响面：`packages/sdk`（路由类型）、`apps/api`（dispatcher）、`apps/web`（代理）
> 结论先行：**不要**在插件里自己起 WebSocket 服务器；需要内核提供 upgrade 通道，
> 而且客户端能直连内核进程是前提。

## 1. 为什么网关需要它

三家主流实时语音/多模态接口都是长连接：

| 上游 | 协议 | 端点形态 |
| --- | --- | --- |
| OpenAI Realtime | WebSocket | `wss://api.openai.com/v1/realtime?model=...` |
| Gemini Live | WebSocket | `wss://generativelanguage.googleapis.com/ws/...` |
| Anthropic（暂缺） | — | 目前仍为 SSE，不需要 |

现在 llm-gateway 对这类请求只能返回 `501 unimplemented`（endpoint registry 里没有
`realtime` 端点，未知端点一律 501）。对手（new-api / one-api 系）同样不支持或只做
「把 key 交给前端直连」的降级方案，这正是我们可以拉开差距的地方——但前提是先解决
通道问题。

## 2. 内核现状（已核对代码，不是猜测）

| 事实 | 位置 |
| --- | --- |
| 插件路由只有 `kind: 'handler'`（JSON）与 `kind: 'raw'`（原生 req/res 流） | `packages/sdk/src/plugin.ts:445-486` |
| raw 路由给的是 `IncomingMessage` + `ServerResponse`，**没有 socket** | 同上 `RawRouteHandler` |
| API 侧统一由 `PluginDispatcher` 按「字面段更多者优先」匹配后调用 | `apps/api/src/plugins/dispatcher.ts` |
| API 服务器是 Fastify，**当前没有任何 websocket 插件** | `apps/api/package.json` |
| 插件 raw 路由的鉴权在 HTTP 层完成（`auth: 'optional'` 也能拿到 `req.user`） | `dispatcher.ts` `runGuards` |

也就是说：插件拿不到 `upgrade` 事件，拿不到 `socket`，因此**无论写多少代码都无法
自己完成 WS 握手**。这正是 C6 只能等内核的原因。

## 3. 三条可选路径

### A. 内核提供 `kind: 'upgrade'` 路由（推荐）

SDK 增加：

```ts
export interface UpgradePluginRoute extends PluginRouteBase {
  kind: 'upgrade';
  /** 握手前调用：可拒绝（返回错误即断开），可改写目标头/URL。 */
  authorize(input: UpgradeRequest): Promise<UpgradeDecision>;
  /** 握手后：双向转发。内核负责背压与关闭传播。 */
  handler(session: UpgradeSession): Promise<void>;
}
```

内核侧需要：

1. `apps/api` 装 `@fastify/websocket`（或直接用 `server.on('upgrade')`），把
   `/{pluginId}/*` 的 upgrade 事件交给 dispatcher——**必须复用现有的字面段优先匹配**，
   否则 `/llm-gateway/*` 的 raw 兜底会把 upgrade 抢走。
2. 鉴权在**握手前**完成：WS 客户端不能自定义 `Sec-WebSocket-*` 之外的头很常见，
   实际做法是支持 `?key=...` 或 `Sec-WebSocket-Protocol` 携带凭证，并由
   `auth: 'optional'` 的解析器复用现有 `resolveGatewayKey`。
3. `UpgradeSession` 暴露 `message`/`close`/`send(data)` 与 `readyState`，**不**暴露
   原始 socket：插件不该能改 TCP 行为。
4. 连接数计入现有并发租约（`Scheduler`），断线释放。
5. 关闭传播：客户端断开 → 打开的上游 socket 必须一起关（否则上游按连接计费持续跑）。

### B. SSE 双工垫片（不推荐）

把客户端的长连接改成「POST 发帧 / SSE 收帧」。能跑通，但：

- 与上游协议不再一一对应，需要为每家写适配；
- 语音场景对延迟敏感，双连接 + 帧化会明显劣化；
- 每帧都要过一次 HTTP 层，无法利用 WS 的 `permessage-deflate`。

只有在「客户端完全不能直连」时才考虑。

### C. 客户端直连上游 + 短时凭证（兜底）

网关签发一个短时（≤60s）的一次性凭证，客户端拿它直连上游。问题很硬：

- **上游 key 必须交给客户端**，只能靠短时 + 域名白名单限制，泄露面仍然存在；
- 用量在客户端产生，网关只能事后对账，**无法在链路上计量与限额**；
- 与「网关是唯一出口」的产品承诺冲突。

结论：可以作为「明确告知风险」的企业自建选项，不能作为默认。

## 4. 推荐方案（A）的插件侧设计

一旦内核提供 `kind: 'upgrade'`，llm-gateway 侧改动很小，因为大部分基础件已就位：

1. **endpoint registry** 增加 `realtime` 端点的 ingress 匹配（`/v1/realtime`），
   `spec.responseKind = 'duplex'`；
2. **`authorize`**：复用 `resolveGatewayKey` + 模型白名单 + 预算检查（`checkBudget`）
   + 并发租约；决策里带上选中的账号与上游 URL（含凭证注入在插件侧完成，客户端
   永远看不到 key）；
3. **计费**：实时请求没有「一次性的 usage」。方案是
   - 连接建立时按「预留 1 分钟音频秒数」冻结（复用 `reserve` + 价目快照）；
   - 每收到一个上游 `usage` 事件（OpenAI Realtime 会周期性上报）调用一次
     `settle` 增量，或按分钟滚动结算；
   - 断开时做最后一次结算并把剩余冻结释放——与异步任务（C1）的 `release` 路径一致，
     不需要新的资金原语。
4. **审计**：连接建立/关闭/异常关闭各写一条 `auth.audit`，
   `meta` 里只放账号 id、模型、帧数、时长，**不放音频或转写内容**。
5. **超时**：WS 不应套用 HTTP 的 60s 超时，用「心跳 + 空闲超时」（例如 5 分钟无帧
   视为空闲）。

## 5. 安全要点（评审时请重点看这几条）

- **凭证不得回显**：握手响应里不能带上游 URL 或 key；错误信息也不带。
- **协议子协议透传**：`Sec-WebSocket-Protocol` 要按上游需要转发，但不能把客户端头
  整体透传（避免 `Origin` 欺骗与自定义头泄漏）。
- **SSRF**：WS 目标同样要过 `isAllowedUpstreamUrl`（生产环境）。
- **每连接一次预算检查**，防止「开 1000 条连接但每条只发 1 帧」把并发打满。
- **背压**：内核必须实现「上游缓冲 > N 字节时暂停读取客户端」，否则慢客户端能把
  网关内存吃光——这是 raw 路由当年就踩过的坑。

## 6. 测试计划

1. 内核：`upgrade` 路由匹配优先级（raw 兜底不得吞掉它）、握手鉴权失败返回 401 而非
   101、断开传播（客户端断开后上游 socket closed）、并发计数正确归零。
2. 插件：`authorize` 的模型/预算/并发拒绝路径；断开时冻结被正确释放；每帧计费单调
   递增；审计条数与连接生命周期一致。
3. 端到端：一个本地 WS echo 上游 + 真 OpenAI Realtime key（如需）。

## 7. 若不做的后果

`/v1/realtime` 继续返回 `501`，并在端点目录里如实标注「不支持」。这比「看似支持但
凭证泄漏或无法计量」要诚实得多——现有 `501` 行为本身就是刻意的设计（未知端点不猜）。
