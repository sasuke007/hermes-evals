/**
 * The verifier container (R7, Phase 5b): its body is exactly what
 * docker-guard admits, and, gated on RUN_SANDBOX_TESTS=1, real runs in the
 * trial image through a real docker-guard prove the confinement: no
 * network, inputs that cannot be written, no environment but PATH, the
 * trial uid with no capabilities, and the kill at the deadline. The last
 * gated test loads copies of the five committed suites with each runner and
 * reports the reload time of both, which must judge every task alike.
 *
 * From a development machine, run a host docker-guard as
 * docs/phases/phase-1.md 6.1 describes, then:
 *
 *   RUN_SANDBOX_TESTS=1 DOCKER_SOCKET="$D/guard.sock" TRIALS_DIR="$D/trials" \
 *     TRIAL_IMAGE=hermes-evals/trial:v0.22.4-4d04303 TRIAL_VOLUME=hermes-evals-sandbox-test-trials \
 *     pnpm exec vitest run --no-file-parallelism src/sandbox/verifier-container.spec.ts
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkCreateBody } from '@hermes-evals/docker-guard/policy';
import type { JsonValue } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDatabase } from '../../test/support/database.js';
import { suites, tasks } from '../database/schema/index.js';
import {
  containerVerifierRunner,
  subprocessVerifierRunner,
  useVerifierRunner,
  type VerifierRunner,
} from '../scoring/verifier-runner.js';
import { BlobStore } from '../storage/blob-store.js';
import { SuiteLoader, type LoaderLogger } from '../suites/loader/suite-loader.js';
import { EngineClient } from './engine-client.js';
import { verifierContainerBody, verifierContainerName } from './verifier-spec.js';

const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
const VOLUME = 'hermes-evals-trials';
const ID = '01K8ZQ7M3V5X9C2B4N6P8R0T3C';

describe('the verifier container body', () => {
  const guard = { trialImage: IMAGE, trialVolume: VOLUME, trialNetworks: ['hermes-evals-trial-0'] };
  const body = () =>
    JSON.parse(
      JSON.stringify(
        verifierContainerBody({
          id: ID,
          image: IMAGE,
          volume: VOLUME,
          script: 'lib/check.py',
          deadline: 1_900_000_000,
        }),
      ),
    ) as unknown;

  it('is exactly what docker-guard admits under its verifier name', () => {
    const result = checkCreateBody(body(), guard, verifierContainerName(ID));
    expect(result.ok ? result.kind : result.reasons).toBe('verifier');
  });

  it('is refused under any other name', () => {
    expect(checkCreateBody(body(), guard, `hermes-evals-run-${ID}`).ok).toBe(false);
    expect(checkCreateBody(body(), guard).ok).toBe(false);
  });
});

const PRELUDE = `import argparse, json, os, socket, sys, time
parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home", required=True)
args = parser.parse_args()
`;

/** The names of the trial image's own ENV, read through docker-guard (image inspect is allowed). */
function imageEnvNames(socketPath: string): Promise<string[]> {
  const image = process.env.TRIAL_IMAGE ?? IMAGE;
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'GET',
      path: `/v1.45/images/${encodeURIComponent(image)}/json`,
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const inspect = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          Config?: { Env?: string[] };
        };
        resolve((inspect.Config?.Env ?? []).map((entry) => entry.split('=')[0]!));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const env = process.env;
const gated = describe.runIf(env.RUN_SANDBOX_TESTS === '1');

gated('a verifier in its own container', () => {
  const socket = env.DOCKER_SOCKET ?? '/run/guard/docker.sock';
  const trialsDir = env.TRIALS_DIR ?? '/trials';
  let root: string;
  let runner: VerifierRunner;
  let before: string[];

  beforeAll(async () => {
    expect(existsSync(socket), `docker-guard socket ${socket}`).toBe(true);
    before = (await readdir(trialsDir)).sort();
    root = await mkdtemp(join(tmpdir(), 'verifier-container-'));
    for (const dir of ['verify', 'workspace', 'home/memories', 'scratch']) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, 'workspace', 'data.csv'), 'a,b\n1,2\n');
    await writeFile(join(root, 'home', 'memories', 'USER.md'), 'Prefers EUR');
    runner = containerVerifierRunner({
      engine: new EngineClient(socket),
      image: env.TRIAL_IMAGE ?? IMAGE,
      volume: env.TRIAL_VOLUME ?? VOLUME,
      trialsDir,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    // Every run removes its scratch subpath and its container.
    expect((await readdir(trialsDir)).sort()).toEqual(before);
    const left = await new EngineClient(socket).list(['hermes-evals.kind=verifier']);
    expect(left).toEqual([]);
  });

  /** Runs `body` after the argument prelude; its last line reports what it found as the comment. */
  async function run(name: string, body: string, timeoutS = 30, answer: JsonValue = { total: 3 }) {
    await writeFile(join(root, 'verify', name), `${PRELUDE}${body}`);
    return runner.run({
      scriptPath: join(root, 'verify', name),
      verifyDir: join(root, 'verify'),
      answer,
      workspaceDir: join(root, 'workspace'),
      homeDir: join(root, 'home'),
      timeoutS,
      scratchDir: join(root, 'scratch'),
    });
  }

  const report = (expression: string) =>
    `print(json.dumps({"score": 1, "comment": json.dumps(${expression})}))\n`;

  const comment = (outcome: Awaited<ReturnType<typeof run>>['outcome']): unknown => {
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    return JSON.parse((outcome as { comment: string }).comment);
  };

  it('reads its inputs, as the trial uid with no capabilities', { timeout: 120_000 }, async () => {
    const { outcome, evidence } = await run(
      'inputs.py',
      `status = open("/proc/self/status").read()
cap = [l.split()[1] for l in status.splitlines() if l.startswith("CapEff")][0]
${report(`{"answer": json.load(open(args.answer)), "csv": open(os.path.join(args.workspace, "data.csv")).read(), "user": open(os.path.join(args.home, "memories", "USER.md")).read(), "uid": os.getuid(), "cap": cap, "cwd": os.getcwd()}`)}`,
    );
    expect(comment(outcome)).toEqual({
      answer: { total: 3 },
      csv: 'a,b\n1,2\n',
      user: 'Prefers EUR',
      uid: 10000,
      cap: '0000000000000000',
      cwd: '/check/verify',
    });
    expect(evidence.argv[0]).toBe('/usr/local/bin/python3');
  });

  it('has no network', { timeout: 120_000 }, async () => {
    const { outcome } = await run(
      'network.py',
      `def reach(host, port):
    try:
        socket.create_connection((host, port), timeout=3).close()
        return "connected"
    except Exception as err:
        return type(err).__name__
${report(`{"interfaces": sorted(os.listdir("/sys/class/net")), "public": reach("1.1.1.1", 53), "egress": reach("egress", 3128), "postgres": reach("postgres", 5432)}`)}`,
    );
    const found = comment(outcome) as Record<string, unknown>;
    expect(found.interfaces).toEqual(['lo']);
    for (const target of ['public', 'egress', 'postgres'])
      expect(found[target]).not.toBe('connected');
  });

  it('cannot write its inputs or the image, only /tmp', { timeout: 120_000 }, async () => {
    const { outcome } = await run(
      'writes.py',
      `def write(path):
    try:
        with open(path, "w") as f:
            f.write("x")
        return "written"
    except OSError as err:
        return err.strerror
${report(`{p: write(p) for p in [os.path.join(args.workspace, "out.txt"), os.path.join(args.workspace, "data.csv"), os.path.join(args.home, "memories", "MEMORY.md"), args.answer, "/check/verify/x.py", "/etc/x", "/tmp/x"]}`)}`,
    );
    const writes = comment(outcome) as Record<string, string>;
    expect(writes['/tmp/x']).toBe('written');
    for (const [path, result] of Object.entries(writes)) {
      if (path !== '/tmp/x') expect(result, path).toBe('Read-only file system');
    }
  });

  it(
    'sees no worker environment: PATH, the image defaults and what Docker adds',
    { timeout: 120_000 },
    async () => {
      // The image's own ENV (Hermes's HERMES_HOME, ...) is public and cannot be unset; python
      // itself sets LC_CTYPE in a C locale (PEP 538).
      const allowed = new Set([
        'PATH',
        'HOME',
        'HOSTNAME',
        'LC_CTYPE',
        ...(await imageEnvNames(socket)),
      ]);
      process.env.HERMES_EVALS_WORKER_SECRET = 'must-not-leak';
      try {
        const { outcome } = await run(
          'env.py',
          report(
            `{"keys": sorted(os.environ), "init": sorted(k.split("=")[0] for k in open("/proc/1/environ").read().split("\\0") if k)}`,
          ),
        );
        const found = comment(outcome) as { keys: string[]; init: string[] };
        expect(found.keys.filter((k) => !allowed.has(k))).toEqual([]);
        expect(found.init.filter((k) => !allowed.has(k))).toEqual([]);
        expect(found.keys).toContain('PATH');
        expect(found.keys).not.toContain('HERMES_EVALS_WORKER_SECRET');
      } finally {
        delete process.env.HERMES_EVALS_WORKER_SECRET;
      }
    },
  );

  it('is killed at its deadline', { timeout: 120_000 }, async () => {
    const started = performance.now();
    const { outcome, evidence } = await run('slow.py', 'time.sleep(120)\n', 2);
    expect(outcome).toMatchObject({ ok: false, error: 'timed out after 2 s' });
    expect(evidence.timed_out).toBe(true);
    expect(performance.now() - started).toBeLessThan(30_000);
  });
});

/** The five committed suites, read from here and copied: never written. */
const SUITES = join(import.meta.dirname, '../../../../suites');
const FIVE = ['invoices-v1', 'knowledge-v1', 'mcp-v1', 'memory-v1', 'tools-v1'];

gated('reloading the five suites with each runner', () => {
  it('judges every task alike, and reports both times', { timeout: 900_000 }, async () => {
    const socket = env.DOCKER_SOCKET ?? '/run/guard/docker.sock';
    const container = containerVerifierRunner({
      engine: new EngineClient(socket),
      image: env.TRIAL_IMAGE ?? IMAGE,
      volume: env.TRIAL_VOLUME ?? VOLUME,
      trialsDir: env.TRIALS_DIR ?? '/trials',
    });
    const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as LoaderLogger;
    const results: Record<string, { ms: number; tasks: string[] }> = {};
    for (const [name, runner] of [
      ['subprocess', subprocessVerifierRunner],
      ['container', container],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `verifier-reload-${name}-`));
      const db = await createTestDatabase();
      try {
        for (const suite of FIVE)
          await cp(join(SUITES, suite), join(root, 'suites', suite), { recursive: true });
        useVerifierRunner(runner);
        const loader = new SuiteLoader({
          db: db.db,
          blobs: new BlobStore(join(root, 'data')),
          suitesDir: join(root, 'suites'),
          logger,
        });
        const started = performance.now();
        const result = await loader.loadAll();
        const ms = Math.round(performance.now() - started);
        const judged = [];
        for (const entry of result.suites) {
          expect(entry.outcome, `${entry.sourcePath}: ${entry.message}`).toBe('created');
          judged.push(`${entry.sourcePath}: ${entry.message}`);
        }
        const rows = await db.db
          .select({
            suite: suites.name,
            key: tasks.key,
            valid: tasks.valid,
            check: tasks.selfCheck,
          })
          .from(tasks)
          .innerJoin(suites, eq(suites.id, tasks.suiteId))
          .orderBy(asc(suites.name), asc(tasks.position));
        for (const row of rows) {
          const statuses = row.check.results.map((r) => `${r.key}:${r.mode}:${r.status}`);
          judged.push(
            `${row.suite}/${row.key} ${row.valid} ${row.check.status} ${statuses.join(',')}`,
          );
        }
        results[name] = { ms, tasks: judged };
      } finally {
        useVerifierRunner(null);
        await db.close();
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(results.container!.tasks).toEqual(results.subprocess!.tasks);
    console.info(
      `reload of the five suites: subprocess ${results.subprocess!.ms} ms, container ${results.container!.ms} ms`,
    );
  });
});
