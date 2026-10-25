/**
 * Phase 2 end to end: the real AppModule and WorkerModule on a fresh Postgres
 * 17 database, with real pg-boss, the real execute-run lifecycle, attempt
 * runner and evaluate-run handlers. Only the worker's sandbox is replaced:
 * the fake engine (test/support/fake-engine.ts) plays each trial container
 * with canned Hermes stream-json, the fake egress records registrations, and
 * isolation counts as proven. Every create body still passes docker-guard's
 * own policy. Every HTTP answer is parsed with its shared schema.
 *
 * The main experiment is 3 tasks × 2 configurations × 2 repetitions, launched
 * over HTTP: the baseline gets one task wrong and the candidate, which has a
 * skill and a stdio MCP server, gets it right. Then each control, guard and
 * recovery path runs in its own experiment, the fake trials' behaviour
 * chosen by each configuration's model (test/support/fake-trials.ts). One
 * file, one world: each world is an API and workers with their own pools,
 * and the e2e specs share one Postgres server's connections.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BulkRunActionResultSchema,
  ConfigurationDraftSchema,
  ConfigurationSaveResultSchema,
  ExperimentActionResultSchema,
  ExperimentEstimateViewSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
  LaunchRecordSchema,
  NewExperimentDraftSchema,
  NewExperimentOptionsSchema,
  ProvidersResponseSchema,
  RunActionResultSchema,
  RunDetailSchema,
  RunEventsPageSchema,
  RunListResultSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  SuiteReloadResultSchema,
  McpServerRowSchema,
  TablePreviewSchema,
  WorkerSchema,
  type ConfigurationInput,
  type ExperimentEvent,
} from '@hermes-evals/shared';
import * as schema from '../src/database/schema/index.js';
import { RECOVERY_LOCK_KEY } from '../src/execution/lifecycle/index.js';
import { INVOICE_DB } from '../src/resources/mcp/mcp-testing.support-spec.js';
import { invoiceMethodZip } from '../src/resources/skills/testing.helper-spec.js';
import {
  isStream,
  openSse,
  type SseStream,
} from '../src/experiments/sse/sse-client.support-spec.js';
import { WorkerPresenceService } from '../src/worker/presence/worker-presence.service.js';
import { WorkerService } from '../src/worker/worker.service.js';
import { ANSWERS } from './support/fake-trials.js';
import { DB_SECRET, Phase2World, TASKS, type ConfigRef } from './support/phase2-app.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const { attempts, artifacts, runEvents, runs, workers } = schema;

describe.skipIf(!SERVER_URL)('Phase 2 on Postgres 17: launch to scored', () => {
  const world = new Phase2World(SERVER_URL!, 'phase2_e2e');
  let baseline: ConfigRef;
  let candidate: ConfigRef;
  let main: string;

  beforeAll(async () => {
    await world.start();
    await world.startWorker();
  }, 120_000);

  afterAll(() => world.stop(), 120_000);

  const runsOf = (id: string) => world.runsOf(id);
  const attemptsOf = (id: string) => world.attemptsOf(id);
  const runsIn = (id: string, status: string, n: number) => world.runsIn(id, status, n);
  const trialsUp = (id: string, n: number) => world.trialsUp(id, n);

  it('registers the worker with a proven sandbox, its toolsets and slots', async () => {
    const listed = await world.read('/system/workers', z.array(WorkerSchema));
    expect(listed).toEqual([
      expect.objectContaining({
        status: 'online',
        concurrency: 2,
        slotsTotal: 2,
        slotsInUse: 0,
        sandboxProven: true,
      }),
    ]);
    const [row] = await world.db.select().from(workers);
    expect(row!.toolsets).toEqual(['file', 'terminal', 'web']);
    expect(row!.hostProxy).toBeNull();
  });

  it('loads the suite, a skill, an MCP server and the configurations', async () => {
    // The worker loaded the suite at start; a reload finds it unchanged.
    const reload = await world.send('post', '/suites/reload', {}, 200, SuiteReloadResultSchema);
    expect(reload.suites).toEqual([
      expect.objectContaining({ name: 'phase2', versionNumber: 1, error: null }),
    ]);

    const validated = await request(world.api.getHttpServer())
      .post('/api/resources/skills/validate')
      .set('X-Requested-With', 'hermes-evals')
      .attach('file', await invoiceMethodZip(), 'invoice-method.zip')
      .expect(200);
    const { token } = SkillUploadValidationSchema.parse(validated.body);
    const skill = await world.send('post', '/resources/skills', { token }, 201, SkillRowSchema);
    const invoiceDb = await world.send(
      'post',
      '/resources/mcp-servers',
      INVOICE_DB,
      201,
      McpServerRowSchema,
    );

    baseline = await world.configuration('baseline', 'mock/scripted');
    candidate = await world.configuration('candidate', 'mock/scripted', {
      skillIds: [skill.id],
      mcpServerVersionIds: [invoiceDb.versionId],
    });
  });

  it('offers the suite and configurations, and estimates the matrix', async () => {
    const options = await world.read('/experiments/new-options', NewExperimentOptionsSchema);
    const suite = options.suites.find((s) => s.name === 'phase2')!;
    expect(suite.tasks.map((t) => [t.key, t.valid])).toEqual(TASKS.map((key) => [key, true]));
    expect(options).toMatchObject({ workerCount: 1, maxConcurrency: 2 });
    expect(options.priceTable.map((p) => p.model).sort()).toEqual(['mock/priced', 'mock/scripted']);
    const estimate = await world.read(
      `/experiments/estimate?suite=${suite.suiteId}&versions=${baseline.versionId},${candidate.versionId}&tasks=3&repetitions=2&concurrency=2`,
      ExperimentEstimateViewSchema,
    );
    expect(estimate).toMatchObject({ runs: 12, waves: 6, basis: 'budget', costUsd: 0 });
  });

  describe('3 tasks × 2 configurations × 2 repetitions', () => {
    let stream: SseStream;

    it('launches over HTTP, runs every trial in a container and scores every run', async () => {
      // Every trial waits at a gate until the stream is open, so it sees them run.
      world.scripts.hold('mock/scripted');
      main = await world.launch('main', baseline, [candidate], { repetitions: 2 });
      const opened = await openSse(world.api.getHttpServer(), `/api/experiments/${main}/events`);
      if (!isStream(opened)) throw new Error(`no stream: ${opened.status} ${opened.body}`);
      stream = opened;
      await stream.until((m) => m.length >= 2);
      world.scripts.release('mock/scripted');

      const done = await world.completed(main, 120_000);
      // One task improves by 1 and two are unchanged: over 3 tasks the
      // interval cannot clear 0, so Phase 4's verdict entry reads inconclusive.
      expect(done).toMatchObject({
        totalRuns: 12,
        verdicts: [
          {
            candidate: { name: 'candidate' },
            verdict: 'inconclusive',
            delta: 0.333,
            lo: 0,
            hi: 1,
            taskCounts: { improved: 1, regressed: 0, unchanged: 2 },
          },
        ],
      });
      expect(done.counts.scored).toBe(12);

      const events = (
        await stream.until((m) =>
          m.some((x) => x.event === 'experiment' && x.data.includes('"completed"')),
        )
      ).map((m) => ExperimentEventSchema.parse(JSON.parse(m.data)) as ExperimentEvent);
      stream.close();
      expect(events.slice(0, 2).map((e) => e.type)).toEqual(['experiment', 'counts']);
      const types = new Set(events.map((e) => e.type));
      expect(types).toEqual(new Set(['experiment', 'counts', 'run', 'feed']));
      const lastCounts = events.filter((e) => e.type === 'counts').at(-1)!;
      expect(lastCounts).toMatchObject({ type: 'counts', doneRuns: 12 });
    }, 180_000);

    it('scores each task as the scripts answered it', async () => {
      const rows = await world.read(`/experiments/${main}/runs`, RunListResultSchema);
      expect(rows.matched).toBe(12);
      const outcome = rows.rows.map((r) => [
        r.taskKey,
        r.configuration.name,
        r.primaryScore?.status,
      ]);
      for (const [task, config, status] of outcome) {
        const wrong = task === 'numeric' && config === 'baseline';
        expect(status, `${task} under ${config}`).toBe(wrong ? 'failed' : 'passed');
      }
      expect(rows.rows.every((r) => r.status === 'scored' && r.attempts === 1)).toBe(true);
      expect(rows.summary).toMatchObject({ total: 12 });
    });

    it('stores gap-free events, labelled artifacts and launch records without secrets', async () => {
      const tokens = world.egress.history.map((h) => h.registration.token);
      expect(tokens).toHaveLength(12);
      for (const { attempt } of await attemptsOf(main)) {
        expect(attempt).toMatchObject({ status: 'executed', errorCategory: null });
        const seqs = (
          await world.db
            .select({ seq: runEvents.seq })
            .from(runEvents)
            .where(eq(runEvents.attemptId, attempt.id))
            .orderBy(asc(runEvents.seq))
        ).map((e) => e.seq);
        expect(seqs).toEqual(seqs.map((_, i) => i + 1));

        const record = LaunchRecordSchema.parse(attempt.launchRecord);
        expect(record.container?.image).toBe('hermes-evals/trial:v0.22.4-4d04303');
        expect(record.network).toMatch(/^hermes-evals-trial-[01]$/);
        const stored = JSON.stringify([attempt, record]);
        for (const secret of [DB_SECRET, ...tokens]) expect(stored).not.toContain(secret);
      }
      const allEvents = JSON.stringify(
        await world.db
          .select({ payload: runEvents.payload })
          .from(runEvents)
          .innerJoin(attempts, eq(attempts.id, runEvents.attemptId))
          .innerJoin(runs, eq(runs.id, attempts.runId))
          .where(eq(runs.experimentId, main)),
      );
      for (const secret of [DB_SECRET, ...tokens]) expect(allEvents).not.toContain(secret);
      expect(allEvents).toContain('<from env INVOICE_DB_URL>');
      expect(allEvents).toContain('"subtype":"network"');

      const stored = await world.db
        .select({ path: artifacts.path, origin: artifacts.origin, task: schema.tasks.key })
        .from(artifacts)
        .innerJoin(attempts, eq(attempts.id, artifacts.attemptId))
        .innerJoin(runs, eq(runs.id, attempts.runId))
        .innerJoin(schema.tasks, eq(schema.tasks.id, runs.taskId))
        .where(eq(runs.experimentId, main));
      const byTask = (task: string) =>
        new Set(stored.filter((a) => a.task === task).map((a) => `${a.path}:${a.origin}`));
      expect(byTask('numeric')).toEqual(new Set(['amounts.csv:fixture_unchanged']));
      expect(byTask('summary_file')).toEqual(
        new Set(['invoices.csv:fixture_unchanged', 'summary.csv:agent']),
      );
      // Each trial registered allowlist mode with the custom upstream, and was removed.
      expect(world.egress.registrations.size).toBe(0);
      expect(world.egress.history[0]!.registration).toMatchObject({
        mode: 'allowlist',
        provider: 'custom',
        upstream: { baseUrl: 'http://mock-model:8090/v1' },
      });
    });

    it('reports the experiment in the list and the detail', async () => {
      const [row] = (await world.read('/experiments', z.array(ExperimentListRowSchema))).filter(
        (r) => r.id === main,
      );
      expect(row).toMatchObject({
        status: 'completed',
        totalRuns: 12,
        doneRuns: 12,
        repetitions: 2,
        verdicts: [{ candidate: 'candidate', verdict: 'inconclusive', delta: 0.333 }],
        costUsd: 0,
      });
      const detail = await world.detail(main);
      const passed = Object.fromEntries(
        detail.perConfiguration.map((p) => [p.configuration.name, p.passed]),
      );
      expect(passed).toEqual({ baseline: 4, candidate: 6 });
      const rates = Object.fromEntries(
        detail.aggregates.map((a) => [a.configuration.name, a.passRate]),
      );
      expect(rates['candidate']).toBe(1);
      expect(rates['baseline']).toBeCloseTo(4 / 6, 2);
      expect(detail.spend).toMatchObject({ spentUsd: 0, unpricedAttempts: 0 });
      expect(detail.feed).toHaveLength(10);
      expect(detail.differences.map((d) => d.field)).toEqual(
        expect.arrayContaining(['skills', 'mcp_servers']),
      );
      expect(detail.worker.connected).toBe(true);
      const draft = await world.send(
        'post',
        `/experiments/${main}/duplicate`,
        {},
        200,
        NewExperimentDraftSchema,
      );
      expect(draft.values).toMatchObject({ repetitions: 2, taskKeys: [...TASKS] });
    });

    it('filters and sorts the runs tab', async () => {
      const list = (query: string) =>
        world.read(`/experiments/${main}/runs?${query}`, RunListResultSchema);
      expect((await list(`config=${candidate.versionId}`)).matched).toBe(6);
      expect((await list('task=numeric')).matched).toBe(4);
      const failed = await list('score_status=failed');
      expect(failed.rows.map((r) => [r.taskKey, r.configuration.name])).toEqual([
        ['numeric', 'baseline'],
        ['numeric', 'baseline'],
      ]);
      expect((await list('exec_error=1')).matched).toBe(0);
      const sorted = await list('sort=task&dir=desc');
      expect(sorted.rows[0]!.taskKey).toBe('summary_file');
    });

    it('shows a run in the inspector: timeline, artifacts, launch record, events page', async () => {
      const { rows } = await world.read(
        `/experiments/${main}/runs?task=summary_file&config=${candidate.versionId}`,
        RunListResultSchema,
      );
      const runId = rows[0]!.id;
      const detail = await world.read(`/runs/${runId}`, RunDetailSchema);
      expect(detail).toMatchObject({ status: 'scored', attemptCount: 1, shownAttempt: 1 });
      expect(detail.primary).toEqual({ key: 'summary_csv', status: 'passed' });
      expect(detail.launchRecord).not.toBeNull();
      expect(JSON.stringify(detail)).not.toContain(DB_SECRET);
      const summary = detail.artifacts.items.find((a) => a.path.endsWith('summary.csv'))!;
      expect(summary).toMatchObject({ origin: 'agent' });

      const content = await request(world.api.getHttpServer())
        .get(`/api/runs/${runId}/artifacts/${summary.id}/content`)
        .expect(200);
      expect(content.text).toBe(ANSWERS.summaryCsv);
      const preview = await world.read(
        `/runs/${runId}/artifacts/${summary.id}/preview`,
        TablePreviewSchema,
      );
      expect(preview.columns).toEqual(['vendor', 'total']);

      const page = await world.read(`/runs/${runId}/events?after=0`, RunEventsPageSchema);
      expect(page.live).toBe(false);
      expect(page.events.length).toBeGreaterThan(3);
      expect(page.events.some((e) => e.kind === 'network' && e.network !== null)).toBe(true);
      const next = await world.read(
        `/runs/${runId}/events?after=${page.lastSeq}`,
        RunEventsPageSchema,
      );
      expect(next).toEqual({ events: [], lastSeq: page.lastSeq, live: false });
    });
  });

  describe('controls, each in its own experiment', () => {
    it('pause holds new runs; resume finishes them', async () => {
      const a = await world.configuration('gated-a', 'mock/gated');
      const b = await world.configuration('gated-b', 'mock/gated');
      world.scripts.hold('mock/gated');
      const id = await world.launch('pause-resume', a, [b], {
        taskKeys: ['numeric'],
        repetitions: 2,
      });
      await trialsUp(id, 2);
      const paused = await world.send(
        'post',
        `/experiments/${id}/pause`,
        {},
        200,
        ExperimentActionResultSchema,
      );
      expect(paused).toEqual({ id, status: 'paused' });
      world.scripts.release('mock/gated');
      await runsIn(id, 'scored', 2);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const held = await world.detail(id);
      expect(held).toMatchObject({ status: 'paused', pauseReason: 'user' });
      expect(held.counts).toMatchObject({ queued: 2, running: 0, scored: 2 });

      await world.send('post', `/experiments/${id}/resume`, {}, 200, ExperimentActionResultSchema);
      expect((await world.completed(id)).counts.scored).toBe(4);
    }, 120_000);

    it('cancel stops the running trials and completes the experiment', async () => {
      const a = await world.configuration('hang-a', 'mock/hang');
      const b = await world.configuration('hang-b', 'mock/hang');
      const id = await world.launch('cancel', a, [b], { taskKeys: ['numeric'] });
      await trialsUp(id, 2);
      const cancelled = await world.send(
        'post',
        `/experiments/${id}/cancel`,
        {},
        200,
        ExperimentActionResultSchema,
      );
      expect(cancelled).toEqual({ id, status: 'running' });
      const done = await world.completed(id);
      expect(done.counts.cancelled).toBe(2);
      for (const { attempt } of await attemptsOf(id)) expect(attempt.status).toBe('cancelled');
      expect(world.engine.live()).toEqual([]);
    }, 120_000);

    it('retry runs an execution_error run again, alone or in bulk', async () => {
      const a = await world.configuration('flaky-a', 'mock/fail-once');
      const b = await world.configuration('flaky-b', 'mock/fail-once');
      const id = await world.launch('retry', a, [b], { taskKeys: ['numeric'] });
      const failed = await world.completed(id);
      expect(failed.counts.execution_error).toBe(2);
      const [first, second] = await runsOf(id);
      for (const { attempt } of await attemptsOf(id)) expect(attempt.errorCategory).toBe('setup');

      const retried = await world.send(
        'post',
        `/runs/${first!.id}/retry`,
        {},
        200,
        RunActionResultSchema,
      );
      expect(retried).toEqual({ runId: first!.id, status: 'queued', attempt: 2 });
      const bulk = await world.send(
        'post',
        `/experiments/${id}/runs/retry`,
        { runIds: [second!.id, first!.id] },
        200,
        BulkRunActionResultSchema,
      );
      expect(bulk.enqueued).toEqual([second!.id]);
      expect(bulk.refused).toEqual([{ runId: first!.id, reason: expect.any(String) }]);

      const done = await world.completed(id);
      expect(done.counts.scored).toBe(2);
      expect((await runsOf(id)).map((r) => r.attemptCount)).toEqual([2, 2]);
    }, 120_000);

    it('the circuit breaker fails an experiment whose runs all fail', async () => {
      const a = await world.configuration('broken-a', 'mock/broken');
      const b = await world.configuration('broken-b', 'mock/broken');
      const id = await world.launch('breaker', a, [b]);
      const failed = await world.until(id, 'failed', (d) => d.status === 'failed');
      expect(failed.failure).toMatchObject({ category: 'setup', threshold: 3 });
      expect(failed.counts.execution_error).toBeGreaterThanOrEqual(3);
      const [run] = (await runsOf(id)).filter((r) => r.status === 'execution_error');
      const refusal = await world.refused('post', `/runs/${run!.id}/retry`, {}, 409);
      expect(refusal.message).toMatch(/Retry failed runs/);
    }, 120_000);

    it('the spend guard pauses at the ceiling; resume with a higher one finishes', async () => {
      const a = await world.configuration('priced-a', 'mock/priced');
      const b = await world.configuration('priced-b', 'mock/priced');
      const id = await world.launch('spend', a, [b], {
        taskKeys: ['numeric'],
        repetitions: 2,
        spendCeilingUsd: 3,
      });
      await world.until(id, 'paused', (d) => d.status === 'paused');
      // The two runs that started before the ceiling was reached still finish and score.
      await runsIn(id, 'scored', 2);
      const paused = await world.detail(id);
      expect(paused).toMatchObject({ status: 'paused', pauseReason: 'spend_ceiling' });
      expect(paused.counts).toMatchObject({ queued: 2, scored: 2 });
      expect(paused.spend).toMatchObject({ spentUsd: 6.6, ceilingUsd: 3 });

      const low = await world.refused('post', `/experiments/${id}/resume`, {}, 409);
      expect(low.message).toMatch(/raise the spend ceiling/);
      await world.send(
        'post',
        `/experiments/${id}/resume`,
        { spendCeilingUsd: 100 },
        200,
        ExperimentActionResultSchema,
      );
      const done = await world.completed(id);
      expect(done.spend).toMatchObject({ spentUsd: 13.2, ceilingUsd: 100 });
    }, 120_000);

    it('the provider guard pauses with provider_disconnected and spends no attempt', async () => {
      const nous = (name: string) =>
        world.configuration(name, 'mock/nous', { provider: 'nous', baseUrl: null });
      const a = await nous('nous-a');
      const b = await nous('nous-b');
      const body = await world.launchBody('provider', a, [b], {
        taskKeys: ['numeric'],
        repetitions: 2,
      });
      const refusal = await world.refused('post', '/experiments', body, 409);
      expect(refusal.message).toMatch(/Nous Portal/);

      world.nous.approve();
      world.scripts.hold('mock/nous');
      const id = await world.launch('provider', a, [b], { taskKeys: ['numeric'], repetitions: 2 });
      await trialsUp(id, 2);
      world.nous.volume = 'not_connected';
      world.scripts.release('mock/nous');

      const paused = await world.until(id, 'paused', (d) => d.status === 'paused');
      expect(paused).toMatchObject({ pauseReason: 'provider_disconnected' });
      await runsIn(id, 'scored', 2);
      const waiting = (await runsOf(id)).filter((r) => r.status === 'queued');
      expect(waiting.map((r) => r.attemptCount)).toEqual([0, 0]);
      expect(await attemptsOf(id)).toHaveLength(2);
      const providers = await world.read('/providers', ProvidersResponseSchema);
      expect(providers.find((p) => p.id === 'nous')).toMatchObject({
        status: 'not_connected',
        pausedExperiments: 1,
      });

      await world.refused('post', `/experiments/${id}/resume`, {}, 409);
      world.nous.approve();
      await world.send('post', `/experiments/${id}/resume`, {}, 200, ExperimentActionResultSchema);
      expect((await world.completed(id)).counts.scored).toBe(4);
    }, 120_000);

    it('launch refuses with a readable reason', async () => {
      const a = await world.configuration('refused-a', 'mock/scripted');
      const b = await world.configuration('refused-b', 'mock/scripted');
      // A first launch freezes both versions, so an edit makes a v2.
      await world.completed(await world.launch('freezes', a, [b], { taskKeys: ['numeric'] }));
      const body = await world.launchBody('refused', a, [b]);
      const wrongHash = {
        ...body,
        expectedConfigHashes: {
          ...body.expectedConfigHashes,
          [b.versionId]: 'f'.repeat(64),
        },
      };
      expect((await world.refused('post', '/experiments', wrongHash, 409)).message).toMatch(
        /configuration refused-b changed since you opened this form/,
      );

      const [worker] = await world.db.select().from(workers);
      await world.db
        .update(workers)
        .set({ sandbox: { ...worker!.sandbox!, state: 'failed' } })
        .where(eq(workers.id, worker!.id));
      expect((await world.refused('post', '/experiments', body, 409)).message).toMatch(
        /proven sandbox isolation/,
      );
      await world.db
        .update(workers)
        .set({ sandbox: worker!.sandbox })
        .where(eq(workers.id, worker!.id));

      const [other] = await world.db
        .insert(workers)
        .values({
          hostname: 'other-revision',
          concurrency: 1,
          hermesVersion: '0.22.5',
          hermesRevision: 'a'.repeat(40),
          sandbox: worker!.sandbox,
        })
        .returning({ id: workers.id });
      expect((await world.refused('post', '/experiments', body, 409)).message).toMatch(
        /different Hermes revisions/,
      );
      await world.db.delete(workers).where(eq(workers.id, other!.id));

      // refused-a was frozen by the first launch: an edit makes v2.
      const v2 = await world.send(
        'put',
        `/configurations/${a.configurationId}`,
        { ...(await configInput(a)), maxTurns: 21 },
        200,
        ConfigurationSaveResultSchema,
      );
      expect(v2).toMatchObject({ version: 2, createdNewVersion: true });
      expect((await world.refused('post', '/experiments', body, 409)).message).toMatch(
        /configuration refused-a changed since you opened this form \(now v2\)/,
      );
    });
  });

  describe('recovery', () => {
    let lostA: ConfigRef;
    let lostB: ConfigRef;

    it('a worker stopped mid-run ends its attempts as worker_lost; another finishes them', async () => {
      lostA = await world.configuration('lost-a', 'mock/hang-once');
      lostB = await world.configuration('lost-b', 'mock/hang-once');
      const id = await world.launch('stopped-worker', lostA, [lostB], { taskKeys: ['numeric'] });
      await trialsUp(id, 2);

      await world.workers[0]!.close();
      expect(world.engine.live()).toEqual([]);
      const lost = await attemptsOf(id);
      expect(lost.map(({ attempt }) => [attempt.status, attempt.errorCategory])).toEqual([
        ['execution_error', 'worker_lost'],
        ['execution_error', 'worker_lost'],
      ]);
      expect((await runsOf(id)).map((r) => [r.status, r.attemptCount])).toEqual([
        ['queued', 1],
        ['queued', 1],
      ]);
      const [stopped] = await world.db
        .select()
        .from(workers)
        .where(sql`stopped_at is not null`);
      expect(stopped).toBeTruthy();

      await world.startWorker();
      await world.completed(id);
      expect((await runsOf(id)).map((r) => [r.status, r.attemptCount])).toEqual([
        ['scored', 2],
        ['scored', 2],
      ]);
    }, 180_000);

    it('attempts a stopping worker could not end are recovered by the next start', async () => {
      const id = await world.launch('crashed-worker', lostA, [lostB], { taskKeys: ['numeric'] });
      const running = await trialsUp(id, 2);

      // Another pass holds the recovery lock, so the stopping worker cannot end its attempts.
      const holder = new pg.Client({ connectionString: world.url });
      await holder.connect();
      await holder.query('select pg_advisory_lock($1::bigint)', [RECOVERY_LOCK_KEY]);
      const stopping = world.workers.at(-1)!;
      expect(stopping.get(WorkerService).execution).not.toBeNull();
      await stopping.close();
      const left = await attemptsOf(id);
      expect(left.map(({ attempt }) => attempt.status)).toEqual(['running', 'running']);
      expect(world.engine.live()).toEqual([]);

      // The lease expires; the lock is free again; a new worker starts and recovers.
      await world.db
        .update(attempts)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(
          and(
            inArray(
              attempts.runId,
              running.map((r) => r.id),
            ),
            eq(attempts.status, 'running'),
          ),
        );
      await holder.query('select pg_advisory_unlock($1::bigint)', [RECOVERY_LOCK_KEY]);
      await holder.end();
      await world.startWorker();
      await world.completed(id);
      const ended = await attemptsOf(id);
      expect(ended.filter(({ attempt }) => attempt.errorCategory === 'worker_lost')).toHaveLength(
        2,
      );
      expect((await runsOf(id)).map((r) => [r.status, r.attemptCount])).toEqual([
        ['scored', 2],
        ['scored', 2],
      ]);
    }, 180_000);

    it('a worker whose isolation self-test failed starts no trial; a proven one runs them all', async () => {
      const proven = world.workers.at(-1)!;
      const unproven = await world.startWorker({ isolated: false });
      try {
        // It knows its daemon and runs recovery, but consumes no execute-run job.
        const execution = unproven.get(WorkerService).execution;
        expect(execution).not.toBeNull();
        expect(execution!.workId).toBeNull();
        expect(execution!.slots).toBeNull();
        const listed = await world.read('/system/workers', z.array(WorkerSchema));
        const online = listed.filter((w) => w.status === 'online').map((w) => w.sandboxProven);
        expect(online.toSorted((a, b) => Number(a) - Number(b))).toEqual([false, true]);

        const id = await world.launch('unproven-worker', baseline, [candidate], {
          taskKeys: ['numeric'],
          repetitions: 2,
        });
        await world.completed(id);
        const ran = await attemptsOf(id);
        expect(ran).toHaveLength(4);
        const provenId = proven.get(WorkerPresenceService).id;
        const unprovenId = unproven.get(WorkerPresenceService).id;
        expect(provenId).toBeTruthy();
        expect(unprovenId).toBeTruthy();
        expect(new Set(ran.map(({ attempt }) => attempt.workerId))).toEqual(new Set([provenId]));
      } finally {
        await unproven.close();
      }
    }, 120_000);

    it('leaves no trial container, egress registration or trial home behind', async () => {
      expect(world.engine.present()).toEqual([]);
      expect(world.egress.registrations.size).toBe(0);
      const inFlight = await world.db.select({ n: workers.inFlight }).from(workers);
      expect(inFlight.every((w) => w.n === 0)).toBe(true);
      // Every attempt has ended, the worker_lost ones too, and none kept its home
      // (Hermes's session state): a finish deletes it, and so does recovery's finalise.
      const all = await world.db
        .select({ id: attempts.id, status: attempts.status })
        .from(attempts);
      expect(all.length).toBeGreaterThan(0);
      expect(all.filter((a) => a.status === 'running')).toEqual([]);
      const homes = readdirSync(world.trialsDir).filter((id) =>
        existsSync(join(world.trialsDir, id, 'home')),
      );
      expect(homes).toEqual([]);
      // The workspaces stay for retention.
      expect(readdirSync(world.trialsDir).length).toBeGreaterThan(0);
    });
  });

  /** A configuration's saved settings, as the edit form sends them back. */
  async function configInput(ref: ConfigRef): Promise<ConfigurationInput> {
    return (
      await world.read(`/configurations/${ref.configurationId}/draft`, ConfigurationDraftSchema)
    ).values;
  }
});
