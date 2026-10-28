import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEV__: 'true',
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20000,
    restoreMocks: true,
  },
});
