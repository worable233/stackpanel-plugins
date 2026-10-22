# 易支付（epay）

`epay`（`0.3.1`）实现内核 `payment.provider`，为钱包充值和订单结算提供易支付网关。它只接受 CNY；内核负责在创建付款前处理结算币种和订单状态。

## 配置与安全

管理员配置包含 `baseUrl`、商户 `pid`、商户 RSA 私钥、平台 RSA 公钥和启用的 `alipay`、`wxpay`、`qqpay` 方法。配置优先从内核绑定的 `payment_method` 获取，旧实例才回退到插件密钥存储。

- `baseUrl` 会进行公开网关地址校验。
- 私钥和平台公钥只进入受管配置或 `ctx.secrets`，不能下发到前端。
- 回调只接受验签成功、`pid` 匹配且 `trade_status=TRADE_SUCCESS` 的请求。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/epay/admin/config` | admin + `epay.admin` | 获取脱敏状态和已启用支付方式。 |
| POST | `/epay/admin/config` | admin + `epay.admin` | 保存网关配置。 |
| GET | `/callbacks/epay` | public | 易支付异步回调；插件校验 RSA 签名后调用内核结算。 |

## 扩展方式

支付插件不应由业务代码直接调用 `epay` 路由来创建付款。商店和钱包应消费内核支付服务，内核再按已启用方法调用 `payment.provider`。`epay` 没有 Capability；回调路由也不应暴露到 MCP 或 Agent。
