/**
 * Phase 3 end to end: every check type scored for real, and re-score, on
 * the real AppModule and WorkerModule over a fresh Postgres 17 database,
 * with real pg-boss, the real lifecycle, runner and evaluate-run handler.
 * As in Phase 2 only the sandbox is replaced (test/support/fake-engine.ts):
 * the fake engine plays the trials, and the fake egress also serves the LLM
 * judge's path, so the judge client, its registration, metering and
 * removal run as in production while no model is ever called. Every HTTP
 * answer is parsed with its shared schema.
 *
 * The suite (test/fixtures/phase3-suite) has four tasks whose checks are,
 * between them, all eight types; `right` answers each task right and
 * `wrong` gets each wrong in its own way (test/support/phase3-trials.ts).
 * The judge runs on Nous (JUDGE_PROVIDER), whose readiness the tests turn
 * off and on through the fake nous-login. invoice_total's `method` names its
 * own model; late_fee_rule's `tone` names none and is graded by JUDGE_MODEL
 * (a key no model can grade is refused at launch, Phase 3 question 2).
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BulkRescoreResultSchema,
  NewExperimentOptionsSchema,
  RescoreRunResultSchema,
  RunDetailSchema,
  RunListResultSchema,
  SCORER_TYPES,
  ScoreEvidenceSchema,
  TaskDetailSchema,
  type RunDetail,
} from '@hermes-evals/shared';
import * as schema from '../src/database/schema/index.js';
import { QueueService } from '../src/queue/queue.service.js';
import { QUEUES } from '../src/queue/queues.js';
import { SCORER_VERSIONS } from '../src/scoring/registry.js';
import { Phase2World, waitFor, type ConfigRef } from './support/phase2-app.js';
import {
  JUDGE_MODEL,
  PHASE3_PRICES,
  PHASE3_SUITE,
  Phase3Trials,
  ScriptedJudge,
  TONE_VERDICT,
  VERDICTS,
  type Phase3Config,
  type Phase3Task,
} from './support/phase3-trials.js';
import { expectScores } from './support/phase3-expected.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const { configurationVersions, evaluations, experiments, runEvents, runs, scores, tasks } = schema;

const NOUS_DOWN = 'Nous Portal is not connected.';
const TOKEN_CAP = 1_500_000;

describe.skipIf(!SERVER_URL)('Phase 3 on Postgres 17: every check type, then re-score', () => {
  const trials = new Phase3Trials();
  const judge = new ScriptedJudge();
  const world = new Phase2World(SERVER_URL!, 'phase3_e2e', {
    suite: PHASE3_SUITE,
    prices: PHASE3_PRICES,
    script: trials.script,
    judge: judge.model,
    // JUDGE_MODEL grades late_fee_rule's `tone`, which names no model of its own.
    env: {
      JUDGE_PROVIDER: 'nous',
      JUDGE_MODEL,
      MODEL_TOKEN_CAP_PER_ATTEMPT: String(TOKEN_CAP),
    },
  });
  const configs = {} as Record<Phase3Config, ConfigRef>;
  let main = '';
  /** Run id by `task/config` in the main experiment. */
  const runIds = new Map<string, string>();
  const runOf = (task: Phase3Task, config: Phase3Config) => runIds.get(`${task}/${config}`)!;

  beforeAll(async () => {
    await world.start();
    await world.startWorker();
  }, 120_000);

  afterAll(async () => {
    judge.release();
    trials.release();
    await world.stop();
  }, 120_000);

  const detail = (runId: string): Promise<RunDetail> =>
    world.read(`/runs/${runId}`, RunDetailSchema);

  const evaluationsOf = (runId: string) =>
    world.db
      .select()
      .from(evaluations)
      .where(eq(evaluations.runId, runId))
      .orderBy(asc(evaluations.generation));

  /** The current evaluation's score rows by key; each row's version and evidence checked. */
  async function currentScores(runId: string) {
    const [current] = (await evaluationsOf(runId)).filter(
      (e) => e.status === 'completed' && e.supersededAt === null,
    );
    expect(current, `run ${runId} has a current evaluation`).toBeDefined();
    const rows = await world.db
      .select()
      .from(scores)
      .where(eq(scores.evaluationId, current!.id))
      .orderBy(asc(scores.key));
    for (const row of rows) {
      expect(row.scorerVersion, row.key).toBe(SCORER_VERSIONS[row.type]);
      ScoreEvidenceSchema.parse(row.evidence);
    }
    return { evaluation: current!, byKey: Object.fromEntries(rows.map((r) => [r.key, r])) };
  }

  /** The sequence numbers of the run's current attempt's tool_use events of `tool`. */
  async function toolUseSeqs(runId: string, tool: string): Promise<number[]> {
    const [run] = await world.db.select().from(runs).where(eq(runs.id, runId));
    const events = await world.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.attemptId, run!.currentAttemptId!), eq(runEvents.type, 'tool_use')))
      .orderBy(asc(runEvents.seq));
    return events.filter((e) => (e.payload as { name?: string }).name === tool).map((e) => e.seq);
  }

  const resultsRevision = async (id: string): Promise<number> =>
    (await world.db.select().from(experiments).where(eq(experiments.id, id)))[0]!.resultsRevision;

  it('loads a suite whose four tasks use all eight check types, each self-checked', async () => {
    const options = await world.read('/experiments/new-options', NewExperimentOptionsSchema);
    const suite = options.suites.find((s) => s.name === PHASE3_SUITE.name)!;
    expect(suite.tasks.map((t) => [t.key, t.valid])).toEqual(
      PHASE3_SUITE.tasks.map((key) => [key, true]),
    );
    const stored = await world.db.select().from(tasks).where(eq(tasks.suiteId, suite.suiteId));
    const types = new Set(stored.flatMap((t) => t.verification.map((v) => v.type)));
    expect([...types].sort()).toEqual([...SCORER_TYPES].sort());

    const rule = await world.read(`/suites/${suite.suiteId}/tasks/late_fee_rule`, TaskDetailSchema);
    expect(rule.verification.map((v) => v.sentence)).toEqual([
      'text_match on rule, contains "1.5%", "30 days", matches /after \\d+ days/',
      'llm_judge with rubric rubric.md, pass at score ≥ 0.7',
    ]);

    configs.right = await world.configuration('right', 'mock/right');
    configs.wrong = await world.configuration('wrong', 'mock/wrong');
  });

  it("refuses a launch while the judge's provider is not ready", async () => {
    const body = await world.launchBody('Judged', configs.right, [configs.wrong]);
    const refusal = await world.refused('post', '/experiments', body, 409);
    expect(refusal.message).toBe(`The LLM judge's provider is not ready: ${NOUS_DOWN}`);
    expect(await world.db.select().from(experiments)).toEqual([]);
  });

  it('runs the matrix to scored, with tool_search off and the token cap on every trial', async () => {
    world.nous.approve();
    main = await world.launch('Right against wrong', configs.right, [configs.wrong]);
    const done = await world.completed(main);
    expect(done.counts.scored).toBe(8);

    const rows = await world.db
      .select({ id: runs.id, task: tasks.key, versionId: configurationVersions.id })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
      .where(eq(runs.experimentId, main));
    for (const row of rows) {
      const config = row.versionId === configs.right.versionId ? 'right' : 'wrong';
      runIds.set(`${row.task}/${config}`, row.id);
    }
    expect(runIds.size).toBe(8);

    // S9 #1 and #2: Hermes's tool_search off in every config.yaml; the worker's cap on every registration.
    expect(trials.configYamls).toHaveLength(8);
    for (const yaml of trials.configYamls) expect(yaml).toMatch(/tool_search:\n\s+enabled: off/);
    const registrations = world.egress.history.map((h) => h.registration);
    expect(registrations).toHaveLength(8);
    for (const r of registrations) expect(r.maxTokens).toBe(TOKEN_CAP);

    // S9 #4: the gateway's model call is a network row of kind model.
    const shown = await detail(runOf('ledger', 'right'));
    const network = shown.timeline.events.filter((e) => e.kind === 'network');
    expect(network.map((e) => e.network?.kind)).toEqual(['model']);
  });

  it('grades every key of every run right and wrong, through the views and the stored rows', async () => {
    for (const task of PHASE3_SUITE.tasks) {
      for (const config of ['right', 'wrong'] as const) {
        const runId = runOf(task, config);
        const shown = await detail(runId);
        expect(shown.status, `${task}/${config}`).toBe('scored');
        expect(shown.evaluation).toEqual({ generation: 1, pending: null, lastFailure: null });
        const { byKey } = await currentScores(runId);
        const seqs = {
          readFile: await toolUseSeqs(runId, 'read_file'),
          terminal: await toolUseSeqs(runId, 'terminal'),
        };
        expectScores(task, config, { view: shown.scores, rows: byKey, seqs });
      }
    }
    const list = await world.read(`/experiments/${main}/runs`, RunListResultSchema);
    expect(list.summary).toMatchObject({ total: 8, passed: 5, failed: 2, ungradable: 1 });
    for (const row of list.rows) {
      expect(row).toMatchObject({ generation: 1, rescorePending: false });
      const judgedTask = row.taskKey === 'invoice_total' || row.taskKey === 'late_fee_rule';
      expect(row.needs.judgeProvider).toBe(judgedTask ? 'nous' : null);
    }
  });

  it('meters each judge call through egress like an attempt, and prices it as grading cost', async () => {
    // invoice_total's `method` and late_fee_rule's `tone`, once per run.
    expect(world.egress.judgeHistory).toHaveLength(4);
    expect(world.egress.judges.size).toBe(0);
    expect(world.egress.judgesRemoved.sort()).toEqual(
      world.egress.judgeHistory.map((r) => r.judgeId).sort(),
    );
    for (const record of world.egress.judgeHistory) {
      expect(record.registration).toMatchObject({
        kind: 'judge',
        provider: 'nous',
        model: JUDGE_MODEL,
        maxTokens: 200_000,
      });
      expect(record.registration).not.toHaveProperty('upstream');
      expect(record.bodies).toHaveLength(1);
      const [body] = record.bodies;
      expect(body).toMatchObject({
        model: JUDGE_MODEL,
        temperature: 0,
        max_tokens: 4096,
        stream: false,
        response_format: { type: 'json_object' },
      });
      const [, user] = body!.messages;
      expect(user!.content).toMatch(/^<<<AGENT_RESPONSE_BEGIN [0-9a-f]{32}>>>\n/);
    }
    const systems = world.egress.judgeHistory.map((r) => r.bodies[0]!.messages[0]!.content);
    const method = systems.filter((s) => s.includes('Add up the `amount` column of `amounts.csv`'));
    expect(method).toHaveLength(2);
    for (const s of method) expect(s).toContain('Full marks when the reply gives the right total');
    const tone = systems.filter((s) => s.includes('State the late fee rule in `terms.md`'));
    expect(tone).toHaveLength(2);
    for (const s of tone) expect(s).toContain('Full marks when the rule is stated plainly');
    // Judge cost is grading cost (plan 9.5): the trials are free, so the spend stays 0
    // although each judge call cost JUDGE_CALL_COST_USD (in its score's evidence).
    expect((await world.detail(main)).spend).toMatchObject({ spentUsd: 0, unpricedAttempts: 0 });
  });

  it('re-scores a run: a double request collapses, duplicate deliveries publish once, generation 2 supersedes 1', async () => {
    const runId = runOf('invoice_total', 'wrong');
    const before = await currentScores(runId);
    const revision = await resultsRevision(main);
    const asked = judge.asked.length;
    judge.hold();

    const first = await world.send(
      'post',
      `/runs/${runId}/rescore`,
      {},
      200,
      RescoreRunResultSchema,
    );
    expect(first).toMatchObject({
      runId,
      status: 'scored',
      attempt: null,
      joinedPending: false,
      evaluation: { generation: 2, cause: 'rescore' },
    });
    const evaluationId = first.evaluation.evaluationId;
    await waitFor('the re-score to reach its judge', async () =>
      judge.asked.length > asked ? true : undefined,
    );
    const again = await world.send(
      'post',
      `/runs/${runId}/rescore`,
      {},
      200,
      RescoreRunResultSchema,
    );
    expect(again).toMatchObject({
      joinedPending: true,
      evaluation: { evaluationId, generation: 2, status: 'running' },
    });

    // Two concurrent requests on another run make one evaluation, and one of them joins it.
    const other = runOf('invoice_total', 'right');
    const pair = await Promise.all(
      [0, 1].map(() =>
        world.send('post', `/runs/${other}/rescore`, {}, 200, RescoreRunResultSchema),
      ),
    );
    expect(pair.filter((r) => r.joinedPending)).toHaveLength(1);
    expect(new Set(pair.map((r) => r.evaluation.evaluationId)).size).toBe(1);

    // While it runs the run stays scored, on generation 1's result, with the re-score pending.
    const pending = await detail(runId);
    expect(pending.status).toBe('scored');
    expect(pending.evaluation).toMatchObject({
      generation: 1,
      pending: { evaluationId, generation: 2, status: 'running', cause: 'rescore' },
    });
    const row = (await world.read(`/experiments/${main}/runs`, RunListResultSchema)).rows.find(
      (r) => r.id === runId,
    );
    expect(row).toMatchObject({ generation: 1, rescorePending: true });

    // Two more deliveries of the same evaluation, as pg-boss or recovery could send.
    const boss = world.api.get(QueueService).instance;
    for (const n of [1, 2]) {
      await boss.send(
        QUEUES.evaluateRun,
        { evaluationId },
        { singletonKey: `${evaluationId}:${n}` },
      );
    }
    judge.release();
    const jobs = await waitFor('every delivery to finish', async () => {
      const found = await boss.findJobs<{ evaluationId: string }>(QUEUES.evaluateRun, {
        data: { evaluationId },
      });
      return found.length === 3 && found.every((j) => j.state === 'completed') ? found : undefined;
    });
    const outcomes = jobs.map((j) => (j.output as { outcome: string }).outcome);
    expect(outcomes.filter((o) => o === 'published')).toHaveLength(1);
    expect(
      outcomes.filter((o) => o !== 'published').every((o) => o === 'lost' || o === 'finished'),
    ).toBe(true);

    const [gen1, gen2] = await evaluationsOf(runId);
    expect(gen1).toMatchObject({ generation: 1, status: 'completed' });
    expect(gen1!.supersededAt).not.toBeNull();
    expect(gen2).toMatchObject({
      id: evaluationId,
      generation: 2,
      status: 'completed',
      cause: 'rescore',
      supersededAt: null,
    });
    const after = await currentScores(runId);
    expect(after.evaluation.id).toBe(evaluationId);
    expect(Object.keys(after.byKey)).toEqual(Object.keys(before.byKey));
    for (const key of Object.keys(before.byKey)) {
      expect(after.byKey[key]).toMatchObject({
        status: before.byKey[key]!.status,
        score: before.byKey[key]!.score,
        scorerVersion: before.byKey[key]!.scorerVersion,
      });
    }
    expect(after.byKey['method']!.comment).toContain(VERDICTS.wrong.comment);
    expect(await resultsRevision(main)).toBeGreaterThan(revision);
    const shown = await detail(runId);
    expect(shown).toMatchObject({ status: 'scored', evaluation: { generation: 2, pending: null } });
    await waitFor('the other re-score to publish', async () =>
      (await detail(other)).evaluation.generation === 2 ? true : undefined,
    );
    expect((await world.detail(main)).status).toBe('completed');
    expect(world.egress.judges.size).toBe(0);
  });

  it("bulk re-score accepts, joins and refuses per run; the judge's provider not ready is a 409", async () => {
    const invoiceWrong = runOf('invoice_total', 'wrong');
    const invoiceRight = runOf('invoice_total', 'right');
    const ledgerRight = runOf('ledger', 'right');
    const lateFeeWrong = runOf('late_fee_rule', 'wrong');
    const unknown = '01K8ZZZZZZZZZZZZZZZZZZZZZZ';
    const asked = judge.asked.length;
    judge.hold();
    const pending = await world.send(
      'post',
      `/runs/${invoiceWrong}/rescore`,
      {},
      200,
      RescoreRunResultSchema,
    );
    await waitFor('the re-score to reach its judge', async () =>
      judge.asked.length > asked ? true : undefined,
    );

    world.nous.volume = 'not_connected';
    const judgeReason = `Re-score needs Nous Portal for the method judge: ${NOUS_DOWN}`;
    const refusal = await world.refused('post', `/runs/${invoiceRight}/rescore`, {}, 409);
    expect(refusal.message).toBe(judgeReason);
    const bulk = await world.send(
      'post',
      `/experiments/${main}/runs/rescore`,
      { runIds: [ledgerRight, invoiceWrong, invoiceRight, lateFeeWrong, unknown] },
      200,
      BulkRescoreResultSchema,
    );
    expect(bulk.enqueued).toEqual([ledgerRight, invoiceWrong]);
    expect(bulk.refused).toEqual([
      { runId: invoiceRight, reason: judgeReason },
      // Its judge runs on JUDGE_MODEL, on the same provider.
      {
        runId: lateFeeWrong,
        reason: `Re-score needs Nous Portal for the tone judge: ${NOUS_DOWN}`,
      },
      { runId: unknown, reason: 'run not found in this experiment' },
    ]);
    expect(bulk.evaluations.map((e) => [e.runId, e.generation, e.joinedPending])).toEqual([
      [ledgerRight, 2, false],
      [invoiceWrong, 3, true],
    ]);
    expect(bulk.evaluations[1]!.evaluationId).toBe(pending.evaluation.evaluationId);

    world.nous.approve();
    judge.release();
    // With Nous back, the key graded by JUDGE_MODEL re-scores too.
    const lateFeeAgain = await world.send(
      'post',
      `/runs/${lateFeeWrong}/rescore`,
      {},
      200,
      RescoreRunResultSchema,
    );
    expect(lateFeeAgain.evaluation.generation).toBe(2);
    for (const [runId, generation] of [
      [ledgerRight, 2],
      [invoiceWrong, 3],
      [lateFeeWrong, 2],
    ] as const) {
      await waitFor(`run ${runId} generation ${generation}`, async () =>
        (await detail(runId)).evaluation.generation === generation ? true : undefined,
      );
    }
    const lateFee = await currentScores(lateFeeWrong);
    expect(lateFee.byKey['tone']).toMatchObject({ status: 'passed', score: TONE_VERDICT.score });
    expect(lateFee.byKey['tone']!.comment).toContain(TONE_VERDICT.comment);
    expect((await detail(lateFeeWrong)).status).toBe('scored');
  });

  it('refuses to re-score a run that is not scored', async () => {
    trials.hold();
    const id = await world.launch('Held', configs.right, [configs.wrong], { taskKeys: ['ledger'] });
    const [running] = await world.runsIn(id, 'running', 1);
    const refusal = await world.refused('post', `/runs/${running!.id}/rescore`, {}, 409);
    expect(refusal.message).toBe('run is running, not scored');
    const bulk = await world.send(
      'post',
      `/experiments/${id}/runs/rescore`,
      { runIds: [running!.id] },
      200,
      BulkRescoreResultSchema,
    );
    expect(bulk).toEqual({
      action: 'rescore',
      enqueued: [],
      refused: [{ runId: running!.id, reason: 'run is running, not scored' }],
      evaluations: [],
    });
    trials.release();
    await world.completed(id);
  });
});
