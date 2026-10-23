import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { QueueService } from '../queue/queue.service.js';
import { QUEUES, type EvaluateRunJob, type ExecuteRunJob } from '../queue/queues.js';
import { SandboxService } from '../sandbox/sandbox.service.js';

/**
 * Registers the queue handlers. Execution (spawn Hermes in an isolated home,
 * stream events, collect artifacts) and evaluation (run scorers over saved
 * evidence) are separate jobs so grading can be retried without re-running the agent.
 */
@Injectable()
export class WorkerService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly queue: QueueService,
    private readonly sandbox: SandboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerService.name);
  }

  async onModuleInit(): Promise<void> {
    if ((await this.queue.ping()) !== 'ok') {
      this.logger.warn(
        'queue not available; worker is idle until DATABASE_URL points at a reachable Postgres',
      );
      return;
    }
    const concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });
    const boss = this.queue.instance;

    // One job per handler call and WORKER_CONCURRENCY independent pollers:
    // a slot refills as soon as its job settles, and a throw fails only that job.
    const options = { batchSize: 1, localConcurrency: concurrency };

    // Execution needs proven isolation. Without it the worker never takes an
    // execute-run job: there is no fallback to running Hermes unsandboxed.
    if (await this.sandbox.verify()) {
      await boss.work<ExecuteRunJob>(QUEUES.executeRun, options, async ([job]) => {
        if (!job) return;
        this.logger.info(
          { runId: job.data.runId, attempt: job.data.attempt, trigger: job.data.trigger },
          'execute-run received',
        );
        // Hermes adapter is wired here in the execution slice.
      });
    } else {
      this.logger.error('execution disabled: trial isolation could not be proven on this machine');
    }

    await boss.work<EvaluateRunJob>(QUEUES.evaluateRun, options, async ([job]) => {
      if (!job) return;
      this.logger.info({ evaluationId: job.data.evaluationId }, 'evaluate-run received');
      // Scorer registry is wired here in the scoring slice.
    });

    this.logger.info({ concurrency }, 'worker ready');
  }
}
