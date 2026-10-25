/**
 * The evaluation claim through a scoring pass, on PGlite (Phase 3 S8): it is
 * renewed after each key, so a pass that outlives one claim keeps it; a
 * delivery that finds its claim taken, or whose pg-boss job was failed under
 * it, stops at the next key and leaves no trace; duplicate deliveries publish
 * once; and a re-score of a run graded before the judge was configured
 * publishes a new generation that supersedes the old one.
 *
 * Renewals are observed through a pass-through wrapper of renewClaim that
 * reads the claim row just before and just after each call, so the test
 * asserts what renewal did rather than sampling the clock, which a loaded
 * machine can starve.
 */
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VerificationEntry } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { evaluations, runs, scores } from '../database/schema/index.js';
import type { JudgeResponse } from '../scoring/judge/contracts.js';
import { SCORER_VERSIONS } from '../scoring/registry.js';
import { BlobStore } from '../storage/blob-store.js';
import { claimEvaluation, claimExpiry, renewClaim } from './claim.js';
import { handleEvaluateRunJob } from './evaluate-run.handler.js';
import {
  executeRun,
  fenced,
  logger,
  recordingReconcile,
  seedScenario,
  type ScenarioTask,
} from './support-spec.js';
import { FakeJudge, judgeAnswer, MOCK_JUDGE_SETTINGS, verdictText } from './support-judge-spec.js';

interface ClaimRow {
  token: string | null;
  expires: Date | null;
}

/** Every renewal any delivery made, with the claim row around it. */
const renewals = vi.hoisted(
  () =>
    [] as Array<{
      evaluationId: string;
      token: string;
      renewed: boolean;
      before: ClaimRow;
      after: ClaimRow;
    }>,
);

vi.mock('./claim.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claim.js')>();
  const { evaluations: table } = await import('../database/schema/index.js');
  const { eq: equals } = await import('drizzle-orm');
  const read = async (db: Parameters<typeof actual.renewClaim>[0], id: string) =>
    (
      await db
        .select({ token: table.claimToken, expires: table.claimExpiresAt })
        .from(table)
        .where(equals(table.id, id))
    )[0]!;
  return {
    ...actual,
    renewClaim: async (...args: Parameters<typeof actual.renewClaim>) => {
      const [db, claim] = args;
      const before = await read(db, claim.evaluationId);
      const renewed = await actual.renewClaim(...args);
      const after = await read(db, claim.evaluationId);
      renewals.push({
        evaluationId: claim.evaluationId,
        token: claim.token,
        renewed,
        before,
        after,
      });
      return renewed;
    },
  };
});

const renewalsOf = (evaluationId: string) =>
  renewals.filter((r) => r.evaluationId === evaluationId);

let t: TestDatabase;
let dataDir: string;
let store: BlobStore;
let markers: string;

beforeAll(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-claim-'));
  markers = await mkdtemp(join(tmpdir(), 'hermes-evals-claim-markers-'));
  store = new BlobStore(dataDir);
});

afterAll(async () => {
  await t?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (markers) await rm(markers, { recursive: true, force: true });
});

/** A verifier that takes `seconds`, optionally leaves a marker file, and passes. */
const verifier = (seconds: number, marker?: string) => `import argparse, json, time
parser = argparse.ArgumentParser()
parser.add_argument("--answer")
parser.add_argument("--workspace")
parser.parse_args()
${marker ? `open(${JSON.stringify(marker)}, "w").write("ran")\n` : ''}time.sleep(${seconds})
print(json.dumps({"score": 1, "comment": "slow but sure"}))
`;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const evaluationRow = async (id: string) =>
  (await t.db.select().from(evaluations).where(eq(evaluations.id, id)))[0]!;

const scoresOf = async (evaluationId: string) =>
  t.db.select().from(scores).where(eq(scores.evaluationId, evaluationId)).orderBy(asc(scores.key));

/** Resolves when `check` holds, polling every 10 ms for at most 10 s. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in 10 s');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('claim renewal', () => {
  it('keeps the claim alive through verifiers that together outlive one claim', async () => {
    const slow = (key: string, primary = false): VerificationEntry => ({
      key,
      type: 'verifier_script',
      primary,
      params: { script: 'slow.py' },
    });
    const task: ScenarioTask = {
      verification: [slow('first', true), slow('second'), slow('third')],
      reference: { total: 1 },
      files: [{ path: 'verify/slow.py', kind: 'verifier', content: verifier(0.8) }],
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: fenced({ total: 1 }),
    });

    // A two-second claim: three keys of nearly a second each outlive it unless renewed.
    const started = Date.now();
    const result = await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile: recordingReconcile().reconcile, claimSeconds: 2 },
      logger(),
    );
    const finished = Date.now();

    expect(result.outcome).toBe('published');
    expect((await scoresOf(evaluationId)).map((s) => [s.key, s.status])).toEqual([
      ['first', 'passed'],
      ['second', 'passed'],
      ['third', 'passed'],
    ]);
    // The pass took longer than one claim lasts (each verifier sleeps 0.8 s).
    expect(finished - started).toBeGreaterThan(2_000);
    // Renewed after the first and the second key, never after the last; each
    // renewal moved the expiry forward and kept this delivery's token.
    const seen = renewalsOf(evaluationId);
    expect(seen).toHaveLength(2);
    const token = seen[0]!.token;
    for (const renewal of seen) {
      expect(renewal.renewed).toBe(true);
      expect(renewal.before.token).toBe(token);
      expect(renewal.after.token).toBe(token);
      expect(renewal.after.expires!.getTime()).toBeGreaterThan(renewal.before.expires!.getTime());
    }
    expect(seen[1]!.before.expires).toEqual(seen[0]!.after.expires);
  });

  it('stops at the next key when a newer delivery took the claim, and writes nothing', async () => {
    const marker = join(markers, 'after-judge');
    const task: ScenarioTask = {
      verification: [
        { key: 'answer', type: 'numeric_tolerance', primary: true, params: { path: 'total' } },
        { key: 'quality', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
        { key: 'after', type: 'verifier_script', primary: false, params: { script: 'mark.py' } },
      ],
      reference: { total: 1042 },
      files: [
        { path: 'rubric.md', kind: 'rubric', content: 'Is the total right?\n' },
        { path: 'verify/mark.py', kind: 'verifier', content: verifier(0, marker) },
      ],
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: fenced({ total: 1042 }),
    });
    let release!: (answer: JudgeResponse) => void;
    const gated = new FakeJudge(
      () =>
        new Promise<JudgeResponse>((resolve) => {
          release = resolve;
        }),
    );
    const deps = {
      db: t.db,
      store,
      reconcile: recordingReconcile().reconcile,
      judge: gated,
      judgeSettings: MOCK_JUDGE_SETTINGS,
    };
    const stale = handleEvaluateRunJob({ evaluationId }, deps, logger());

    // While the judge is thinking, recovery re-sent the job and a newer delivery claimed it.
    await until(() => gated.requests.length === 1);
    const newer = await claimEvaluation(t.db, evaluationId);
    expect(newer).not.toBeNull();
    release(judgeAnswer(verdictText(0.9, 'Right.')));

    expect(await stale).toEqual({ evaluationId, outcome: 'lost' });
    expect(await scoresOf(evaluationId)).toEqual([]);
    expect(await exists(marker)).toBe(false);
    expect(await evaluationRow(evaluationId)).toMatchObject({
      status: 'running',
      claimToken: newer!.token,
    });
    expect(await readdir(store.tmpRoot)).toEqual([]);
  });

  it('stops at the next key once pg-boss failed the job under it, and writes nothing', async () => {
    const marker = join(markers, 'after-abort');
    const task: ScenarioTask = {
      verification: [
        { key: 'answer', type: 'numeric_tolerance', primary: true, params: { path: 'total' } },
        { key: 'quality', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
        { key: 'after', type: 'verifier_script', primary: false, params: { script: 'mark.py' } },
      ],
      reference: { total: 1042 },
      files: [
        { path: 'rubric.md', kind: 'rubric', content: 'Is the total right?\n' },
        { path: 'verify/mark.py', kind: 'verifier', content: verifier(0, marker) },
      ],
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: fenced({ total: 1042 }),
    });
    let release!: (answer: JudgeResponse) => void;
    const gated = new FakeJudge(
      () =>
        new Promise<JudgeResponse>((resolve) => {
          release = resolve;
        }),
    );
    const job = new AbortController();
    const deps = {
      db: t.db,
      store,
      reconcile: recordingReconcile().reconcile,
      judge: gated,
      judgeSettings: MOCK_JUDGE_SETTINGS,
    };
    const delivery = handleEvaluateRunJob({ evaluationId }, deps, logger(), job.signal);

    // While the judge is thinking, pg-boss expires the job and aborts its signal.
    await until(() => gated.requests.length === 1);
    const claimed = await evaluationRow(evaluationId);
    job.abort();
    release(judgeAnswer(verdictText(0.9, 'Right.')));

    expect(await delivery).toEqual({ evaluationId, outcome: 'lost' });
    expect(await scoresOf(evaluationId)).toEqual([]);
    expect(await exists(marker)).toBe(false);
    // Renewed after the first key only; the claim is left for the retry to take.
    expect(renewalsOf(evaluationId)).toHaveLength(1);
    expect(await evaluationRow(evaluationId)).toMatchObject({
      status: 'running',
      claimToken: claimed.claimToken,
    });
    expect(await readdir(store.tmpRoot)).toEqual([]);
  });

  it('renews only while the token is still the evaluation’s', async () => {
    const task: ScenarioTask = {
      verification: [{ key: 'answer', type: 'exact_match', primary: true, params: {} }],
      reference: 'x',
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: fenced('x'),
    });
    const first = (await claimEvaluation(t.db, evaluationId, 60))!;
    const before = (await evaluationRow(evaluationId)).claimExpiresAt!;
    expect(await renewClaim(t.db, first, 600)).toBe(true);
    expect((await evaluationRow(evaluationId)).claimExpiresAt!.getTime()).toBeGreaterThan(
      before.getTime(),
    );
    const second = (await claimEvaluation(t.db, evaluationId))!;
    expect(await renewClaim(t.db, first)).toBe(false);
    expect(await renewClaim(t.db, second)).toBe(true);
    expect(() => claimExpiry(0)).toThrow(RangeError);
    expect(() => claimExpiry(1.5)).toThrow(RangeError);
  });
});

describe('deliveries and re-scores with the Phase 3 types', () => {
  const RUBRIC = 'Does the reply state the rule?\n';
  const task: ScenarioTask = {
    verification: [
      {
        key: 'answer',
        type: 'text_match',
        primary: true,
        params: { path: 'rule', contains: ['1.5%', '30 days'] },
      },
      {
        key: 'reads',
        type: 'trajectory_match',
        primary: false,
        params: { tool: 'read_file', args: { path: 'policy_terms.json' } },
      },
      { key: 'quality', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
    ],
    reference: { rule: 'A late fee of 1.5% per month applies after 30 days.' },
    files: [{ path: 'rubric.md', kind: 'rubric', content: RUBRIC }],
  };
  const evidence = {
    finalText: fenced({ rule: 'After 30 days unpaid, 1.5% per month.' }),
    events: [
      {
        type: 'tool_use' as const,
        name: 'read_file',
        tool_call_id: 'c0',
        input: { path: 'policy_terms.json' },
      },
      { type: 'tool_result' as const, name: 'read_file', tool_call_id: 'c0', output: '{}' },
    ],
  };
  const judge = () => new FakeJudge(() => judgeAnswer(verdictText(0.8, 'States the rule.')));

  it('publishes once when two deliveries of the same job run together', async () => {
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, evidence);
    const deps = {
      db: t.db,
      store,
      reconcile: recordingReconcile().reconcile,
      judge: judge(),
      judgeSettings: MOCK_JUDGE_SETTINGS,
    };
    const outcomes = await Promise.all([
      handleEvaluateRunJob({ evaluationId }, deps, logger()),
      handleEvaluateRunJob({ evaluationId }, deps, logger()),
    ]);
    expect(outcomes.filter((o) => o.outcome === 'published')).toHaveLength(1);
    expect((await scoresOf(evaluationId)).map((s) => [s.key, s.status])).toEqual([
      ['answer', 'passed'],
      ['quality', 'passed'],
      ['reads', 'passed'],
    ]);
    // A third delivery after publishing finds nothing to do.
    expect((await handleEvaluateRunJob({ evaluationId }, deps, logger())).outcome).toBe('finished');
  });

  it('re-scores a run graded without a judge: the new generation supersedes the old', async () => {
    const scenario = await seedScenario(t.db, store, task);
    const runId = scenario.runIds[0]!;
    const { attemptId, evaluationId: firstId } = await executeRun(
      t.db,
      store,
      scenario,
      runId,
      evidence,
    );
    const base = { db: t.db, store, reconcile: recordingReconcile().reconcile };
    await handleEvaluateRunJob({ evaluationId: firstId }, base, logger());
    const first = await scoresOf(firstId);
    expect(first.find((s) => s.key === 'quality')).toMatchObject({ status: 'error', score: null });

    // The judge is configured now; POST /runs/:id/rescore inserts the next generation.
    const [rescore] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2 })
      .returning({ id: evaluations.id });
    const result = await handleEvaluateRunJob(
      { evaluationId: rescore!.id },
      { ...base, judge: judge(), judgeSettings: MOCK_JUDGE_SETTINGS },
      logger(),
    );
    expect(result.outcome).toBe('published');
    const second = await scoresOf(rescore!.id);
    expect(second.map((s) => [s.key, s.status, s.scorerVersion])).toEqual([
      ['answer', 'passed', SCORER_VERSIONS.text_match],
      ['quality', 'passed', SCORER_VERSIONS.llm_judge],
      ['reads', 'passed', SCORER_VERSIONS.trajectory_match],
    ]);
    expect((await evaluationRow(firstId)).supersededAt).toBeInstanceOf(Date);
    const current = await t.db
      .select({ id: evaluations.id, generation: evaluations.generation })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.runId, runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      );
    expect(current).toEqual([{ id: rescore!.id, generation: 2 }]);
    expect((await t.db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('scored');
    // The old generation's scores stay as they were.
    expect(await scoresOf(firstId)).toEqual(first);
  });
});
