/**
 * `@stackpanel/llm-protocol` 的公开入口。
 *
 * 只做再导出，不含逻辑：这个包的价值在于「线协议与 IR 不属于网关」——任何要把
 * 上游方言换成统一中间表示的东西（网关、模型代理插件、诊断工具）都能复用，
 * 而不必把网关整个装进来。
 *
 * 分层：
 * - `protocol.ts`：IR 类型 + 无状态的规范化助手（`textOf`、`asString`…）
 * - `codecs/`：各家协议 ↔ IR 的编解码器（chat / responses / anthropic / gemini）
 */
export * from './protocol.js';
export * from './codecs/types.js';
export * from './codecs/index.js';
