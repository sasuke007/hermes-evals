/**
 * MCP "Test start" from the API's side (plan 5.3, UI_FLOWS 9.3). The worker
 * runs the test, because only it can start a trial container; the API sends
 * a test-mcp-server job and waits for its output, an McpTestView. A second
 * request for the same definition joins the live job (exclusive key: the
 * version and its definition hash, so a test after an in-place edit is a job
 * of its own).
 */
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { McpTestViewSchema, type McpServerInput, type McpTestView } from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import { mcpServerVersions } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { findLiveWorker } from '../../queue/live-worker.js';
import { QueueService } from '../../queue/queue.service.js';
import { QUEUES, testMcpServerKey, type TestMcpServerJob } from '../../queue/queues.js';
import { JobWaitTimeout, sendAndWait, type JobOutcome } from '../../queue/send-and-wait.js';
import { definitionOf } from './definition.js';
import { latestVersions } from './mcp-reads.js';
import { mcpServerNotFound } from './mcp-servers.service.js';
import { readTestRecord, type McpTestRecord } from './test-record.js';
import { toMcpTestView } from './views.js';

const unavailable = (message: string) =>
  new ServiceUnavailableException({ statusCode: 503, message });

@Injectable()
export class McpTestsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /** POST /resources/mcp-servers/:id/test: tests the server's latest version and records the result on it. */
  async testSaved(id: string): Promise<McpTestView> {
    const [latest] = await latestVersions(this.db, [id]);
    if (!latest) throw mcpServerNotFound(id);
    const definition = definitionOf(latest.server.name, latest.version);
    const versionId = latest.version.id;
    const job: TestMcpServerJob = {
      kind: 'saved',
      mcpServerVersionId: versionId,
      definitionHash: latest.version.definitionHash,
    };
    return this.run(job, definition, {
      // The job may still finish. Until then the answer is what that job
      // last wrote, never an earlier test's result: a record of another job
      // (yesterday's pass) says nothing about this one.
      onTimeout: async (requestedAt, jobId) => {
        const [row] = await this.db
          .select({ lastTest: mcpServerVersions.lastTest })
          .from(mcpServerVersions)
          .where(eq(mcpServerVersions.id, versionId));
        const record = readTestRecord(row?.lastTest);
        return record.status !== 'untested' && record.job_id === jobId
          ? toMcpTestView(record, definition)
          : { status: 'running', requestedAt };
      },
      onJobFailed: (record) => this.recordJobFailure(versionId, record),
    });
  }

  /** POST /resources/mcp-servers/test: tests what the form holds; nothing is stored. */
  testUnsaved(definition: McpServerInput): Promise<McpTestView> {
    return this.run({ kind: 'unsaved', definition }, definition, {
      onTimeout: async (requestedAt) => ({ status: 'running', requestedAt }),
    });
  }

  private async run(
    job: TestMcpServerJob,
    definition: McpServerInput,
    handlers: {
      /** The wait ended first; `jobId` is the job this request sent or joined. */
      onTimeout: (requestedAt: string, jobId: string) => Promise<McpTestView>;
      onJobFailed?: (record: Extract<McpTestRecord, { status: 'failed' }>) => Promise<void>;
    },
  ): Promise<McpTestView> {
    if ((await this.queue.ping()) !== 'ok') {
      throw unavailable('the job queue is not available, so no worker can run the test');
    }
    if (!(await findLiveWorker(this.db))) {
      throw unavailable('no worker is connected; start the worker to test MCP servers');
    }
    const requestedAt = new Date().toISOString();
    let outcome: JobOutcome;
    try {
      outcome = await sendAndWait(this.queue.instance, QUEUES.testMcpServer, job, {
        singletonKey: testMcpServerKey(job),
        timeoutMs: this.config.get('MCP_TEST_TIMEOUT_S', { infer: true }) * 1000,
      });
    } catch (err) {
      if (err instanceof JobWaitTimeout) return handlers.onTimeout(requestedAt, err.jobId);
      throw err;
    }
    if (outcome.state === 'completed') {
      const view = McpTestViewSchema.safeParse(outcome.output);
      if (view.success) return view.data;
    }
    // The handler records its own failures and returns them as output, so
    // this is a job that crashed, expired or was cancelled.
    const record: Extract<McpTestRecord, { status: 'failed' }> = {
      status: 'failed',
      job_id: outcome.jobId,
      requested_at: requestedAt,
      finished_at: new Date().toISOString(),
      error: `The test job ${outcome.state === 'completed' ? 'returned no result' : outcome.state}: ${jobMessage(outcome.output)}`,
      exit_code: null,
      missing_secret_names: [],
    };
    await handlers.onJobFailed?.(record);
    return toMcpTestView(record, definition);
  }

  /**
   * A job that died leaves the version showing `running`; mark it failed, but
   * only while it still shows that job, so a newer test's result is kept.
   */
  private async recordJobFailure(
    versionId: string,
    record: Extract<McpTestRecord, { status: 'failed' }>,
  ): Promise<void> {
    await this.db
      .update(mcpServerVersions)
      .set({ lastTest: record })
      .where(
        and(
          eq(mcpServerVersions.id, versionId),
          sql`${mcpServerVersions.lastTest} ->> 'status' = 'running'`,
          sql`${mcpServerVersions.lastTest} ->> 'job_id' = ${record.job_id}`,
        ),
      );
  }
}

/** The message of a failed job's serialised error, or a placeholder. */
function jobMessage(output: unknown): string {
  if (output && typeof output === 'object' && 'message' in output) {
    const { message } = output as { message: unknown };
    if (typeof message === 'string' && message !== '') return message.slice(0, 500);
  }
  return 'no detail';
}
