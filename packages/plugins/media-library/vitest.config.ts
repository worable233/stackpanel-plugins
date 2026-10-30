export default {
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'kernel-tests/**'],
    passWithNoTests: true,
  },
};
