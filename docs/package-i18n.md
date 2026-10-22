# 插件前端多语言约定

本仓库的插件前端统一支持四种语言：

| locale  | 角色                             |
| ------- | -------------------------------- |
| `zh-CN` | **唯一手写源**，所有文案先写这里 |
| `en-US` | 手写                             |
| `zh-TW` | 由 `zh-CN` 派生（OpenCC `cn→twp`）|
| `zh-HK` | 由 `zh-TW` 派生 + 香港词汇覆盖   |

`zh-TW` / `zh-HK` 是**生成产物**，不要手改——下一次运行生成脚本会被覆盖。

## 目录结构

```
packages/plugins/<id>/frontend/
  messages/zh-CN.json   # 扁平 key -> 文案，唯一手写源
  messages/en-US.json
  messages/zh-TW.json   # 生成
  messages/zh-HK.json   # 生成
  src/i18n.ts           # 导出 messages 与 t(locale)
  manifest.json         # 构建产物，含 locales + 序列化 messages
```

`src/i18n.ts` 模板：

```ts
import { createPackageTranslator } from '@stackpanel/sdk';
import enUS from '../messages/en-US.json';
import zhCN from '../messages/zh-CN.json';
import zhHK from '../messages/zh-HK.json';
import zhTW from '../messages/zh-TW.json';

export const messages = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
} as const;

export const t = (locale?: string) =>
  createPackageTranslator(locale, messages, ['zh-CN']);
```

包对象上要同时挂 `locales` 与 `messages`：

```ts
export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'en-US', 'zh-TW', 'zh-HK'],
  messages,
  // …
};
```

## 写文案的规则

- key 用扁平点分 id + `lowerCamel` 段：`page.title`、`cart.empty`、
  `checkout.total`。不要中文、不要空格。
- 四种语言的 **key 集合必须完全一致**，占位符集合也必须一致。
- 占位符只用 `{name}`；不要在文案里拼数字或货币，交给 `Intl` 与
  `formatMinorCurrency(amount, currency, locale)`。
- 日期/数字显式传 locale：`new Intl.DateTimeFormat(locale, opts)`；
  不要出现裸 `toLocaleString()` 或写死 `'zh-CN'`。
- props 的 `locale` 可选，兜底用 SDK 的 `PACKAGE_FALLBACK_LOCALE`。

## 元数据本地化

manifest 级文案与设置 schema 用 key，而不是字面量：

```ts
nav: { labelKey: 'nav.overview', groupKey: 'nav.groupFinance', order: 0 }
systemSettings: { labelKey: 'admin.systemSettings', order: 100 }
accountWidgets: [{ id, titleKey: 'widget.title', component, permission }]
```

设置 schema 的 `label` / `help` / `placeholder` / `options[].label` 同理，
使用 `labelKey` / `helpKey` / `placeholderKey` / `options[].labelKey`。
宿主会在服务端把它们解析成文案再交给客户端表单。

动作反馈的 `successFeedback` 支持 `messageKey`（宿主按请求 locale 解析）；
`message` 只作为字面量兜底，二者至少给一个。

**每个写操作 action（`POST`/`PATCH`/`DELETE`）必须恰好声明 `successFeedback`
或 `silent: true` 之一**：

| 声明 | 宿主行为 | 何时用 |
| --- | --- | --- |
| `successFeedback` | 成功后弹一条 toast（`messageKey` 优先，`message` 兜底；`params` 把响应里的数字插进 `{name}`） | 无其它成功信号，需要明确回执 |
| `silent: true` | 不加任何 toast | 包自己负责回执：内联结果、`redirect` 跳转、或包自己 `toast()` |

两者都缺会让用户点完不知道成功没有；两者都给会弹重复提示。

枚举状态开关（`ACTIVE`/`published` 之类）建议 `silent`：新状态在界面上已经可见，
只在**失败**时提示即可（见内核守门测试 `feedback-success-feedback.test.ts`）。

数据枚举值（`'ACTIVE'`、`'register'`、模型 id 等）**不能**改值，
用映射表在渲染时翻译：

```ts
const STATE_KEYS: Record<string, string> = { ACTIVE: 'state.active' };
{STATE_KEYS[value] ? tr(STATE_KEYS[value]!) : value}
```

## 命令

```bash
# 校验目录：key 一致 / 占位符一致 / manifest key 引用存在 / locales 与文件一致
pnpm i18n:packages

# 由 zh-CN 重新生成 zh-TW、zh-HK
pnpm i18n:hant

# 只检查繁体目录是否与 zh-CN 同步（CI 用）
pnpm i18n:hant:check

# 两者一起跑
pnpm i18n:check
```

繁体生成脚本里的 `VALID_TRADITIONAL` 是允许保留的简体字白名单
（`台/游/准/后/里/干/面/只/系` 等合法繁体异体），加词条前先确认是异体而非漏转。

## 改完文案之后

`frontend/manifest.json` 是提交物，`dist/` 不是。manifest 由内核的构建脚本生成
（esbuild 打包 + 序列化 `messages` + 计算 revision），在本仓库无法独立运行：

```bash
# 在内核仓库根目录执行
STACKPANEL_PLUGIN_SOURCES=/Users/<you>/Documents/StackPanel-plugins/packages/plugins \
  node scripts/build-frontend.mjs
```

它会重写每个插件的 `frontend/dist/` 与 `frontend/manifest.json`。
改完文案不重建 manifest，宿主拿到的仍是旧目录。

## 提交前检查清单

1. `pnpm i18n:hant` 已重新生成 `zh-TW` / `zh-HK`；
2. `pnpm i18n:check` 通过；
3. `frontend/manifest.json` 已重建，`locales` 含四语；
4. `src/` 里没有残留的中文字面量（`grep -P '[\x{4e00}-\x{9fff}]'` 自查，
   数据匹配用的正则除外）。
