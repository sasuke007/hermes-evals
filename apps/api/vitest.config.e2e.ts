import { defineConfig } from 'vitest/config';
import { e2eWorkers, serverMaxConnections } from './test/support/e2e-workers.js';

export default defineConfig(async () => {
  // Each spec boots Nest apps whose app and pg-boss pools hold up to 10
  // connections each; the busiest file peaks at about 36. The number of
  // files at once follows the throwaway server's max_connections (2 on the
  // default 100, 4 with `-c max_connections=200`): uncapped, or at 4 on a
  // 100-connection server, the run hits "too many clients already"
  // (test/support/e2e-workers.ts).
  const maxConnections = await serverMaxConnections(process.env.TEST_DATABASE_URL?.trim());
  const maxWorkers = e2eWorkers(maxConnections);
  console.info(
    `e2e: ${maxWorkers} files at a time (max_connections ${maxConnections ?? 'unknown'})`,
  );
  return {
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
      maxWorkers,
    },
  };
});
