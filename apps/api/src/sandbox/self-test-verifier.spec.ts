/**
 * The isolation self-test's verifier check (Phase 5b question 3, settled
 * for Phase 7): what it reports for each way a verifier container can go,
 * with a runner standing in for docker-guard, and, gated on
 * RUN_SANDBOX_TESTS=1, the real check through a real docker-guard.
 *
 * From a development machine, run a host docker-guard as
 * docs/phases/phase-1.md 6.1 describes, then:
 *
 *   RUN_SANDBOX_TESTS=1 DOCKER_SOCKET="$D/guard.sock" TRIALS_DIR="$D/trials" \
 *     TRIAL_IMAGE=hermes-evals/trial:v0.22.4-4d04303 TRIAL_VOLUME=hermes-evals-sandbox-test-trials \
 *     pnpm exec vitest run src/sandbox/self-test-verifier.spec.ts
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VerifierUnavailable, type VerifierRunner } from '../scoring/verifier-runner.js';
import type { VerifierOptions, VerifierRun } from '../scoring/verifier.js';
import { EngineClient } from './engine-client.js';
import { checkVerifierContainer, VERIFIER_CHECK_NAME } from './self-test-verifier.js';

const engine = new EngineClient('/nonexistent/docker.sock');
const base = { engine, image: 'hermes-evals/trial:test', volume: 'trials', trialsDir: '/trials' };

const evidence = (durationMs: number): VerifierRun['evidence'] => ({
  argv: ['/usr/local/bin/python3', '/check/verify/probe.py'],
  exit_code: 0,
  timed_out: false,
  duration_ms: durationMs,
  stdout_line: null,
  stdout_tail: '',
  stderr_tail: '',
});

/** A runner that records what it was asked to run and answers `outcome`. */
function fakeRunner(answer: (options: VerifierOptions) => Promise<VerifierRun>) {
  const seen: Array<{ options: VerifierOptions; script: string }> = [];
  const runner: VerifierRunner = {
    async run(options) {
      seen.push({ options, script: await readFile(options.scriptPath, 'utf8') });
      return answer(options);
    },
  };
  return { runner, seen };
}

describe('checkVerifierContainer', () => {
  it('passes when the probe scores 1, with what it found and how long it took', async () => {
    const { runner, seen } = fakeRunner(async () => ({
      outcome: { ok: true, score: 1, comment: 'no network, uid 10000, inputs read-only' },
      evidence: evidence(612),
    }));
    expect(await checkVerifierContainer({ ...base, verifier: runner })).toEqual({
      name: VERIFIER_CHECK_NAME,
      ok: true,
      detail: 'no network, uid 10000, inputs read-only · 0.6 s',
    });
    const [run] = seen;
    expect(run!.options).toMatchObject({ answer: null, timeoutS: 30 });
    expect(run!.options.scriptPath.startsWith(run!.options.verifyDir!)).toBe(true);
    expect(run!.script).toContain('/proc/net/route');
    // The probe's folder is gone once the check is done.
    expect(existsSync(run!.options.verifyDir!)).toBe(false);
  });

  it('fails with the probe’s findings when the container is not confined', async () => {
    const { runner } = fakeRunner(async () => ({
      outcome: { ok: true, score: 0, comment: 'has a route; reached 1.1.1.1:443' },
      evidence: evidence(1400),
    }));
    expect(await checkVerifierContainer({ ...base, verifier: runner })).toMatchObject({
      ok: false,
      detail: 'has a route; reached 1.1.1.1:443 · 1.4 s',
    });
  });

  it('fails with the reason when the guard refuses the container or the script breaks', async () => {
    const refused = fakeRunner(async () => {
      throw new VerifierUnavailable(
        'could not start the verifier container: docker-guard refused: verifier mounts must be read-only',
      );
    });
    expect(await checkVerifierContainer({ ...base, verifier: refused.runner })).toEqual({
      name: VERIFIER_CHECK_NAME,
      ok: false,
      detail:
        'could not run: could not start the verifier container: docker-guard refused: verifier mounts must be read-only',
    });
    const broken = fakeRunner(async () => ({
      outcome: { ok: false, error: 'exited with code 1', detail: 'FileNotFoundError' },
      evidence: evidence(80),
    }));
    expect(await checkVerifierContainer({ ...base, verifier: broken.runner })).toMatchObject({
      ok: false,
      detail: 'exited with code 1: FileNotFoundError',
    });
  });

  it('fails, without throwing, when no guard answers', async () => {
    // The worker's own runner over a socket nobody listens on.
    const check = await checkVerifierContainer(base);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^could not run: /);
  });
});

const live = process.env.RUN_SANDBOX_TESTS === '1';

describe.skipIf(!live)('checkVerifierContainer through a real docker-guard', () => {
  it('starts a verifier container that has no network, runs as uid 10000 and cannot write', async () => {
    const check = await checkVerifierContainer({
      engine: new EngineClient(process.env.DOCKER_SOCKET ?? '/run/guard/docker.sock'),
      image: process.env.TRIAL_IMAGE ?? 'hermes-evals/trial:v0.22.4-4d04303',
      volume: process.env.TRIAL_VOLUME ?? 'hermes-evals-sandbox-test-trials',
      trialsDir: process.env.TRIALS_DIR ?? '/trials',
    });
    expect(check, check.detail).toMatchObject({ name: VERIFIER_CHECK_NAME, ok: true });
    expect(check.detail).toMatch(/^no network, uid 10000, inputs read-only · \d+\.\d s$/);
  }, 120_000);
});
