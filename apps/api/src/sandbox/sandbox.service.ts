import { existsSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import {
  containerVerifierRunner,
  useVerifierRunner,
  type VerifierRunner,
} from '../scoring/verifier-runner.js';
import { EgressClient } from './egress-client.js';
import { EngineClient } from './engine-client.js';
import { freeSlot } from './trial-runner.js';
import { runIsolationSelfTest, type SelfTestReport } from './self-test.js';

export type SandboxState = 'unverified' | 'isolated' | 'failed' | 'unavailable';

/**
 * The worker's handle on the sandbox: the guard-backed Docker client, the
 * egress admin client, the slot networks, and whether isolation has been
 * proven on this machine. The worker takes no execution job unless it has.
 *
 * It also installs the verifier runner of the whole worker process (R7,
 * Phase 5b): every verifier script the worker runs, for scoring, load
 * self-checks and draft self-checks, runs in a `network: none` container of
 * its own through docker-guard, never as a subprocess of the worker. There
 * is no fallback: without docker-guard a verifier cannot run, and the load
 * or scoring that needs it fails instead (VerifierUnavailable).
 */
@Injectable()
export class SandboxService {
  readonly engine: EngineClient;
  readonly egress: EgressClient;
  readonly slots: string[];
  readonly trialsDir: string;
  readonly image: string;
  readonly volume: string;
  /** Where this process runs verifier scripts: a container per run. */
  readonly verifier: VerifierRunner;
  private state: SandboxState = 'unverified';
  private lastReport: SelfTestReport | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SandboxService.name);
    this.engine = new EngineClient(this.config.get('DOCKER_SOCKET', { infer: true }));
    this.egress = new EgressClient(this.config.get('EGRESS_ADMIN_SOCKET', { infer: true }));
    this.slots = this.config
      .get('TRIAL_SLOTS', { infer: true })
      .split(',')
      .map((slot) => slot.trim())
      .filter(Boolean);
    this.trialsDir = this.config.get('TRIALS_DIR', { infer: true });
    this.image = this.config.get('TRIAL_IMAGE', { infer: true });
    this.volume = this.config.get('TRIAL_VOLUME', { infer: true });
    this.verifier = containerVerifierRunner({
      engine: this.engine,
      image: this.image,
      volume: this.volume,
      trialsDir: this.trialsDir,
    });
    useVerifierRunner(this.verifier);
  }

  /** Runs the isolation self-test. Returns true only if every check passed. */
  async verify(): Promise<boolean> {
    const socket = this.config.get('DOCKER_SOCKET', { infer: true });
    if (!existsSync(socket) || !(await this.egress.health())) {
      this.state = 'unavailable';
      this.logger.warn({ socket }, 'sandbox unavailable: docker-guard or egress is not reachable');
      return false;
    }
    try {
      await this.engine.version();
      this.lastReport = await runIsolationSelfTest({
        engine: this.engine,
        egress: this.egress,
        trialsDir: this.trialsDir,
        image: this.image,
        volume: this.volume,
        slot: await freeSlot(this.engine, this.slots),
      });
    } catch (err) {
      this.state = 'failed';
      this.logger.error({ err }, 'isolation self-test could not run');
      return false;
    }
    this.state = this.lastReport.ok ? 'isolated' : 'failed';
    for (const check of this.lastReport.checks) {
      this.logger[check.ok ? 'info' : 'error'](
        { check: check.name, detail: check.detail },
        check.ok ? 'isolation check passed' : 'isolation check FAILED',
      );
    }
    return this.lastReport.ok;
  }

  status(): { state: SandboxState; checks: SelfTestReport['checks'] } {
    return { state: this.state, checks: this.lastReport?.checks ?? [] };
  }
}
