import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminServer } from '../src/admin.js';
import { envNames } from '../src/env-names.js';
import { Registry } from '../src/registry.js';

const SECRET = 'vendor-secret-value-1234';

/** An environment the way docker compose gives it, with an http MCP header value from .env. */
const env: NodeJS.ProcessEnv = {
  VENDOR_API_TOKEN: SECRET,
  OPENROUTER_API_KEY: 'sk-or-value',
  PATH: '/usr/local/bin:/usr/bin',
  _UNDERSCORE_FIRST: 'x',
  // Set but empty: nothing to put in a header, so not set.
  EMPTY_TOKEN: '',
  // Not names a definition can reference.
  http_proxy: 'http://proxy:3128',
  'npm_config_user-agent': 'pnpm',
  '1STARTS_WITH_DIGIT': 'x',
};

describe('envNames', () => {
  it('returns the sorted valid names with a value, and no value', () => {
    expect(envNames(env)).toEqual([
      'OPENROUTER_API_KEY',
      'PATH',
      'VENDOR_API_TOKEN',
      '_UNDERSCORE_FIRST',
    ]);
    expect(envNames({})).toEqual([]);
  });
});

describe('GET /env-names on the admin socket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-env-'));
  const socket = join(dir, 'admin.sock');
  let current: NodeJS.ProcessEnv = env;
  const admin = createAdminServer(new Registry(), { env: () => current });

  beforeAll(() => new Promise<void>((resolve) => admin.listen(socket, resolve)));
  afterAll(() => {
    admin.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (method: string, path: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ socketPath: socket, method, path });
      req.on('response', (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject);
      req.end();
    });

  it('answers the names, never a value', async () => {
    const res = await get('GET', '/env-names');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      names: ['OPENROUTER_API_KEY', 'PATH', 'VENDOR_API_TOKEN', '_UNDERSCORE_FIRST'],
    });
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain('sk-or-value');
  });

  it('reads the environment on every request', async () => {
    current = { ...env, NEW_HEADER_TOKEN: 'y' };
    expect(JSON.parse((await get('GET', '/env-names')).text).names).toContain('NEW_HEADER_TOKEN');
    current = env;
  });

  it('serves only GET', async () => {
    expect((await get('POST', '/env-names')).status).toBe(404);
    expect((await get('GET', '/env-names/VENDOR_API_TOKEN')).status).toBe(404);
  });
});
