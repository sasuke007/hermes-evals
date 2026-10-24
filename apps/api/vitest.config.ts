import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Fails the run at once without python3 (verifiers), instead of skipping or misleading.
    globalSetup: ['./test/support/require-python.ts'],
    // Most specs boot PGlite and apply every migration, about a second alone
    // but several when `pnpm test` runs every package at once; the 5 s
    // default then fails tests that are only slow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
