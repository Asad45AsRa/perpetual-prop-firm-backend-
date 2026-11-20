import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Database tests (tests/integration) run only when RUN_DB_TESTS=1 (see tests/integration/README.md)
    exclude: process.env.RUN_DB_TESTS === '1' ? ['node_modules/**'] : ['node_modules/**', 'tests/integration/**'],
    // The database tests share one database: run files one after another
    fileParallelism: process.env.RUN_DB_TESTS !== '1',
  },
});
