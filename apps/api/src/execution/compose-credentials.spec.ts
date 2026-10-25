/**
 * Provider keys stay in egress (Phase 3 S2): docker-compose.yml loads `.env`
 * into the api and the worker for their settings and stdio MCP values, so it
 * must blank every key a provider route names there. A verifier script runs
 * as the worker's uid and could otherwise read a key from /proc/1/environ.
 * The list is checked against PROVIDER_ROUTES, so a new provider's key cannot
 * be left out.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PROVIDER_ROUTES } from './providers-map.js';

const COMPOSE = fileURLToPath(new URL('../../../../docker-compose.yml', import.meta.url));

interface ComposeFile {
  services: Record<string, { env_file?: unknown; environment?: Record<string, unknown> }>;
}

const KEY_NAMES = [
  ...new Set(
    Object.values(PROVIDER_ROUTES).flatMap((route) => (route.apiKeyEnv ? [route.apiKeyEnv] : [])),
  ),
].sort();

describe('docker-compose.yml provider keys', () => {
  it('blanks every provider key in the api and the worker, and leaves them to egress', async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    expect(KEY_NAMES).toEqual([
      'ANTHROPIC_API_KEY',
      'CUSTOM_API_KEY',
      'NOUS_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
    for (const name of ['api', 'worker']) {
      const service = compose.services[name]!;
      // They load .env, which is where the keys are written.
      expect(service.env_file).toBeDefined();
      for (const key of KEY_NAMES)
        expect([name, key, service.environment?.[key]]).toEqual([name, key, '']);
    }
    const egress = compose.services.egress!;
    for (const key of KEY_NAMES) expect(egress.environment?.[key]).toBeUndefined();
  });
});
