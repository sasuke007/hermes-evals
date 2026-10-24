import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Fails the run at once without python3 (verifiers), instead of skipping or misleading.
    globalSetup: ['./test/support/require-python.ts'],
    // Each spec creates its own Postgres 17 database and migrates it.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
