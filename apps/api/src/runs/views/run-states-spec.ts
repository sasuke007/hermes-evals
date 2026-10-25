/**
 * Puts the runs of seedRunStates' experiment into every state the inspector
 * draws (UI_FLOWS 18), each written through the worker's own sequence of
 * steps, so the triggers accept it:
 *
 *   dup_invoices/baseline/1    scored: failed, error and passed keys; the recorded
 *                              Hermes run plus egress's log; four artifacts
 *   dup_invoices/baseline/2    scored, ungradable (no fenced block); re-scored as
 *                              generation 2, then a re-score (3) that failed
 *   dup_invoices/baseline/3    scored, the primary scorer broke
 *   dup_invoices/baseline/4    execution_error · provider
 *   dup_invoices/baseline/5    execution_error · timeout, twice (two attempts)
 *   dup_invoices/with-skill/1  scored, passed (the counterpart of baseline/1); a
 *                              re-score (generation 2) queued
 *   dup_invoices/with-skill/2  execution_error · setup
 *   dup_invoices/with-skill/3  execution_error · worker_lost (recovery)
 *   dup_invoices/with-skill/4  execution_error · other (disk cap)
 *   dup_invoices/with-skill/5  running, a tool call open
 *   total_due/baseline/1       cancelled by the user mid-run
 *   total_due/baseline/2       timeout, then scored passed on attempt 2
 *   total_due/baseline/4       queued for a retry after a provider error
 *   total_due/with-skill/1     executed, not scored yet
 *   every other run            queued
 *
 * Test-only (see runs-seed-spec.ts).
 */
import type { TestDb } from '../../../test/support/database.js';
import {
  RECORDED_PROVIDER_FAILURE,
  RECORDED_RUN,
  RECORDED_START_MS,
  recordedEvents,
} from './recorded-run-spec.js';
import type { EventRecord } from './rows.js';
import {
  INVOICES_CSV,
  REPORT_HTML,
  SUMMARY_CSV,
  tokens,
  type ScoreSeed,
} from './run-fixtures-spec.js';
import { seedRunStates } from './runs-seed-spec.js';

/** Why the seeded re-score of dup_invoices/baseline/2 failed, as the dead letter words it. */
export const RESCORE_FAILURE = 'grading failed after 3 tries: verifier timed out';

export const RECORDED_FINAL = 'Total done.\n```json\n{"total": 1042}\n```';
const PHASE3 = (type: string) => ({
  comment: `${type} is scored from Phase 3`,
  evidence: { error: { message: `${type} is scored from Phase 3`, detail: null } },
});

const platform = (seq: number, ts: number, payload: Record<string, unknown>): EventRecord => ({
  seq,
  ts,
  type: 'platform',
  payload: { type: 'platform', ...payload } as never,
});

/**
 * The `collected` payload as execution/attempt/collect.ts writes it, plus
 * `stderr_lines` (the count of stderr.log the inspector asks the runner for).
 */
const collected = (fields: {
  files: number;
  agent_files?: number;
  stderr_lines: number;
}): Record<string, unknown> => ({
  subtype: 'collected',
  stored: fields.files,
  stored_bytes: 1024,
  too_large: [],
  agent_files: 0,
  not_collected: [],
  not_collected_count: 0,
  deleted_inputs: [],
  deleted_input_count: 0,
  ...fields,
});

const hermes = (seq: number, ts: number, payload: Record<string, unknown>): EventRecord => ({
  seq,
  ts,
  type: payload['type'] as EventRecord['type'],
  payload: { ...payload, timestamp: ts } as never,
});

/** A full score set of a dup_invoices run: its answer, its trajectory key and its verifier. */
export const dupScores = (
  answer: ScoreSeed,
  check: Omit<ScoreSeed, 'key' | 'type'>,
): ScoreSeed[] => [
  answer,
  {
    key: 'reads_fixture',
    type: 'trajectory_match',
    status: 'error',
    ...PHASE3('trajectory_match'),
  },
  { key: 'check', type: 'verifier_script', ...check },
];

export async function seedAllStates(db: TestDb) {
  const s = await seedRunStates(db);
  const t0 = new Date('2026-10-24T15:30:00.000Z').getTime();

  // dup_invoices/baseline/1: the recorded run, then egress's log and the collected event.
  const recorded = await s.start('dup_invoices/baseline/1', 1, new Date(RECORDED_START_MS - 300));
  await s.addEvents(recorded, [
    ...recordedEvents(),
    platform(8, RECORDED_START_MS + 5_000, {
      subtype: 'network',
      kind: 'model',
      decision: 'allowed',
      model: 'mock/scripted',
      status: 200,
      ms: 900,
      tokens_in: 1000,
      tokens_out: 21,
      background: false,
    }),
    platform(9, RECORDED_START_MS + 300, {
      subtype: 'network',
      kind: 'connect',
      decision: 'denied',
      host: 'inference-api.nousresearch.com',
      port: 443,
      reason: 'not on the allowlist',
      background: true,
    }),
    platform(10, RECORDED_START_MS + 5_730, {
      subtype: 'network',
      kind: 'connect',
      decision: 'denied',
      host: 'example.com',
      port: 443,
      reason: 'not on the allowlist',
      background: false,
    }),
    platform(
      11,
      RECORDED_START_MS + 5_800,
      collected({ files: 4, agent_files: 1, stderr_lines: 3 }),
    ),
  ]);
  const fixtureArtifact = await s.addArtifact(
    recorded,
    'invoices.csv',
    INVOICES_CSV,
    'fixture_unchanged',
  );
  const summaryArtifact = await s.addArtifact(recorded, 'summary.csv', SUMMARY_CSV, 'agent');
  const reportArtifact = await s.addArtifact(recorded, 'report.html', REPORT_HTML, 'agent');
  const bigArtifact = await s.addArtifact(recorded, 'dump.bin', null, 'agent');
  await s.end('dup_invoices/baseline/1', recorded, {
    status: 'executed',
    finalText: RECORDED_FINAL,
    tokens: tokens(3300, 63),
    costUsd: 0,
    durationMs: 6_100,
  });
  await s.score(
    'dup_invoices/baseline/1',
    recorded,
    RECORDED_FINAL,
    dupScores(
      {
        key: 'answer',
        type: 'json_match',
        primary: true,
        status: 'failed',
        score: 0.5,
        comment: '1 of 2 pairs found',
        expected: [
          ['INV-1042', 'INV-1107'],
          ['INV-0988', 'INV-1131'],
        ],
        observed: [['INV-1042', 'INV-1107']],
        evidence: {
          event_seqs: [7, 0],
          json_match: { unit: 'items', matched: 1, total: 2, mismatches: ['[1]'] },
        },
      },
      {
        status: 'passed',
        comment: 'verifier printed score 1',
        evidence: { artifact_ids: [summaryArtifact] },
      },
    ),
  );

  // dup_invoices/baseline/2: ungradable.
  const tableText = 'Net balances:\n\n| invoice | net |\n| --- | --- |\n| INV-1 | 10.00 |';
  const ungradable = await s.start('dup_invoices/baseline/2', 1, new Date(t0));
  await s.addEvents(ungradable, [
    hermes(1, t0 + 2_000, { type: 'result', exit_code: 0, text: tableText }),
  ]);
  await s.end('dup_invoices/baseline/2', ungradable, {
    status: 'executed',
    finalText: tableText,
    tokens: tokens(900, 40),
  });
  const missing = 'no fenced JSON block found in final response';
  const ungradableScores = dupScores(
    { key: 'answer', type: 'json_match', primary: true, status: 'ungradable', comment: missing },
    { status: 'ungradable', comment: missing },
  );
  await s.score('dup_invoices/baseline/2', ungradable, tableText, ungradableScores);
  // Re-scored once (generation 2: the trajectory key is now scored), then a
  // re-score whose job died (3).
  await s.rescore('dup_invoices/baseline/2', ungradable, {
    kind: 'published',
    finalText: tableText,
    list: ungradableScores.map((score) =>
      score.key === 'reads_fixture'
        ? {
            ...score,
            status: 'failed',
            comment: 'read_file was called 0 times; at least 1 expected',
          }
        : score,
    ),
  });
  await s.rescore('dup_invoices/baseline/2', ungradable, {
    kind: 'failed',
    error: RESCORE_FAILURE,
  });

  // dup_invoices/baseline/3: the primary scorer broke.
  const fenced = 'Done.\n```json\n{"duplicates": []}\n```';
  const broken = await s.start('dup_invoices/baseline/3', 1, new Date(t0));
  await s.end('dup_invoices/baseline/3', broken, {
    status: 'executed',
    finalText: fenced,
    tokens: tokens(800, 30),
  });
  await s.score(
    'dup_invoices/baseline/3',
    broken,
    fenced,
    dupScores(
      {
        key: 'answer',
        type: 'json_match',
        primary: true,
        status: 'error',
        comment: 'the scorer failed: boom',
        evidence: {
          error: {
            message: 'the scorer failed: boom',
            detail: 'at jsonMatch (json-match.ts:12:3)',
          },
        },
      },
      { status: 'passed', comment: 'verifier printed score 1' },
    ),
  );

  // dup_invoices/baseline/4: provider.
  const providerFailure = JSON.parse(RECORDED_PROVIDER_FAILURE) as {
    text: string;
    timestamp: number;
  };
  const provider = await s.start(
    'dup_invoices/baseline/4',
    1,
    new Date(providerFailure.timestamp - 22_000),
  );
  await s.addEvents(provider, [
    ...recordedEvents([RECORDED_PROVIDER_FAILURE]),
    platform(2, providerFailure.timestamp + 500, collected({ files: 1, stderr_lines: 57 })),
  ]);
  await s.end('dup_invoices/baseline/4', provider, {
    status: 'execution_error',
    category: 'provider',
    message: 'Provider said: Connection error.',
    exitCode: 1,
    durationMs: 22_000,
    finalText: providerFailure.text,
    stderrTail:
      'POST http://egress:8080/v1/chat/completions → 502\nhermes: provider error; exit 1\n',
  });

  // dup_invoices/baseline/5: timeout on both attempts.
  for (const number of [1, 2]) {
    const attempt = await s.start(
      'dup_invoices/baseline/5',
      number,
      new Date(t0 + number * 600_000),
    );
    await s.addEvents(attempt, [
      hermes(1, t0 + number * 600_000 + 4_000, {
        type: 'tool_use',
        name: 'terminal',
        tool_call_id: 'c1',
        input: { command: 'python3 reconcile.py' },
      }),
      // As execution/attempt/final-events.ts writes it.
      platform(2, t0 + number * 600_000 + 190_000, {
        subtype: 'killed',
        reason: 'deadline',
        signal: 'SIGTERM, then SIGKILL after 10 s',
        exit_code: 137,
        after_ms: 190_000,
      }),
    ]);
    await s.end('dup_invoices/baseline/5', attempt, {
      status: 'execution_error',
      category: 'timeout',
      exitCode: 137,
      durationMs: 190_000,
      stderrTail: 'worker: deadline reached; SIGTERM sent\nworker: SIGKILL after 10 s\n',
    });
    if (number === 1) await s.requeue('dup_invoices/baseline/5');
  }

  // dup_invoices/with-skill/1: passed.
  const passed = await s.start('dup_invoices/with-skill/1', 1, new Date(t0));
  await s.addEvents(passed, recordedEvents([RECORDED_RUN.at(-1)!]));
  await s.end('dup_invoices/with-skill/1', passed, {
    status: 'executed',
    finalText: fenced,
    tokens: tokens(1000, 50),
  });
  await s.score(
    'dup_invoices/with-skill/1',
    passed,
    fenced,
    dupScores(
      {
        key: 'answer',
        type: 'json_match',
        primary: true,
        status: 'passed',
        comment: 'answer matched the reference',
      },
      { status: 'passed', comment: 'verifier printed score 1' },
    ),
  );
  // A re-score waiting for a worker: the run stays scored with generation 1 shown.
  const pendingRescore = await s.rescore('dup_invoices/with-skill/1', passed, { kind: 'pending' });

  // dup_invoices/with-skill/2, /3, /4: setup, worker_lost, other.
  const setup = await s.start('dup_invoices/with-skill/2', 1, new Date(t0));
  await s.end('dup_invoices/with-skill/2', setup, {
    status: 'execution_error',
    category: 'setup',
    message: 'invoice-db failed to start',
    exitCode: 3,
    durationMs: 4_000,
    stderrTail: 'Error: INVOICE_DB_URL is not set\nhermes: exit 3\n',
  });
  const lost = await s.start('dup_invoices/with-skill/3', 1, new Date(t0));
  await s.addEvents(lost, [hermes(1, t0 + 3_000, { type: 'text', text: 'Reading the task.' })]);
  await s.loseWorker('dup_invoices/with-skill/3', lost, 2);
  const disk = await s.start('dup_invoices/with-skill/4', 1, new Date(t0));
  await s.end('dup_invoices/with-skill/4', disk, {
    status: 'execution_error',
    category: 'other',
    exitCode: 137,
    durationMs: 41_000,
    message: 'disk limit passed: workspace 2.0 GB, 1,318 files',
  });

  // dup_invoices/with-skill/5: running, a terminal call open.
  const now = Date.now();
  const running = await s.start('dup_invoices/with-skill/5', 1, new Date(now - 30_000));
  await s.addEvents(running, [
    hermes(1, now - 25_000, { type: 'text', text: 'Reading invoices.csv first.' }),
    hermes(2, now - 20_000, {
      type: 'tool_use',
      name: 'terminal',
      tool_call_id: 'c1',
      input: { command: 'head invoices.csv' },
    }),
  ]);

  // total_due/baseline/1: cancelled by the user.
  const cancelled = await s.start('total_due/baseline/1', 1, new Date(t0));
  await s.addEvents(cancelled, [
    hermes(1, t0 + 5_000, {
      type: 'tool_use',
      name: 'write_file',
      tool_call_id: 'w',
      input: { path: 'summary.csv' },
    }),
    hermes(2, t0 + 5_100, {
      type: 'tool_result',
      name: 'write_file',
      tool_call_id: 'w',
      output: 'wrote 60 bytes',
      duration_ms: 100,
    }),
    platform(3, t0 + 31_000, {
      subtype: 'cancelled',
      container_started: true,
      exit_code: 143,
      after_ms: 31_000,
    }),
  ]);
  const partialArtifact = await s.addArtifact(cancelled, 'summary.csv', SUMMARY_CSV, 'agent');
  await s.end('total_due/baseline/1', cancelled, { status: 'cancelled', durationMs: 31_000 });

  // total_due/baseline/2: timeout, then scored on the retry.
  const answer = 'Total:\n```json\n{"total_due": 1042}\n```';
  const firstTry = await s.start('total_due/baseline/2', 1, new Date(t0));
  await s.end('total_due/baseline/2', firstTry, {
    status: 'execution_error',
    category: 'timeout',
    durationMs: 190_000,
  });
  await s.requeue('total_due/baseline/2');
  const retry = await s.start('total_due/baseline/2', 2, new Date(t0 + 300_000));
  await s.end('total_due/baseline/2', retry, {
    status: 'executed',
    finalText: answer,
    tokens: tokens(2000, 100),
    costUsd: 0.0125,
    durationMs: 71_000,
  });
  await s.score('total_due/baseline/2', retry, answer, [
    {
      key: 'total',
      type: 'numeric_tolerance',
      primary: true,
      status: 'passed',
      comment: '|observed − expected| = 0.00000',
      expected: 1042,
      observed: 1042,
    },
    { key: 'method', type: 'llm_judge', status: 'error', ...PHASE3('llm_judge') },
  ]);

  // total_due/baseline/4: queued for a retry after a provider error.
  const pending = await s.start('total_due/baseline/4', 1, new Date(t0));
  await s.end('total_due/baseline/4', pending, {
    status: 'execution_error',
    category: 'provider',
    exitCode: 1,
  });
  await s.requeue('total_due/baseline/4');

  // total_due/with-skill/1: executed, waiting for its score.
  const unscored = 'Done.\n```json\n{"total_due": 1041.5}\n```';
  const executed = await s.start('total_due/with-skill/1', 1, new Date(t0));
  await s.end('total_due/with-skill/1', executed, {
    status: 'executed',
    finalText: unscored,
    tokens: tokens(1500, 80),
  });

  return {
    ...s,
    pendingRescore,
    artifactIds: {
      fixture: fixtureArtifact,
      summary: summaryArtifact,
      report: reportArtifact,
      big: bigArtifact,
      partial: partialArtifact,
    },
  };
}

export type AllStates = Awaited<ReturnType<typeof seedAllStates>>;
