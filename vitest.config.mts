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
    // Shared machine (other heavy jobs, verify at below-normal priority): the long seeded
    // behaviour simulations (multi-sim-hour liveness and mix runs, 5-10 s each alone) slow down
    // several-fold when every core runs one. Half the cores keeps them responsive; the timeout
    // is only a hang guard, never an assertion.
    maxWorkers: '50%',
    testTimeout: 60000,
    restoreMocks: true,
  },
});
