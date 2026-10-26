/**
 * The sample MCP servers' own checks as tests (Phase 6 #16, settled for
 * Phase 6b), so `pnpm turbo test` runs the first and the gated suite the
 * second:
 *
 * - `node scripts/fixtures/sample-mcp.ts --check`: the data both servers
 *   serve, docker/mcp/invoice-db/invoices.csv and
 *   docker/mcp/vendor-directory/vendors.json, is exactly what the generator
 *   writes (mcp-v1 and invoices-v1 compute references from it). It runs with
 *   the node running vitest, which strips the types (22.18 or newer).
 * - docker/mcp/check_samples.py in the vendor-directory image: paging,
 *   filters, cursors, errors, the dry-run tools, the bearer token, the health
 *   probe, the datasets' agreement and `hermes mcp test` on both servers.
 *   Gated by RUN_SANDBOX_TESTS=1 like the other real-container specs, but it
 *   runs the docker CLI itself, not docker-guard: it mounts the repository's
 *   docker/mcp read-only into the vendor-directory image, which the guard's
 *   trial policy refuses. On Colima, set DOCKER_CONTEXT=colima. Build the
 *   image first (`docker compose --profile samples build vendor-directory`,
 *   which builds the trial image too); the spec also checks that both images
 *   serve the bytes the repository holds, so a stale image fails here
 *   rather than in a suite's run.
 *
 *   RUN_SANDBOX_TESTS=1 DOCKER_CONTEXT=colima pnpm --filter @hermes-evals/api exec vitest run test/sample-mcp.spec.ts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO } from './invoices-v1/support.js';

const GENERATOR = 'scripts/fixtures/sample-mcp.ts';
const DATA = ['docker/mcp/invoice-db/invoices.csv', 'docker/mcp/vendor-directory/vendors.json'];
const IMAGE = process.env.VENDOR_DIRECTORY_IMAGE ?? 'hermes-evals/vendor-directory';
const TRIAL_IMAGE = process.env.TRIAL_IMAGE ?? 'hermes-evals/trial:v0.22.4-4d04303';
const PYTHON = '/opt/hermes/.venv/bin/python';

/** `node <generator> --check` from `root`, which holds the generator and the data at their repository paths. */
const check = (root: string) =>
  spawnSync(process.execPath, [join(root, GENERATOR), '--check'], { encoding: 'utf8' });

describe('sample-mcp.ts --check', () => {
  it('finds the sample servers’ data exactly as the generator writes it', () => {
    const run = check(REPO);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('fails, naming the file, when the data on disk differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sample-mcp-check-'));
    try {
      for (const path of [GENERATOR, 'scripts/fixtures/package.json', ...DATA]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await cp(join(REPO, path), join(root, path));
      }
      expect(check(root).status).toBe(0);
      const vendors = join(root, DATA[1]!);
      await writeFile(vendors, (await readFile(vendors, 'utf8')).replace('on_hold', 'active'));
      const run = check(root);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('vendors.json differs from what the generator writes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** `docker <args>` with this process's environment (DOCKER_CONTEXT included). */
const docker = (args: string[], timeout = 60_000) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });

const sha256 = (text: Buffer) => createHash('sha256').update(text).digest('hex');

describe.runIf(process.env.RUN_SANDBOX_TESTS === '1')(
  'the sample MCP servers in their images',
  () => {
    beforeAll(() => {
      for (const image of [IMAGE, TRIAL_IMAGE]) {
        const inspected = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
        if (inspected.status !== 0) {
          throw new Error(
            `${image} is not built here (${inspected.stderr.trim() || inspected.error?.message}): ` +
              'docker compose --profile samples build vendor-directory (on Colima with DOCKER_CONTEXT=colima)',
          );
        }
      }
    });

    it('serves the data the repository holds, in both images', async () => {
      const want = await Promise.all(
        DATA.map(async (path) => sha256(await readFile(join(REPO, path)))),
      );
      // Where each image bakes them: invoice-db in the trial image, vendor-directory in its own.
      const baked = [
        [TRIAL_IMAGE, '/opt/mcp/invoice-db/invoices.csv'],
        [IMAGE, '/opt/mcp/vendor-directory/vendors.json'],
      ] as const;
      for (const [i, [image, path]] of baked.entries()) {
        const run = docker([
          'run',
          '--rm',
          '--network',
          'none',
          '--entrypoint',
          'sha256sum',
          image,
          path,
        ]);
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout.split(' ')[0], `${image} ${path}`).toBe(want[i]);
      }
    });

    it('passes docker/mcp/check_samples.py', { timeout: 300_000 }, () => {
      const run = docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${join(REPO, 'docker/mcp')}:/checks:ro`,
          '--entrypoint',
          PYTHON,
          IMAGE,
          '/checks/check_samples.py',
        ],
        290_000,
      );
      const lines = run.stdout.trim().split('\n');
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(lines.at(-1)).toBe('all sample MCP checks passed');
      expect(lines.filter((l) => l.startsWith('ok ')).length).toBeGreaterThanOrEqual(14);
    });
  },
);
