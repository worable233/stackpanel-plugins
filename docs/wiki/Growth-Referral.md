# 推广（referral）

`referral` 依赖 `store`，维护推广码、注册归因、奖励记录和冻结解冻流程。它监听注册和订单支付事件，并使用内核任务周期处理到期的冻结奖励。

## 依赖与权限

- 版本：`0.1.0`；要求 `store ^0.3.0`。
- 用户权限：`store.referral`，用于自己的推广中心。
- 管理权限：复用 `store.admin`，不重复声明商店权限。
- 自定义模型：推广码、推广记录和推广配置。

## 路由

| 方法 | 路径 | 身份与权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/referral/me` | user + `store.referral` | 当前用户的推广信息和奖励。 |
| POST | `/referral/codes` | user + `store.referral` | 创建推广码。 |
| PATCH | `/referral/codes/:id` | user + `store.referral` | 更新自己的推广码。 |
| GET | `/store/admin/referrals` | admin + `store.admin` | 管理推广记录。 |
| GET/POST | `/store/admin/referrals/config` | admin + `store.admin` | 读取和保存推广规则。 |
| POST | `/store/admin/referrals/adjustments` | admin + `store.admin` | 创建管理员调整。 |

## 事件与边界

插件监听注册归因和 `order.paid`，但奖励计算、归因与解冻都必须经过插件自身业务规则。第三方集成不应伪造事件或直接写奖励模型。当前没有 Capability；自动化推广操作需要先定义调用者可见范围、金额幂等和审批语义。
