import { defineConfig } from 'tsup';

/**
 * 前端产物按插件分发：`dist/` 里的模块由内核在运行时加载，所以宿主依赖
 * （react / next / @stackpanel/*）必须保持 external —— 一旦被打进 bundle，
 * 同一份 React 会出现两个实例，hooks 直接炸。
 *
 * external 由源码里的实际 import 推导。旧脚本手写的那份列表已经漂移过一次：
 * 漏掉 `@stackpanel/ui` 让 referral 构建失败。这里保留**原始说明符**而不是
 * 包名，因为 esbuild 按字符串精确匹配，`next` 匹配不到 `next/link`。
 *
 * JSX 用 `automatic` 运行时。tsup 的 CLI 没有对应开关（只有 --jsxFactory /
 * --jsxFragment），只能在这里交给 esbuild —— 这就是原脚本里 `--jsx automatic`
 * 从未生效、构建从来没跑通的原因。
 */
export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'neutral',
  clean: true,
  external: [
    '@dnd-kit/core',
    '@stackpanel/sdk',
    '@stackpanel/ui',
    'emoji-picker-react',
    'lucide-react',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'zod',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
