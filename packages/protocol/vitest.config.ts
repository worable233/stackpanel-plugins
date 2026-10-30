/**
 * 协议包是纯函数库：无 IO、无内核依赖，单测可以直接跑。
 *
 * 刻意不 `import { defineConfig } from 'vitest/config'`：本包与插件包共享内核
 * 提供的 node_modules 解析链，从包目录解析不到 vitest 时，配置文件加载会直接报错。
 */
export default {
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
};
