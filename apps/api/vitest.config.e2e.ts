import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Fails the run at once without python3 (verifiers), or without the test
    // database (every file would skip and the run read as green), instead of
    // skipping or misleading.
    globalSetup: ['./test/support/require-python.ts', './test/support/require-database.ts'],
    // Each spec creates its own Postgres 17 database and migrates it.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each spec boots Nest apps whose app and pg-boss pools hold up to 20
    // connections each, and the throwaway server allows max_connections=100.
    // Four files at a time peak at about 70 connections, which leaves room
    // for a psql session or a second client; uncapped, the file count follows
    // the CPU count and has hit "too many clients already".
    maxWorkers: 4,
  },
});
