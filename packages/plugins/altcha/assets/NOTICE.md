# 随包分发的第三方代码

## `altcha.min.js`

- 来源：npm 包 [`altcha`](https://www.npmjs.com/package/altcha) 3.5.0，
  文件 `dist/main/altcha.min.js`
- 许可：MIT（全文见同目录 `LICENSE.txt`），上游 <https://altcha.org>
- sha256（前 32 位）：`6ff22c1f1446229019528f00da97d5a8`
- 大小：118907 字节

### 为什么随包分发而不是用 CDN

控件的 challenge 校验完全在本插件内完成（`src/challenge.ts`），没有任何外部服务；
此时再让浏览器去公网 CDN 取脚本，就为了一个本地能力引入了一个外部依赖和单点故障，
而且国内网络对常见 CDN 并不稳定。随包分发后：

- 脚本由插件自己的路由（`GET /altcha/widget.js`）吐出，浏览器经内核的同源 BFF
  `GET /api/plugins/altcha/widget.js` 取到 —— **同源、无 CORS、无需放宽 CSP**；
- 版本与插件版本绑死，升级插件即升级控件，不会被上游静默改掉行为。

### 升级方法

```bash
npm pack altcha@<version>            # 取新版本
tar xf altcha-<version>.tgz
cp package/dist/main/altcha.min.js assets/altcha.min.js
cp package/LICENSE.txt assets/LICENSE.txt
node scripts/embed-widget.mjs         # 重新内联为 src/widget-asset.ts
```

同时更新本文件的版本号与 sha256。
