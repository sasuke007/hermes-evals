import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'yaml';
import { checkCreateBody } from '@hermes-evals/docker-guard/policy';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { INVOICE_DB, VENDOR_API } from '../../resources/mcp/mcp-testing.support-spec.js';
import type { EgressRegistration } from '../../sandbox/egress-client.js';
import { EngineClient } from '../../sandbox/engine-client.js';
import {
  describeGatewayCall,
  mcpTestConfig,
  runHttpMcpTest,
  runStdioMcpTest,
  type McpGatewayLogEntry,
  type McpHttpTestParts,
  type McpTestSandboxParts,
} from './mcp-test-container.js';
import { handleTestMcpServerJob, type McpTestDeps } from './test-mcp-server.js';

const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
const VOLUME = 'hermes-evals-trials';
const VALUE = 'file:///opt/mcp/invoice-db/invoices.csv';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', 'hermes-mcp-test', name), 'utf8');

describe('mcpTestConfig', () => {
  it('holds only this server, as a run gets it, and turns off what phones home', () => {
    expect(mcpTestConfig(INVOICE_DB)).toEqual({
      mcp_servers: {
        'invoice-db': {
          command: 'invoice-db-mcp',
          args: [],
          env: { INVOICE_DB_URL: '${INVOICE_DB_URL}' },
          tools: { exclude: ['delete_*'] },
          timeout: 30,
        },
      },
      updates: { check: false },
      plugins: { auto_update_check_hours: 0 },
      security: { allow_lazy_installs: false },
    });
  });

  it('points an http server at the gateway with the token as a reference, and no header value', () => {
    const config = mcpTestConfig(VENDOR_API);
    expect(config.mcp_servers).toEqual({
      'vendor-api': {
        url: 'http://egress:8080/mcp/vendor-api',
        headers: { Authorization: 'Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}' },
        timeout: 60,
      },
    });
    expect(JSON.stringify(config)).not.toContain('VENDOR_API_TOKEN');
    expect(JSON.stringify(config)).not.toContain('vendor-api.example.com');
  });
});

/** One frame of Docker's multiplexed log stream: stdout (1) or stderr (2). */
const frame = (text: string | Buffer, stream: 1 | 2 = 1): Buffer => {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

/**
 * The Engine calls runTrial makes. At create it reads what the test wrote
 * into the trial home; at start it writes the server log as Hermes would.
 */
function fakeEngine(
  trialsDir: string,
  stdout: string | Buffer[],
  exitCode: number,
  serverLog: string,
) {
  const seen: { body?: unknown; config?: unknown; home?: string; calls: string[] } = { calls: [] };
  const homeDir = async () => {
    const [attempt] = await readdir(trialsDir);
    return join(trialsDir, attempt!, 'home');
  };
  const engine = {
    list: async () => [],
    createContainer: async (name: string, body: unknown) => {
      seen.calls.push(`create ${name}`);
      seen.body = body;
      seen.home = await homeDir();
      seen.config = parse(await readFile(join(seen.home, 'config.yaml'), 'utf8'));
      return 'c'.repeat(64);
    },
    waitForExit: () => ({
      registered: Promise.resolve(),
      exited: Promise.resolve({ StatusCode: exitCode }),
    }),
    start: async () => {
      seen.calls.push('start');
      await mkdir(join(seen.home!, 'logs'));
      await writeFile(join(seen.home!, 'logs', 'mcp-stderr.log'), serverLog);
    },
    logs: async () =>
      Readable.from(
        typeof stdout === 'string' ? [frame(stdout)] : stdout,
      ) as unknown as IncomingMessage,
    inspect: async () => ({ State: { OOMKilled: false } }),
    stop: async () => {},
    kill: async () => void seen.calls.push('kill'),
    remove: async () => void seen.calls.push('remove'),
  };
  return { engine: engine as unknown as EngineClient, seen };
}

describe('runStdioMcpTest', () => {
  let trialsDir: string;

  beforeEach(async () => {
    trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-mcp-test-'));
  });

  afterEach(async () => {
    await rm(trialsDir, { recursive: true, force: true });
  });

  const parts = (engine: EngineClient): McpTestSandboxParts => ({
    engine,
    trialsDir,
    image: IMAGE,
    volume: VOLUME,
  });

  it('runs hermes mcp test in a trial container docker-guard accepts, then removes it and its directory', async () => {
    const { engine, seen } = fakeEngine(
      trialsDir,
      fixture('invoice-db-passed.stdout.txt'),
      0,
      fixture('invoice-db-passed.mcp-stderr.log'),
    );
    const run = await runStdioMcpTest(parts(engine), {
      definition: INVOICE_DB,
      values: { INVOICE_DB_URL: VALUE },
      timeoutMs: 60_000,
    });
    expect(run).toMatchObject({ exitCode: 0, stopReason: 'exited', stderr: '' });
    // As delivered: blank lines dropped.
    expect(run.stdout).toContain('✓ Tools discovered: 4\n    list_invoices');
    expect(run.serverLog).toBe(fixture('invoice-db-passed.mcp-stderr.log'));
    expect(seen.config).toEqual(mcpTestConfig(INVOICE_DB));
    expect(seen.calls).toEqual([
      expect.stringMatching(/^create hermes-evals-probe-[0-9A-Z]{26}$/),
      'start',
      'remove',
    ]);
    expect(await readdir(trialsDir)).toEqual([]);

    const body = JSON.parse(JSON.stringify(seen.body)) as {
      Cmd: string[];
      Env: string[];
      HostConfig: { NetworkMode: string };
    };
    expect(body.Cmd).toEqual(['mcp', 'test', 'invoice-db']);
    expect(body.HostConfig.NetworkMode).toBe('none');
    // The value is in the container's environment, and only there.
    expect(body.Env).toContain(`INVOICE_DB_URL=${VALUE}`);
    expect(body.Env).toContain('HERMES_HOME=/opt/data');
    expect(JSON.stringify(seen.config)).not.toContain(VALUE);
    const verdict = checkCreateBody(body, {
      trialImage: IMAGE,
      trialVolume: VOLUME,
      trialNetworks: ['hermes-evals-trial-0'],
    });
    expect(verdict.ok ? 'accepted' : verdict.reasons).toBe('accepted');
  });

  it('cleans up after a failed start too', async () => {
    const { engine } = fakeEngine(
      trialsDir,
      fixture('invoice-db-missing-env.stdout.txt'),
      1,
      fixture('invoice-db-missing-env.mcp-stderr.log'),
    );
    const run = await runStdioMcpTest(parts(engine), {
      definition: { ...INVOICE_DB, envNames: [] },
      values: {},
      timeoutMs: 60_000,
    });
    expect(run.exitCode).toBe(1);
    expect(run.serverLog).toContain('Error: INVOICE_DB_URL is not set');
    expect(await readdir(trialsDir)).toEqual([]);
  });

  it('stops a server that floods its output, and keeps only a bounded tail', async () => {
    // 2 MiB to stderr and 10,000 stdout lines, against a 256 KiB cap.
    const flood = Buffer.alloc(64 * 1024, 'e');
    const frames = [
      ...Array.from({ length: 32 }, () => frame(flood, 2)),
      frame(Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n')),
    ];
    const { engine, seen } = fakeEngine(trialsDir, frames, 137, '');
    const run = await runStdioMcpTest(parts(engine), {
      definition: INVOICE_DB,
      values: { INVOICE_DB_URL: VALUE },
      timeoutMs: 60_000,
      outputLimitBytes: 256 * 1024,
    });
    expect(run.stopReason).toBe('output_limit');
    expect(seen.calls).toContain('kill');
    expect(Buffer.byteLength(run.stderr) + Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(
      256 * 1024,
    );
    // Past the cap nothing more was taken in: the stdout frame came after it.
    expect(run.stdout).toBe('');
    expect(await readdir(trialsDir)).toEqual([]);
  });

  it('refuses an http definition (runHttpMcpTest runs those)', async () => {
    const { engine } = fakeEngine(trialsDir, '', 0, '');
    await expect(
      runStdioMcpTest(parts(engine), {
        definition: {
          ...INVOICE_DB,
          transport: 'http',
          command: null,
          url: 'https://x.example/mcp',
          envNames: [],
        },
        values: {},
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/stdio/);
  });
});

describe('runHttpMcpTest', () => {
  let trialsDir: string;
  const SLOT = 'hermes-evals-trial-2';

  beforeEach(async () => {
    trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-mcp-http-'));
  });

  afterEach(async () => {
    await rm(trialsDir, { recursive: true, force: true });
  });

  const gatewayEntries: McpGatewayLogEntry[] = [
    {
      at: 't',
      kind: 'mcp',
      server: 'vendor-api',
      method: 'HEAD',
      decision: 'allowed',
      status: 405,
    },
    {
      at: 't',
      kind: 'mcp',
      server: 'vendor-api',
      method: 'POST',
      decision: 'allowed',
      status: 200,
    },
    {
      at: 't',
      kind: 'mcp',
      server: 'vendor-api',
      method: 'GET',
      decision: 'denied',
      status: 307,
      reason: 'redirect refused',
    },
  ];

  /** Egress and a slot source that write into the engine's call list, so order shows. */
  function httpParts(
    engine: EngineClient,
    calls: string[],
    options: { refuse?: boolean } = {},
  ): McpHttpTestParts & { registered: EgressRegistration[]; released: number } {
    const state = { registered: [] as EgressRegistration[], released: 0 };
    return {
      engine,
      trialsDir,
      image: IMAGE,
      volume: VOLUME,
      egress: {
        register: async (attemptId, registration) => {
          calls.push(`register ${attemptId}`);
          if (options.refuse) throw new Error('egress refused registration: mcp.0.url');
          state.registered.push(registration);
        },
        remove: async (attemptId) => {
          calls.push(`unregister ${attemptId}`);
          return {
            usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            log: [...gatewayEntries, { at: 't', kind: 'connect', decision: 'denied' }],
          };
        },
      },
      acquireSlot: async () => {
        calls.push(`slot ${SLOT}`);
        return {
          slot: SLOT,
          release: () => {
            calls.push('release');
            state.released += 1;
          },
        };
      },
      get registered() {
        return state.registered;
      },
      get released() {
        return state.released;
      },
    };
  }

  it('runs on a slot network through the gateway, with only the token in the container', async () => {
    const { engine, seen } = fakeEngine(trialsDir, '', 0, '');
    const parts = httpParts(engine, seen.calls);
    const stdoutWithToken = (token: string) => `  ✓ Connected (412ms)\n  echoed ${token}`;
    // The token reaches the container only through its environment; capture it there.
    let token = '';
    const original = engine.createContainer.bind(engine);
    engine.createContainer = async (name: string, body: unknown) => {
      const env = (body as { Env: string[] }).Env;
      token = env.find((e) => e.startsWith('HERMES_EVALS_ATTEMPT_TOKEN='))!.split('=')[1]!;
      return original(name, body);
    };
    engine.logs = async () =>
      Readable.from([
        frame(stdoutWithToken(token)),
        frame(`stderr ${token}\n`, 2),
      ]) as unknown as IncomingMessage;

    const run = await runHttpMcpTest(parts, { definition: VENDOR_API, timeoutMs: 60_000 });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(JSON.stringify(seen.body)) as {
      Cmd: string[];
      Env: string[];
      HostConfig: { NetworkMode: string };
      NetworkingConfig: { EndpointsConfig: Record<string, unknown> };
    };
    expect(body.Cmd).toEqual(['mcp', 'test', 'vendor-api']);
    expect(body.HostConfig.NetworkMode).toBe(SLOT);
    expect(Object.keys(body.NetworkingConfig.EndpointsConfig)).toEqual([SLOT]);
    // No proxy, no header value, nothing but the platform's own variables.
    expect(body.Env.map((e) => e.split('=')[0]).sort()).toEqual([
      'HERMES_EVALS_ATTEMPT_TOKEN',
      'HERMES_HOME',
      'HOME',
      'NO_COLOR',
      'TMPDIR',
      'XDG_RUNTIME_DIR',
    ]);
    expect(seen.config).toEqual(mcpTestConfig(VENDOR_API));
    expect(JSON.stringify(seen.config)).not.toContain(token);
    const verdict = checkCreateBody(body, {
      trialImage: IMAGE,
      trialVolume: VOLUME,
      trialNetworks: ['hermes-evals-trial-0', SLOT],
    });
    expect(verdict.ok ? 'accepted' : verdict.reasons).toBe('accepted');

    // One route, the definition's exact URL and header names; no model, no CONNECT host.
    expect(parts.registered).toEqual([
      {
        token,
        mode: 'allowlist',
        allowHosts: [],
        provider: null,
        expiresAt: expect.any(Number),
        mcp: [
          {
            name: 'vendor-api',
            url: 'https://vendor-api.example.com/mcp',
            headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
          },
        ],
      },
    ]);
    // Registered before the container, removed after it, the slot freed last.
    expect(seen.calls).toEqual([
      `slot ${SLOT}`,
      expect.stringMatching(/^register [0-9A-Z]{26}$/),
      expect.stringMatching(/^create hermes-evals-probe-[0-9A-Z]{26}$/),
      'start',
      'remove',
      expect.stringMatching(/^unregister [0-9A-Z]{26}$/),
      'release',
    ]);
    expect(await readdir(trialsDir)).toEqual([]);

    // The token is replaced like a value; the gateway's calls come back as lines.
    expect(run.stdout).toBe(
      '  ✓ Connected (412ms)\n  echoed <from env HERMES_EVALS_ATTEMPT_TOKEN>',
    );
    expect(run.stderr).toBe('stderr <from env HERMES_EVALS_ATTEMPT_TOKEN>\n');
    expect(run.gatewayLog).toEqual([
      'egress: HEAD vendor-api answered 405',
      'egress: POST vendor-api answered 200',
      'egress: GET vendor-api refused 307 · redirect refused',
    ]);
  });

  it('removes the registration, frees the slot and the directory when the container fails', async () => {
    const { engine, seen } = fakeEngine(trialsDir, '', 0, '');
    engine.createContainer = async () => {
      seen.calls.push('create');
      throw new Error('docker-guard refused the create');
    };
    const parts = httpParts(engine, seen.calls);
    await expect(
      runHttpMcpTest(parts, { definition: VENDOR_API, timeoutMs: 60_000 }),
    ).rejects.toThrow(/docker-guard refused/);
    expect(seen.calls.at(-2)).toMatch(/^unregister /);
    expect(parts.released).toBe(1);
    expect(await readdir(trialsDir)).toEqual([]);
  });

  it('starts no container when egress refuses the registration', async () => {
    const { engine, seen } = fakeEngine(trialsDir, '', 0, '');
    const parts = httpParts(engine, seen.calls, { refuse: true });
    await expect(
      runHttpMcpTest(parts, { definition: VENDOR_API, timeoutMs: 60_000 }),
    ).rejects.toThrow(/egress refused registration/);
    expect(seen.calls.some((c) => c.startsWith('create'))).toBe(false);
    expect(parts.released).toBe(1);
    expect(await readdir(trialsDir)).toEqual([]);
  });

  it('refuses a stdio definition', async () => {
    const { engine, seen } = fakeEngine(trialsDir, '', 0, '');
    await expect(
      runHttpMcpTest(httpParts(engine, seen.calls), { definition: INVOICE_DB, timeoutMs: 1000 }),
    ).rejects.toThrow(/http/);
  });

  it('describes each gateway call by method, server, status and reason only', () => {
    expect(describeGatewayCall(gatewayEntries[1]!)).toBe('egress: POST vendor-api answered 200');
    expect(
      describeGatewayCall({
        at: 't',
        kind: 'mcp',
        server: 'vendor-api',
        method: 'POST',
        decision: 'denied',
        status: 503,
        reason: "VENDOR_API_TOKEN is not set in egress's environment",
      }),
    ).toBe(
      "egress: POST vendor-api refused 503 · VENDOR_API_TOKEN is not set in egress's environment",
    );
  });
});

/**
 * The sample server through the real docker-guard and trial image, end to
 * end through the handler. Inside the worker container the defaults apply;
 * from a development machine point DOCKER_SOCKET at a docker-guard socket,
 * and TRIALS_DIR at the host directory that backs TRIAL_VOLUME (see the
 * RUN_SANDBOX_TESTS note in sandbox/toolsets.spec.ts).
 */
describe.runIf(process.env.RUN_SANDBOX_TESTS === '1')('invoice-db in the trial image', () => {
  const env = process.env;
  const socket = env.DOCKER_SOCKET ?? '/run/guard/docker.sock';
  const trialsDir = env.TRIALS_DIR ?? '/trials';
  const logs: unknown[][] = [];
  const logger = {
    info: (...args: unknown[]) => logs.push(args),
    error: (...args: unknown[]) => logs.push(args),
  } as unknown as PinoLogger;

  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.close();
  });

  const deps = (values: NodeJS.ProcessEnv): McpTestDeps => {
    const sandbox: McpTestSandboxParts = {
      engine: new EngineClient(socket),
      trialsDir,
      image: env.TRIAL_IMAGE ?? IMAGE,
      volume: env.TRIAL_VOLUME ?? VOLUME,
    };
    return {
      // Unsaved definitions only; the handler reads the table for header variable names.
      db: t.db,
      env: values,
      // The guard enforces the container's shape; this test does not rerun the self-test.
      sandbox: {
        isolated: () => true,
        runStdioTest: (input) => runStdioMcpTest(sandbox, input),
        runHttpTest: () => Promise.reject(new Error('stdio only: the Live stage proves http')),
      },
    };
  };
  const job = (definition: typeof INVOICE_DB) => ({
    id: `job-${Date.now()}`,
    data: { kind: 'unsaved' as const, definition },
    createdOn: new Date(),
  });

  beforeEach(() => {
    expect(existsSync(socket), `docker-guard socket ${socket}`).toBe(true);
  });

  it('passes with its four tools when INVOICE_DB_URL is set', { timeout: 120_000 }, async () => {
    const before = await readdir(trialsDir);
    const view = await handleTestMcpServerJob(
      job(INVOICE_DB),
      deps({ INVOICE_DB_URL: VALUE }),
      logger,
    );
    expect(view).toMatchObject({
      status: 'passed',
      startedMs: expect.any(Number),
      tools: [
        { name: 'list_invoices', included: true },
        { name: 'get_invoice', included: true },
        { name: 'update_invoice', included: true },
        { name: 'delete_invoice', included: false },
      ],
    });
    expect(await readdir(trialsDir)).toEqual(before);
    expect(JSON.stringify(logs)).not.toContain(VALUE);
  });

  it(
    'fails with the server’s own error when the container lacks INVOICE_DB_URL',
    { timeout: 120_000 },
    async () => {
      // No env names, so the handler starts the container and the server finds nothing.
      const view = await handleTestMcpServerJob(
        job({ ...INVOICE_DB, envNames: [] }),
        deps({}),
        logger,
      );
      expect(view).toMatchObject({
        status: 'failed',
        exitCode: 1,
        error: expect.stringMatching(/^Exited with code 1 after \d+\.\d s · Connection closed$/),
        stderrTail: expect.stringContaining('Error: INVOICE_DB_URL is not set'),
      });
    },
  );
});
