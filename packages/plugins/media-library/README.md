# 媒体库（media-library）

管理后台的附件控制台：跨用户浏览 / 预览 / 删除内核附件，切换公开可见性，并在
图片管线故障后重建缩略图。

## 为什么是一个插件，而不是内核页面

ADR-0014 把附件域划给内核（存储、嗅探、变体、引用完整性），但「谁来做控制台」
没有被决策。控制器属于运营界面，按 ADR-0008 的插件自治原则放这里，内核只多出
三条只读/修复端点：

| 内核端点 | 用途 |
| --- | --- |
| `GET /media/admin/attachments` | 跨用户过滤分页（visibility / kind / q / ownerId） |
| `GET /media/admin/stats` | 聚合计数 + 编码器健康探测 |
| `POST /media/admin/variants/rebuild` | 把终态 `failed` 的变体重排（无此修复，编码器修好后旧图仍是坏的） |
| `POST /media/admin/optimize` | 存量图片转 WebP（图形无损 / 照片有损，变小才换），控制台按钮「无损转 WebP」 |

## 桥接方式（重要）

本插件**不碰** Prisma、存储驱动和图片策略。它的路由把请求转发到内核自身的
`/media/*`，并带上**调用者自己的 session token**：

```
浏览器 → /api/plugins/media-library/items?…  (同源 BFF)
      → 插件路由 (auth: admin, permission: platform.admin)
      → http://API_HOST:API_PORT/media/admin/…  (Bearer 调用者 token)
```

这样只有一条授权链：控制台能做的事不会超过打开它的管理员，插件 bug 也无法放大
权限。代价是每个调用多一次 loopback 往返（本进程树内）。

缩略图必须走 `GET /media-library/items/:id/content?variant=thumb` 的 raw 流式代理：
浏览器同源 BFF 只放行插件路径，不能直接指向内核的 `/media/:id/content`。

代理会把 `variant` 和内容版本号 `v` 原样透传，并把内核回来的 `ETag` / `Cache-Control`
转发出去；控制台自己给图片 URL 拼 `&v=<rev>`，所以点完「无损转 WebP」后的图不会再被浏览器
里转换前的缓存挡住——而**旧链接（无 `v` 或 `v` 过期）依旧可用**，只是每次回源校验。

## 安装 / 开发

```bash
# 1) 在插件仓编译后端 bundle，并装进内核 data/plugins/
cd packages/plugins/media-library
pnpm build
node ../../../scripts/install-into-kernel.mjs --kernel /path/to/StackPanel-main

# 2) 在内核仓把前端编译进 data/plugins/media-library/frontend
cd /path/to/StackPanel-main
STACKPANEL_PLUGIN_SOURCES=/path/to/StackPanel-plugins/packages/plugins pnpm build:frontend

# 3) 启用（隔离插件在 API 启动时挂路由，所以启用后要重启 dev/服务）
#    管理后台 → 系统 → 插件管理 → 启用「媒体库」
```

两个容易卡住的细节：

- **`install-into-kernel.mjs` 没有 `--plugin` 参数**，它以内核「插件包 = 当前工作目录」
  为约定，`--kernel` 指向内核检出即可。
- **前端只有在 `frontend/dist` 缺失或源变了才会重编译**；`install` 复制过的旧产物会
  让构建跳过本包，改了 `frontend/src` 后先 `rm -rf` 掉
  `data/plugins/media-library/frontend`（以及本包源里的 `frontend/dist`、
  `frontend/manifest.json`）再跑一次。
- 若 `STACKPANEL_PLUGIN_SOURCES` 目录里另有插件当前编译失败（跨仓版本漂移，例如
  某插件引用了内核尚未提供的导出），整个脚本会在那个包上中断。此时把源根缩小到只有
  本包——注意发现逻辑不跟随软链目录，要用「真实目录 + 里面软链 `frontend`」：

  ```bash
  rm -rf /tmp/sp-plugin-src && mkdir -p /tmp/sp-plugin-src/media-library
  ln -s "$PWD/packages/plugins/media-library/frontend" /tmp/sp-plugin-src/media-library/frontend
  cd /path/to/StackPanel-main && STACKPANEL_PLUGIN_SOURCES=/tmp/sp-plugin-src pnpm build:frontend
  ```

后台入口：**管理后台 → 内容 → 媒体库**（`/admin/plugin/media-library/library`）。
侧边栏分组复用 cms 的 `nav.group` 键，所以两者合并进同一个「内容」组。

## 校验

```bash
pnpm exec tsc -p tsconfig.json    # 含测试文件
pnpm exec vitest run              # 桥接路由 + 词条对齐
```

