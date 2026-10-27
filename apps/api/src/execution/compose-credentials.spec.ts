/**
 * Provider keys stay in egress (Phase 3 S2): docker-compose.yml loads `.env`
 * into the api and the worker for their settings and stdio MCP values, so it
 * must blank every key a provider route names there. A verifier script runs
 * as the worker's uid and could otherwise read a key from /proc/1/environ.
 * The list is checked against PROVIDER_ROUTES, so a new provider's key cannot
 * be left out. The README's vendor-directory definition must agree with what
 * Compose gives egress: the raw token, so the definition gives the prefix.
 *
 * Phase 8: one `docker compose up -d --build`, with no .env and no profile,
 * starts everything with working defaults (G1), and nous-proxy starts
 * Python only once the nous-home volume holds Hermes's auth store (G6), and
 * after a quick exit only once that store changes or 5 minutes pass
 * (nous-proxy-loop.spec.ts runs the loop in each state).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PROVIDER_ROUTES } from './providers-map.js';

const COMPOSE = fileURLToPath(new URL('../../../../docker-compose.yml', import.meta.url));
const README = fileURLToPath(new URL('../../../../README.md', import.meta.url));

interface ComposeFile {
  services: Record<
    string,
    {
      env_file?: unknown;
      environment?: Record<string, unknown>;
      volumes?: unknown[];
      profiles?: unknown;
      entrypoint?: unknown;
    }
  >;
}

/** The fixed token Compose gives vendor-directory and egress when neither the shell nor .env sets one. */
const SAMPLE_TOKEN = '${VENDOR_DIRECTORY_TOKEN-hermes-evals-sample-token}';

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

  it("keeps the sample servers' values where they belong, read from the shell, then .env", async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    const env = (service: string) => compose.services[service]!.environment ?? {};
    // The http header value is egress's alone (plan 5.3), the raw token: the
    // definition's `Bearer ` prefix is written by egress (Phase 7). Unset, the
    // same sample value for both (Phase 8); `-`, not `:-`, so an empty value
    // still unsets it (scripts/phase6-smoke.sh recreates egress that way).
    expect(env('api')['VENDOR_DIRECTORY_TOKEN']).toBe('');
    expect(env('worker')['VENDOR_DIRECTORY_TOKEN']).toBe('');
    expect(env('egress')['VENDOR_DIRECTORY_TOKEN']).toBe(SAMPLE_TOKEN);
    expect(env('vendor-directory')['VENDOR_DIRECTORY_TOKEN']).toBe(SAMPLE_TOKEN);
    // The stdio sample's file is the worker's, which starts the server in a
    // trial; a shell variable reaches it as well as .env (scripts/phase6-smoke.sh).
    // Unset, the file baked into the trial image.
    expect(env('worker')['INVOICE_DB_URL']).toBe(
      '${INVOICE_DB_URL-file:///opt/mcp/invoice-db/invoices.csv}',
    );
    expect(env('api')['INVOICE_DB_URL']).toBeUndefined();
    expect(env('egress')['INVOICE_DB_URL']).toBeUndefined();
  });

  it("matches the README's vendor-directory definition, which gives the prefix `Bearer `", async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    expect(compose.services.egress!.environment?.['VENDOR_DIRECTORY_TOKEN']).not.toContain(
      'Bearer',
    );
    // A definition without the prefix makes egress send the bare token, and the server answers 401.
    const readme = await readFile(README, 'utf8');
    expect(readme).toContain('Compose gives egress the raw token');
    const definitions = readme
      .split('\n')
      .filter((line) => line.includes('header `Authorization`'));
    expect(definitions).toHaveLength(2);
    for (const line of definitions) {
      expect(line).toMatch(
        /`Authorization`(,| with the) prefix `Bearer `,? from `VENDOR_DIRECTORY_TOKEN`/,
      );
    }
  });

  it('mounts the file MOCK_SCRIPTS_FILE names into the mock, read-only (Phase 6b question 11)', async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    const mock = compose.services['mock-model']!;
    expect(mock.environment).toMatchObject({
      MOCK_SCRIPTS_FILE: '/run/mock-scripts',
      MOCK_SCRIPTS: '${MOCK_SCRIPTS:-}',
    });
    // Unset, every smoke test's and sample suite's scripts (Phase 8).
    expect(mock.volumes).toEqual([
      {
        type: 'bind',
        source: '${MOCK_SCRIPTS_FILE:-./scripts}',
        target: '/run/mock-scripts',
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    // The file that leaves MOCK_STEPS alone, for a start that wants no script.
    const empty = new URL('../../../../apps/egress/no-mock-scripts.json', import.meta.url);
    expect(JSON.parse(await readFile(fileURLToPath(empty), 'utf8'))).toEqual([]);
  });
});

describe('docker-compose.yml first start (Phase 8 G1)', () => {
  it('starts every service without a profile', async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining(['mock-model', 'vendor-directory', 'api', 'worker', 'egress']),
    );
    for (const [name, service] of Object.entries(compose.services)) {
      expect([name, service.profiles]).toEqual([name, undefined]);
    }
  });

  it('makes the mock model the judge unless the shell or .env sets one', async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    for (const name of ['api', 'worker']) {
      expect([name, compose.services[name]!.environment]).toEqual([
        name,
        expect.objectContaining({
          JUDGE_PROVIDER: '${JUDGE_PROVIDER:-custom}',
          JUDGE_MODEL: '${JUDGE_MODEL:-mock/scripted}',
          JUDGE_BASE_URL: '${JUDGE_BASE_URL:-http://mock-model:8090/v1}',
        }),
      ]);
    }
  });

  it('gives the api the samples, read-only, and seeds them unless SEED_SAMPLES says not to', async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    const api = compose.services.api!;
    expect(api.volumes).toContain('./samples:/samples:ro');
    expect(api.environment).toMatchObject({
      SEED_SAMPLES: '${SEED_SAMPLES:-true}',
      SAMPLES_DIR: '/samples',
    });
    // The worker never reads the samples: the seed is the api's.
    expect(compose.services.worker!.environment?.['SAMPLES_DIR']).toBeUndefined();
  });
});

describe('docker-compose.yml nous-proxy (Phase 8 G6)', () => {
  it('starts hermes proxy only once the volume holds the auth store, and backs off after a quick exit', async () => {
    const compose = parse(await readFile(COMPOSE, 'utf8'), { merge: true }) as ComposeFile;
    const proxy = compose.services['nous-proxy']!;
    // Hermes writes its auth store at $HERMES_HOME/auth.json (hermes_cli/auth.py _auth_file_path).
    expect(proxy.environment).toMatchObject({ HERMES_HOME: '/opt/data' });
    expect(proxy.volumes).toEqual(['nous-home:/opt/data']);
    const [shell, flag, script] = proxy.entrypoint as string[];
    expect([shell, flag]).toEqual(['/bin/sh', '-c']);
    // Compose turns $$ into $ before the shell sees the script.
    const lines = script!
      .replaceAll('$$', '$')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // Disconnect rewrites auth.json with no provider rather than deleting it,
    // and the proxy then exits at once: a start that ends within 30 s leaves a
    // stamp, and the next start waits until auth.json is newer than it (a
    // Connect or a CLI login rewrites it) or 60 idle passes (5 minutes).
    // Only the file's existence and time are read, never its content.
    expect(lines).toEqual([
      `trap 'kill "$pid" 2>/dev/null; exit 0' TERM INT`,
      'auth="$HERMES_HOME/auth.json"',
      'stamp=/tmp/proxy-exited',
      'rm -f "$stamp"',
      'idle=0',
      'while :; do',
      'if [ -e "$auth" ] && { [ ! -e "$stamp" ] || [ "$auth" -nt "$stamp" ] || [ "$idle" -ge 60 ]; }; then',
      'idle=0',
      'started=$(date +%s)',
      '/opt/hermes/.venv/bin/hermes proxy start --provider nous --host 0.0.0.0 --port 8645 &',
      'pid=$!',
      'wait "$pid"',
      'if [ $(($(date +%s) - started)) -lt 30 ]; then touch "$stamp"; else rm -f "$stamp"; fi',
      'else',
      'idle=$((idle + 1))',
      'fi',
      'sleep 5 & wait $!',
      'done',
    ]);
  });
});
