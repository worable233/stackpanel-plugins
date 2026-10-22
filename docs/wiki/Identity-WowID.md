# WowID 登录（wowid）

`wowid` 是 OpenID Connect 认证提供者插件。激活时配置完整才会注册 `auth.provider`；配置缺失时插件保持激活但不会向内核提供登录方式。

## 配置

生产环境至少需要：

- `WOWID_ISSUER`
- `WOWID_CLIENT_ID`
- `WOWID_REDIRECT_URI`

可选覆盖端点：`WOWID_AUTHORIZE_URL`、`WOWID_TOKEN_URL`、`WOWID_USERINFO_URL`、`WOWID_JWKS_URL`；客户端密钥使用 `WOWID_CLIENT_SECRET`。生产环境的 issuer 和端点必须为 HTTPS，回调地址也必须为 HTTPS 且不含账号、查询参数或 hash。

`WOWID_MOCK=true` 仅用于测试；不要在生产实例启用。

## 协议行为

- 使用 OAuth 2.0 授权码流程和 PKCE。
- 验证 code verifier、nonce、`id_token`、issuer、audience 与 JWK。
- token 交换有 10 秒请求超时。
- 认证插件向内核提供身份对象，内核负责会话和本地账户关联。

## 扩展边界

本插件不声明自己的管理路由、Capability 或 MCP 工具。集成方应通过内核的认证流程进入 WowID，不应直接调用或复制插件内部的 token 交换逻辑。
