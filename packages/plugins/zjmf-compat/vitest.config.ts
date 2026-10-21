/**
 * 插件仓单测只覆盖 `src/`。
 *
 * `kernel-tests/` 是内核侧夹具：它们 import 内核的 `../../src/app.ts`，
 * 在插件仓无法解析。之前 `pnpm test` 默认把它们一起跑，开箱即红（审计 #2 · F-4）。
 * 这些用例应交给内核仓执行，这里显式排除。
 *
 * 刻意不 `import { defineConfig } from 'vitest/config'`：插件仓的 node_modules
 * 可能是内核共享链的软链，从插件目录解析不到 vitest 包，会让配置加载直接报错。
 *
 * `passWithNoTests`：有些插件（如 ticket）只有内核侧 kernel-tests、没有 src 单测，
 * 排除后应视为「无事可做」而不是失败。
 */
export default {
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'kernel-tests/**'],
    passWithNoTests: true,
  },
};
