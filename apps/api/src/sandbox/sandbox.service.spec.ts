/**
 * The worker's sandbox installs the verifier runner of the whole process
 * (R7, plan 14): once SandboxService exists, every verifier run, for
 * scoring, load self-checks and draft self-checks, goes to a container
 * through docker-guard, never to a subprocess of the worker. Constructing
 * it opens no socket, so no Docker is needed here.
 */
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { currentVerifierRunner, useVerifierRunner } from '../scoring/verifier-runner.js';
import { SandboxService } from './sandbox.service.js';

const env: Partial<Env> = {
  DOCKER_SOCKET: '/nonexistent/docker-guard.sock',
  EGRESS_ADMIN_SOCKET: '/nonexistent/egress-admin.sock',
  TRIAL_SLOTS: 'slot-1,slot-2',
  TRIALS_DIR: '/nonexistent/trials',
  TRIAL_IMAGE: 'hermes-evals/trial:test',
  TRIAL_VOLUME: 'hermes-evals-trials-test',
};
const config = { get: (name: keyof Env) => env[name] } as unknown as ConfigService<Env, true>;
const logger = { setContext: () => {} } as unknown as PinoLogger;

afterEach(() => {
  useVerifierRunner(null);
});

describe('SandboxService', () => {
  it("installs its container runner as the process's verifier runner", () => {
    useVerifierRunner(null);
    const sandbox = new SandboxService(config, logger);
    // Identity, not "not the subprocess": with nothing installed, a fresh subprocess runner comes back.
    expect(currentVerifierRunner()).toBe(sandbox.verifier);
    expect(sandbox).toMatchObject({
      slots: ['slot-1', 'slot-2'],
      trialsDir: '/nonexistent/trials',
      image: 'hermes-evals/trial:test',
      volume: 'hermes-evals-trials-test',
    });
  });
});
