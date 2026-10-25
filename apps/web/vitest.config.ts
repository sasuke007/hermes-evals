import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // Component tests run on fixtures; a test that needs live mode stubs VITE_API_MODE.
      env: { VITE_API_MODE: 'fixtures' },
      // A page test's first mount compiles the page and its lazy routes, which takes seconds
      // when the whole repository's tests run at once (turbo runs the api's alongside).
      testTimeout: 20_000,
      environmentOptions: { jsdom: { url: 'http://localhost:5173/' } },
      exclude: [...configDefaults.exclude, 'e2e/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
);
