/**
 * mcp-v1's mock-script phrases against the real sample servers and Hermes's
 * own renderer, as a gated real-container spec (Phase 6b question 4, Phase 7):
 * ./hermes_render_probe.py in the pinned trial image, with no network,
 * starts invoice-db over stdio and vendor-directory on loopback, makes every
 * MCP call of every script, renders each result as Hermes hands it to the
 * model, and checks each MCP script's phrase is in exactly one result, its
 * own. Here every rendered text must also equal the generator's model of it
 * (./support.ts mcpMessage) byte for byte, which the generator and the
 * specs rely on.
 *
 * Gated by RUN_SANDBOX_TESTS=1 like the other real-container specs; it runs
 * the docker CLI itself, not docker-guard (it mounts the repository's
 * docker/mcp, scripts and this folder read-only, which the guard's trial
 * policy refuses). On Colima, set DOCKER_CONTEXT=colima. Needs the trial
 * image (`docker compose build trial-image`):
 *
 *   RUN_SANDBOX_TESTS=1 DOCKER_CONTEXT=colima pnpm --filter @hermes-evals/api exec vitest run test/mcp-v1/render-probe.spec.ts
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { JsonValueSchema } from '@hermes-evals/shared';
import { REPO } from '../invoices-v1/support.js';
import { MOCK_SCRIPTS, mcpMessage, serverData } from './support.js';

const TRIAL_IMAGE = process.env.TRIAL_IMAGE ?? 'hermes-evals/trial:v0.22.4-4d04303';
const PYTHON = '/opt/hermes/.venv/bin/python';
/** The scripts' MCP calls of the eight tasks (the ninth script reads documents only). */
const PHRASE_LINES = 9;

const RendersSchema = z.array(
  z.object({
    tool: z.string(),
    arguments: z.record(z.string(), JsonValueSchema),
    text: z.string(),
  }),
);

const docker = (args: string[], timeout = 60_000) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });

describe.runIf(process.env.RUN_SANDBOX_TESTS === '1')('the mcp-v1 render probe', () => {
  beforeAll(() => {
    const inspected = docker(['image', 'inspect', '--format', '{{.Id}}', TRIAL_IMAGE]);
    if (inspected.status !== 0) {
      throw new Error(
        `${TRIAL_IMAGE} is not built here (${inspected.stderr.trim() || inspected.error?.message}): ` +
          'docker compose build trial-image (on Colima with DOCKER_CONTEXT=colima)',
      );
    }
  });

  it(
    'finds each phrase in its own result only, and renders as the generator models it',
    { timeout: 300_000 },
    async () => {
      const run = docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${join(REPO, 'docker/mcp')}:/checks:ro`,
          '-v',
          `${join(REPO, 'scripts')}:/scripts:ro`,
          '-v',
          `${join(REPO, 'apps/api/test/mcp-v1')}:/probe:ro`,
          '--entrypoint',
          PYTHON,
          TRIAL_IMAGE,
          '/probe/hermes_render_probe.py',
          '--renders',
        ],
        290_000,
      );
      const lines = run.stdout.trim().split('\n');
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(lines.at(-1)).toBe('all mcp-v1 phrase checks passed');
      expect(lines.filter((l) => l.startsWith('ok ')).length).toBe(PHRASE_LINES);

      const renders = RendersSchema.parse(
        JSON.parse(lines.find((l) => l.startsWith('renders '))!.slice('renders '.length)),
      );
      const scripts = z
        .array(z.object({ steps: z.array(z.object({ tool: z.string().optional() }).loose()) }))
        .parse(JSON.parse(await readFile(join(REPO, MOCK_SCRIPTS), 'utf8')));
      const calls = new Set(
        scripts.flatMap((s) =>
          s.steps
            .filter((step) => step.tool?.startsWith('mcp__'))
            .map((step) => JSON.stringify(step)),
        ),
      );
      expect(renders).toHaveLength(calls.size);
      const data = await serverData();
      for (const render of renders) {
        const call = { tool: render.tool, arguments: render.arguments };
        expect(render.text, JSON.stringify(call)).toBe(mcpMessage(data, call));
      }
    },
  );
});
