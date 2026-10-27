/**
 * Experiment fixtures: the six experiments of the Experiment list artboard,
 * each defined by its run matrix (one status letter per task, configuration
 * and repetition). Every other experiment-domain fixture derives from these
 * matrices, so the list, Overview, Comparison, Runs tab and run inspector
 * always agree: `Skill vs no skill, invoices-v1` gives baseline 38 / 60 =
 * 0.633, with-skill 51 / 60 = 0.850, 8 improved, 0 regressed, 4 unchanged.
 *
 * Cell letters: P passed · F failed · U ungradable · X scorer error (all
 * scored, by the primary key) · E execution_error · R running · D executed ·
 * S scoring · Q queued · C cancelled.
 *
 * Scenarios handled here (see scenarios.ts): empty, first-launch,
 * paused-ceiling, paused-provider, no-worker, nothing-scored, single-rep,
 * verdict-updated, cancelled, multi-attempt, disk-limit, token-cap,
 * timeout-silent, provider-lapsed, plus the suite states (invalid-task,
 * newer-version); New experiment's options also read secret-not-set and
 * mcp-test-failed (with-mcp's unset INVOICE_DB_URL) and skills-on-demand.
 */
import {
  isMockModelRoute,
  type ExecutionErrorCategory,
  type ExperimentStatus,
  type NotComputableReason,
  type RunStatus,
  type ScoreStatus,
  type ScorerType,
} from '@hermes-evals/shared';
import type {
  ConfigAggregate,
  ConfigDifference,
  ConfigProgress,
  ExperimentConfigRef,
  ExperimentDetail,
  ExperimentFailureView,
  ExperimentListRow,
  PauseReason,
  FeedEntry,
  RunCounts,
  VerdictHistoryEntry,
  VerdictState,
  VerdictSummary,
  WorkerPresence,
} from '@/api/types/experiments';
import type {
  EstimateQuery,
  ExperimentEstimateView,
  NewExperimentDraft,
  NewExperimentOptions,
} from '@/api/types/experiments';
import type { TaskExperimentUsage } from '@/api/types/suites';
import type { ConfigurationUsage } from '@/api/types/configurations';
import {
  CONFIG_NAMES,
  CONFIG_VERSIONS,
  configDiffFixture,
  configVersionIn,
  type ConfigName,
  MODEL,
  PRICE_TABLE,
} from './configurations';
import { sampleConfigOptions } from './samples';
import { judgeFixture } from './setup';
import { gateOf, intervalOf, type TaskCounts, verdictOf } from './statistics';
import {
  addSeconds,
  at,
  currentSuiteId,
  designHash,
  LATE_FEES_INVALID_REASON,
  newerSuiteVersion,
  primaryKey,
  round,
  sha,
  SUITE_PATH,
  SUITE_V1_REF,
  suiteDetailFixture,
  type SuiteState,
  suiteStateFrom,
  TASK_KEYS,
  taskVerification,
  ulid,
} from './suites';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const EXPERIMENT_IDS = {
  skillMcp: 'exp_01JBFSKMCP',
  mcpVsBaseline: 'exp_01JBFMCPVB',
  mcpFirstTry: 'exp_01JBFMCPFT',
  mcpSmoke: 'exp_01JBCMCPSM',
  skillVsNoSkill: 'exp_01JBB7SVNS',
  quickCheck: 'exp_01JBB4QCHK',
} as const;

export type ExperimentKey = keyof typeof EXPERIMENT_IDS;

/** The run the inspector board shows: dup_invoices · baseline · rep 3 of Skill vs no skill. */
export const SAMPLE_RUN_ID = 'run_01JB7X4K2M';

/** The full commit, as the API sends it; the pages show its first 7 characters. */
export const HERMES = {
  package: 'hermes-agent',
  version: 'v0.22.4',
  revision: '4d04303a1b2c3d4e5f60718293a4b5c6d7e8f901',
};

// ---------------------------------------------------------------------------
// Cells and runs
// ---------------------------------------------------------------------------

export type CellCode = 'P' | 'F' | 'U' | 'X' | 'E' | 'R' | 'D' | 'S' | 'Q' | 'C';

export function runStatusOf(code: CellCode): RunStatus {
  switch (code) {
    case 'P':
    case 'F':
    case 'U':
    case 'X':
      return 'scored';
    case 'E':
      return 'execution_error';
    case 'R':
      return 'running';
    case 'D':
      return 'executed';
    case 'S':
      return 'scoring';
    case 'Q':
      return 'queued';
    case 'C':
      return 'cancelled';
  }
}

export function primaryStatusOf(code: CellCode): ScoreStatus | null {
  switch (code) {
    case 'P':
      return 'passed';
    case 'F':
      return 'failed';
    case 'U':
      return 'ungradable';
    case 'X':
      return 'error';
    default:
      return null;
  }
}

/** One run, derived from a matrix cell. */
export interface RunSeed {
  id: string;
  experimentId: string;
  taskKey: string;
  config: ConfigName;
  /** 0 for the baseline, 1… for candidates in experiment order. */
  configIndex: number;
  repetition: number;
  code: CellCode;
  status: RunStatus;
  primaryStatus: ScoreStatus | null;
  attempts: number;
  category: ExecutionErrorCategory | null;
  durationS: number | null;
  tokens: { input: number; output: number; total: number } | null;
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `${task}|${config}|${rep}`. */
export type RunKey = string;

export const runKey = (task: string, config: string, rep: number): RunKey =>
  `${task}|${config}|${rep}`;

interface RunOverride {
  id?: string;
  durationS?: number;
  tokens?: number;
  tokensIn?: number;
  finishedAt?: string;
  attempts?: number;
  category?: ExecutionErrorCategory;
}

/** Score status of a non-primary key, per run, when it differs from the default rule. */
type KeyOverride = Record<string, CellCode>;

export interface ExperimentSeed {
  key: ExperimentKey;
  id: string;
  name: string;
  description: string;
  status: ExperimentStatus;
  pauseReason: PauseReason | null;
  pausedAt: string | null;
  statusReason: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** When Cancel was pressed (the cancelled scenario); absent or null otherwise. */
  cancelledAt?: string | null;
  elapsedS: number;
  remainingEstimateS: number | null;
  lastEventAt: string | null;
  baseline: ConfigName;
  candidates: ConfigName[];
  repetitions: number;
  concurrency: number;
  spendCeilingUsd: number | null;
  timeBudgetOverrideS: number | null;
  /** Per configuration, per task: one letter per repetition. */
  matrix: Partial<Record<ConfigName, Record<string, string>>>;
  /** Minutes over which finished runs are spread (Runs tab "Finished" column). */
  spanMinutes: number;
  runOverrides: Record<RunKey, RunOverride>;
  keyOverrides: Record<RunKey, KeyOverride>;
  spentUsd: number;
  projectedTotalUsd: number | null;
  remainingCostUsd: number | null;
  history: Partial<Record<ConfigName, VerdictHistoryEntry[]>>;
  /** Aggregate values the brief states verbatim, which win over computed ones. */
  aggregateOverrides: Partial<
    Record<ConfigName, Partial<Pick<ConfigAggregate, 'meanScore' | 'costUsd'>>>
  >;
  /** Mean tokens and median duration the brief states, which the run numbers are tuned to. */
  runTargets: Partial<Record<ConfigName, { meanTokens: number; medianDurationS: number }>>;
  /** [finished time, task, config, repetition, duration s], newest first. */
  feed: [string, string, ConfigName, number, number][];
  failure: Omit<ExperimentFailureView, 'runId'> | null;
  worker: WorkerPresence;
  listCostUsd: number | null;
}

const BASE_DURATION: Record<ConfigName, number> = {
  baseline: 40,
  'with-skill': 52,
  'with-mcp': 50,
};

const BASE_TOKENS: Record<ConfigName, number> = {
  baseline: 12100,
  'with-skill': 17200,
  'with-mcp': 15800,
};

/** Price per token used for run cost estimates ($0.60 in / $2.40 out per 1M, at the usual mix). */
export const COST_PER_TOKEN = 0.00000083;

const FINISHED: CellCode[] = ['P', 'F', 'U', 'X', 'E', 'D', 'S'];

function configsOf(seed: ExperimentSeed): ConfigName[] {
  return [seed.baseline, ...seed.candidates];
}

function cellsOf(seed: ExperimentSeed, config: ConfigName, task: string): CellCode[] {
  const row = seed.matrix[config]?.[task] ?? '';
  return row.split('') as CellCode[];
}

/** Every run of an experiment, task-major (task, configuration, repetition). */
export function experimentRuns(seed: ExperimentSeed): RunSeed[] {
  const configs = configsOf(seed);
  const runs: RunSeed[] = [];
  const total = TASK_KEYS.length * configs.length * seed.repetitions;
  TASK_KEYS.forEach((task, ti) => {
    configs.forEach((config, ci) => {
      cellsOf(seed, config, task).forEach((code, i) => {
        const rep = i + 1;
        const key = runKey(task, config, rep);
        const o = seed.runOverrides[key] ?? {};
        const h = designHash(task + config + i);
        const executed = FINISHED.includes(code) || code === 'C';
        let durationS: number | null = null;
        let tokens: number | null = null;
        if (code === 'E') {
          durationS = 300;
          tokens = BASE_TOKENS[config] + (h % 5200) + 8000;
        } else if (executed && code !== 'C') {
          durationS =
            BASE_DURATION[config] + (h % 28) + (code === 'F' ? 8 : 0) + (code === 'U' ? 30 : 0);
          tokens = BASE_TOKENS[config] + (h % 5200) + (code === 'U' ? 6000 : 0);
        } else if (code === 'C') {
          durationS = 31;
          tokens = 8090;
        }
        if (o.durationS !== undefined) durationS = o.durationS;
        if (o.tokens !== undefined) tokens = o.tokens;
        const order = (ti * configs.length + ci) * seed.repetitions + i;
        const minutes = Math.floor((order * seed.spanMinutes) / total);
        const finishedAt = executed
          ? (o.finishedAt ?? addSeconds(seed.createdAt, minutes * 60 + (h % 60)))
          : null;
        const status = runStatusOf(code);
        runs.push({
          id: o.id ?? ulid('run', `${seed.id}:${key}`, 10),
          experimentId: seed.id,
          taskKey: task,
          config,
          configIndex: ci,
          repetition: rep,
          code,
          status,
          primaryStatus: primaryStatusOf(code),
          attempts: code === 'Q' ? 0 : (o.attempts ?? 1),
          category: code === 'E' ? (o.category ?? 'timeout') : null,
          durationS,
          tokens: null,
          costUsd: null,
          startedAt: finishedAt && durationS !== null ? addSeconds(finishedAt, -durationS) : null,
          finishedAt,
        });
        const run = runs[runs.length - 1];
        if (run && tokens !== null) {
          const input = o.tokensIn ?? Math.round(tokens * 0.857);
          run.tokens = { input, output: tokens - input, total: tokens };
          run.costUsd = round(tokens * COST_PER_TOKEN, 4);
        }
      });
    });
  });
  tuneRuns(seed, runs);
  return runs;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * Shifts generated tokens and durations so each configuration's mean tokens
 * and median duration equal the numbers the brief states. Runs with an
 * override (the inspector's sample run) and execution errors keep their values.
 */
function tuneRuns(seed: ExperimentSeed, runs: RunSeed[]): void {
  for (const [config, target] of Object.entries(seed.runTargets) as [
    ConfigName,
    { meanTokens: number; medianDurationS: number },
  ][]) {
    const mine = runs.filter((r) => r.config === config && r.tokens);
    const free = mine.filter(
      (r) => !seed.runOverrides[runKey(r.taskKey, r.config, r.repetition)] && r.code !== 'E',
    );
    if (!free.length) continue;
    // Mean tokens: spread the difference over the free runs, remainder on the first.
    const sum = mine.reduce((a, r) => a + (r.tokens?.total ?? 0), 0);
    const diff = target.meanTokens * mine.length - sum;
    const each = Math.trunc(diff / free.length);
    let rest = diff - each * free.length;
    for (const r of free) {
      const extra = each + (rest !== 0 ? Math.sign(rest) : 0);
      if (rest !== 0) rest -= Math.sign(rest);
      const total = (r.tokens?.total ?? 0) + extra;
      const input = Math.round(total * 0.857);
      r.tokens = { input, output: total - input, total };
      r.costUsd = round(total * COST_PER_TOKEN, 4);
    }
    // Median duration: shift the free runs until the median lands on the target.
    for (let pass = 0; pass < 4; pass++) {
      const m = median(mine.map((r) => r.durationS ?? 0));
      if (m === null || m === target.medianDurationS) break;
      const shift = Math.round(target.medianDurationS - m) || Math.sign(target.medianDurationS - m);
      for (const r of free) r.durationS = (r.durationS ?? 0) + shift;
    }
    for (const r of free) {
      if (r.finishedAt && r.durationS !== null)
        r.startedAt = addSeconds(r.finishedAt, -r.durationS);
    }
  }
}

// ---------------------------------------------------------------------------
// Key statuses (primary and secondary keys of each run)
// ---------------------------------------------------------------------------

export interface KeyResult {
  key: string;
  type: ScorerType;
  primary: boolean;
  status: ScoreStatus;
  score: number | null;
}

function statusOfCode(code: CellCode): ScoreStatus {
  return primaryStatusOf(code) ?? 'error';
}

/** Scores of every verification key of a scored run; empty for runs that are not scored. */
export function keyResults(seed: ExperimentSeed, run: RunSeed): KeyResult[] {
  if (run.status !== 'scored') return [];
  const overrides = seed.keyOverrides[runKey(run.taskKey, run.config, run.repetition)] ?? {};
  return taskVerification(run.taskKey).map((v) => {
    let code: CellCode = run.code;
    if (v.primary) code = run.code;
    else if (v.key === 'reads_fixture') code = run.config === 'with-skill' ? 'P' : 'F';
    else if (v.key === 'uses_db') code = run.config === 'with-mcp' ? 'P' : 'F';
    else if (v.type === 'llm_judge') code = run.code === 'F' ? 'F' : 'P';
    const forced = overrides[v.key];
    if (forced) code = forced;
    const status = statusOfCode(code);
    const judge = v.type === 'llm_judge';
    const judgePass = v.key === 'rationale' ? 0.75 : 0.8;
    const score =
      status === 'passed'
        ? judge
          ? judgePass
          : 1
        : status === 'failed'
          ? judge
            ? 0.4
            : 0
          : null;
    return { key: v.key, type: v.type, primary: v.primary ?? false, status, score };
  });
}

/** Status of the selected score key for a scored run: `primary`, `any_failed` or a key name. */
export function selectedKeyStatus(
  seed: ExperimentSeed,
  run: RunSeed,
  key: string,
): ScoreStatus | null {
  if (run.status !== 'scored') return null;
  const results = keyResults(seed, run);
  if (key === 'primary') return run.primaryStatus;
  if (key === 'any_failed') {
    if (results.some((r) => r.status === 'failed')) return 'failed';
    if (results.some((r) => r.status === 'error')) return 'error';
    if (results.some((r) => r.status === 'ungradable')) return 'ungradable';
    return 'passed';
  }
  return results.find((r) => r.key === key)?.status ?? null;
}

// ---------------------------------------------------------------------------
// The six experiments
// ---------------------------------------------------------------------------

/** Pass/fail strings of Skill vs no skill (Comparison artboard), baseline then with-skill. */
const SVN_MATRIX: Record<'baseline' | 'with-skill', Record<string, string>> = {
  baseline: {
    total_due: 'PPPPP',
    overdue_list: 'PFPFP',
    dup_invoices: 'FPFFF',
    vat_split: 'PPPFP',
    credit_notes: 'FUFPF',
    currency_mix: 'PPFPP',
    missing_po: 'PPPPP',
    late_fees: 'FFPFU',
    per_vendor: 'PPPPP',
    disputed: 'FFPEF',
    partial_pay: 'PPFPF',
    summary_file: 'PPPPP',
  },
  'with-skill': {
    total_due: 'PPPPP',
    overdue_list: 'PPPPP',
    dup_invoices: 'PPPFP',
    vat_split: 'PPPPP',
    credit_notes: 'PFPPF',
    currency_mix: 'PPPPP',
    missing_po: 'PPPPP',
    late_fees: 'PPFPF',
    per_vendor: 'PPPPP',
    disputed: 'FPFPF',
    partial_pay: 'PPPPF',
    summary_file: 'PPPPP',
  },
};

const SKILL_VS_NO_SKILL: ExperimentSeed = {
  key: 'skillVsNoSkill',
  id: EXPERIMENT_IDS.skillVsNoSkill,
  name: 'Skill vs no skill, invoices-v1',
  description:
    'Does the invoice-method skill improve reconciliation accuracy on invoices-v1? Everything else held constant.',
  status: 'completed',
  pauseReason: null,
  pausedAt: null,
  statusReason: null,
  createdAt: at(22, '10:14:16'),
  finishedAt: at(22, '10:51:20'),
  elapsedS: 37 * 60 + 4,
  remainingEstimateS: null,
  lastEventAt: at(22, '10:51:20'),
  baseline: 'baseline',
  candidates: ['with-skill'],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  matrix: SVN_MATRIX,
  spanMinutes: 36,
  runOverrides: {
    [runKey('dup_invoices', 'baseline', 3)]: {
      id: SAMPLE_RUN_ID,
      durationS: 52,
      tokens: 13300,
      tokensIn: 11400,
      finishedAt: at(22, '10:21:07'),
    },
    [runKey('disputed', 'baseline', 4)]: {
      attempts: 2,
      category: 'timeout',
      tokens: 25370,
      tokensIn: 21960,
      finishedAt: at(22, '10:51:20'),
    },
    [runKey('credit_notes', 'with-skill', 4)]: {
      durationS: 64,
      tokens: 20750,
      tokensIn: 18300,
    },
  },
  keyOverrides: {
    [runKey('credit_notes', 'with-skill', 4)]: { method: 'X' },
  },
  spentUsd: 1.69,
  projectedTotalUsd: null,
  remainingCostUsd: null,
  history: {},
  aggregateOverrides: {
    baseline: { meanScore: 0.671, costUsd: 0.71 },
    'with-skill': { meanScore: 0.874, costUsd: 0.98 },
  },
  runTargets: {
    baseline: { meanTokens: 14200, medianDurationS: 48 },
    'with-skill': { meanTokens: 19800, medianDurationS: 61 },
  },
  feed: [],
  failure: null,
  worker: { connected: true, lastHeartbeatAt: at(22, '10:51:25'), workerLostRuns: 0 },
  listCostUsd: 1.69,
};

/** MCP vs baseline at 15:23:42: 87 / 120 scored (OverviewRunning artboard). */
const MCP_VS_BASELINE: ExperimentSeed = {
  key: 'mcpVsBaseline',
  id: EXPERIMENT_IDS.mcpVsBaseline,
  name: 'MCP vs baseline, invoices-v1',
  description:
    'Does giving the agent the invoice-db MCP server improve accuracy on invoices-v1? Everything else held constant.',
  status: 'running',
  pauseReason: null,
  pausedAt: null,
  statusReason: null,
  createdAt: at(23, '14:52:30'),
  finishedAt: null,
  elapsedS: 31 * 60 + 12,
  remainingEstimateS: 600,
  lastEventAt: at(23, '15:23:42'),
  baseline: 'baseline',
  candidates: ['with-mcp'],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: 2,
  timeBudgetOverrideS: null,
  matrix: {
    baseline: {
      total_due: 'PPPPP',
      overdue_list: 'PFPFQ',
      dup_invoices: 'FPFFQ',
      vat_split: 'PPPPQ',
      credit_notes: 'FFPFQ',
      currency_mix: 'PPFPQ',
      missing_po: 'PPPPQ',
      late_fees: 'FFFRQ',
      per_vendor: 'PPPFQ',
      disputed: 'FFPFQ',
      partial_pay: 'PFPRQ',
      summary_file: 'PPPQQ',
    },
    'with-mcp': {
      total_due: 'PPPFQ',
      overdue_list: 'PPPPQ',
      dup_invoices: 'PPFPQ',
      vat_split: 'PPFPQ',
      credit_notes: 'FPFQQ',
      currency_mix: 'PPPER',
      missing_po: 'PFPPQ',
      late_fees: 'FPFQQ',
      per_vendor: 'PPFPQ',
      disputed: 'FFSQQ',
      partial_pay: 'PFPQQ',
      summary_file: 'PPFQQ',
    },
  },
  spanMinutes: 27,
  runOverrides: {},
  keyOverrides: {},
  spentUsd: 1.21,
  projectedTotalUsd: 1.66,
  remainingCostUsd: 0.45,
  history: {},
  aggregateOverrides: {},
  runTargets: {},
  feed: [
    [at(23, '15:23:41'), 'per_vendor', 'with-mcp', 4, 44],
    [at(23, '15:23:18'), 'late_fees', 'baseline', 3, 71],
    [at(23, '15:22:57'), 'partial_pay', 'with-mcp', 3, 52],
    [at(23, '15:22:30'), 'disputed', 'baseline', 4, 66],
    [at(23, '15:22:02'), 'currency_mix', 'with-mcp', 4, 300],
    [at(23, '15:21:40'), 'vat_split', 'baseline', 4, 39],
    [at(23, '15:21:12'), 'credit_notes', 'with-mcp', 3, 83],
    [at(23, '15:20:51'), 'missing_po', 'baseline', 4, 29],
    [at(23, '15:20:20'), 'overdue_list', 'with-mcp', 4, 47],
    [at(23, '15:19:58'), 'total_due', 'baseline', 5, 31],
  ],
  failure: null,
  worker: { connected: true, lastHeartbeatAt: at(23, '15:23:40'), workerLostRuns: 0 },
  listCostUsd: 1.21,
};

/** MCP smoke test: 3 repetitions, with-mcp inconclusive (Flow B). */
const MCP_SMOKE: ExperimentSeed = {
  key: 'mcpSmoke',
  id: EXPERIMENT_IDS.mcpSmoke,
  name: 'MCP smoke test, invoices-v1',
  description: 'A first, cheap look at whether the invoice-db MCP server helps on invoices-v1.',
  status: 'completed',
  pauseReason: null,
  pausedAt: null,
  statusReason: null,
  createdAt: at(22, '17:40:02'),
  finishedAt: at(22, '18:02:12'),
  elapsedS: 22 * 60 + 10,
  remainingEstimateS: null,
  lastEventAt: at(22, '18:02:12'),
  baseline: 'baseline',
  candidates: ['with-mcp'],
  repetitions: 3,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  matrix: {
    baseline: {
      total_due: 'PPP',
      overdue_list: 'PFF',
      dup_invoices: 'FPF',
      vat_split: 'PPP',
      credit_notes: 'FPF',
      currency_mix: 'PPP',
      missing_po: 'PPP',
      late_fees: 'FFF',
      per_vendor: 'PPP',
      disputed: 'FFF',
      partial_pay: 'PFP',
      summary_file: 'PPP',
    },
    'with-mcp': {
      total_due: 'PPP',
      overdue_list: 'FPF',
      dup_invoices: 'PPF',
      vat_split: 'PPP',
      credit_notes: 'FFF',
      currency_mix: 'PEP',
      missing_po: 'PPP',
      late_fees: 'PPP',
      per_vendor: 'PPP',
      disputed: 'FFF',
      partial_pay: 'PFP',
      summary_file: 'PPP',
    },
  },
  spanMinutes: 21,
  runOverrides: {},
  keyOverrides: {},
  spentUsd: 1.01,
  projectedTotalUsd: null,
  remainingCostUsd: null,
  history: {},
  aggregateOverrides: {},
  runTargets: {},
  feed: [],
  failure: null,
  worker: { connected: true, lastHeartbeatAt: at(22, '18:02:20'), workerLostRuns: 0 },
  listCostUsd: 1.01,
};

const ALL_QUEUED = (reps: number): Record<string, string> =>
  Object.fromEntries(TASK_KEYS.map((t) => [t, 'Q'.repeat(reps)]));

/** MCP vs baseline, first try: stopped after 14 failed attempts in a row (setup). */
const MCP_FIRST_TRY: ExperimentSeed = {
  key: 'mcpFirstTry',
  id: EXPERIMENT_IDS.mcpFirstTry,
  name: 'MCP vs baseline, first try',
  description: 'invoice-db against the baseline, before INVOICE_DB_URL was set on the worker.',
  status: 'failed',
  pauseReason: null,
  pausedAt: null,
  statusReason: 'invoice-db failed to start (setup) in 14 of 14 runs',
  createdAt: at(23, '14:31:05'),
  finishedAt: at(23, '14:33:41'),
  elapsedS: 156,
  remainingEstimateS: null,
  lastEventAt: at(23, '14:33:41'),
  baseline: 'baseline',
  candidates: ['with-mcp'],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  matrix: {
    baseline: ALL_QUEUED(5),
    'with-mcp': Object.fromEntries(TASK_KEYS.map((t, i) => [t, i < 2 ? 'EEQQQ' : 'EQQQQ'])),
  },
  spanMinutes: 2,
  runOverrides: Object.fromEntries(
    TASK_KEYS.flatMap((t, i) =>
      (i < 2 ? [1, 2] : [1]).map((rep) => [
        runKey(t, 'with-mcp', rep),
        { category: 'setup' as const, durationS: 2, tokens: 0, tokensIn: 0 },
      ]),
    ),
  ),
  keyOverrides: {},
  spentUsd: 0.02,
  projectedTotalUsd: null,
  remainingCostUsd: null,
  history: {},
  aggregateOverrides: {},
  runTargets: {},
  feed: [],
  failure: {
    at: at(23, '14:33:41'),
    threshold: 14,
    category: 'setup',
    message: 'invoice-db failed to start',
    stderrFirstLine: 'Error: INVOICE_DB_URL is not set',
    identicalIn: 14,
    fix: { label: 'check Secrets', to: '/resources/secrets' },
  },
  worker: { connected: true, lastHeartbeatAt: at(23, '14:33:45'), workerLostRuns: 0 },
  listCostUsd: 0.02,
};

/** Skill + MCP: two candidates, 40 / 180 scored. */
const SKILL_MCP: ExperimentSeed = {
  key: 'skillMcp',
  id: EXPERIMENT_IDS.skillMcp,
  name: 'Skill + MCP, invoices-v1',
  description: 'The skill and the MCP server, each against the baseline, in one experiment.',
  status: 'running',
  pauseReason: null,
  pausedAt: null,
  statusReason: null,
  createdAt: at(23, '15:20:04'),
  finishedAt: null,
  elapsedS: 15 * 60 + 2,
  remainingEstimateS: 52 * 60,
  lastEventAt: at(23, '15:35:06'),
  baseline: 'baseline',
  candidates: ['with-skill', 'with-mcp'],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  matrix: {
    baseline: {
      total_due: 'PPQQQ',
      overdue_list: 'PFQQQ',
      dup_invoices: 'FRQQQ',
      vat_split: 'PQQQQ',
      credit_notes: 'FQQQQ',
      currency_mix: 'PQQQQ',
      missing_po: 'PQQQQ',
      late_fees: 'FQQQQ',
      per_vendor: 'PQQQQ',
      disputed: 'FQQQQ',
      partial_pay: 'PQQQQ',
      summary_file: 'PQQQQ',
    },
    'with-skill': {
      total_due: 'PPQQQ',
      overdue_list: 'PRQQQ',
      dup_invoices: 'PQQQQ',
      vat_split: 'PQQQQ',
      credit_notes: 'FQQQQ',
      currency_mix: 'PQQQQ',
      missing_po: 'PQQQQ',
      late_fees: 'PQQQQ',
      per_vendor: 'PQQQQ',
      disputed: 'FQQQQ',
      partial_pay: 'PQQQQ',
      summary_file: 'PQQQQ',
    },
    'with-mcp': {
      total_due: 'PPQQQ',
      overdue_list: 'FRQQQ',
      dup_invoices: 'PQQQQ',
      vat_split: 'PQQQQ',
      credit_notes: 'FQQQQ',
      currency_mix: 'PQQQQ',
      missing_po: 'PQQQQ',
      late_fees: 'FQQQQ',
      per_vendor: 'PQQQQ',
      disputed: 'FQQQQ',
      partial_pay: 'PQQQQ',
      summary_file: 'PQQQQ',
    },
  },
  spanMinutes: 14,
  runOverrides: {},
  keyOverrides: {},
  spentUsd: 0.59,
  projectedTotalUsd: 2.56,
  remainingCostUsd: 1.97,
  history: {},
  aggregateOverrides: {},
  runTargets: {},
  feed: [
    [at(23, '15:35:06'), 'total_due', 'with-mcp', 2, 47],
    [at(23, '15:34:40'), 'total_due', 'with-skill', 2, 58],
    [at(23, '15:34:12'), 'overdue_list', 'baseline', 2, 51],
    [at(23, '15:33:50'), 'total_due', 'baseline', 2, 42],
    [at(23, '15:33:21'), 'summary_file', 'with-mcp', 1, 55],
    [at(23, '15:32:58'), 'summary_file', 'with-skill', 1, 63],
    [at(23, '15:32:30'), 'summary_file', 'baseline', 1, 46],
    [at(23, '15:32:02'), 'partial_pay', 'with-mcp', 1, 52],
    [at(23, '15:31:41'), 'partial_pay', 'with-skill', 1, 60],
    [at(23, '15:31:15'), 'partial_pay', 'baseline', 1, 49],
  ],
  failure: null,
  worker: { connected: true, lastHeartbeatAt: at(23, '15:35:04'), workerLostRuns: 0 },
  listCostUsd: 0.59,
};

/** Skill vs no skill, quick check: 1 repetition, paused by the user at 9 / 24. */
const QUICK_CHECK: ExperimentSeed = {
  key: 'quickCheck',
  id: EXPERIMENT_IDS.quickCheck,
  name: 'Skill vs no skill, quick check',
  description: 'One repetition to smoke-test with-skill before the full run.',
  status: 'paused',
  pauseReason: 'user',
  pausedAt: at(22, '10:06:31'),
  // As the API words a pause (experiments/views/failure.ts statusReason).
  statusReason: 'Paused by the user',
  createdAt: at(22, '09:58:10'),
  finishedAt: null,
  elapsedS: 8 * 60 + 21,
  remainingEstimateS: 15 * 60,
  lastEventAt: at(22, '10:06:31'),
  baseline: 'baseline',
  candidates: ['with-skill'],
  repetitions: 1,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  matrix: {
    baseline: {
      total_due: 'P',
      overdue_list: 'F',
      dup_invoices: 'F',
      vat_split: 'P',
      credit_notes: 'Q',
      currency_mix: 'Q',
      missing_po: 'Q',
      late_fees: 'Q',
      per_vendor: 'Q',
      disputed: 'Q',
      partial_pay: 'Q',
      summary_file: 'Q',
    },
    'with-skill': {
      total_due: 'P',
      overdue_list: 'P',
      dup_invoices: 'P',
      vat_split: 'P',
      credit_notes: 'F',
      currency_mix: 'Q',
      missing_po: 'Q',
      late_fees: 'Q',
      per_vendor: 'Q',
      disputed: 'Q',
      partial_pay: 'Q',
      summary_file: 'Q',
    },
  },
  spanMinutes: 8,
  runOverrides: {},
  keyOverrides: {},
  spentUsd: 0.12,
  projectedTotalUsd: 0.31,
  remainingCostUsd: 0.19,
  history: {},
  aggregateOverrides: {},
  runTargets: {},
  feed: [],
  failure: null,
  worker: { connected: true, lastHeartbeatAt: at(22, '10:06:35'), workerLostRuns: 0 },
  listCostUsd: 0.12,
};

/** The quick check after it finished (Comparison · repetitions = 1 frame). */
const QUICK_CHECK_DONE: Record<'baseline' | 'with-skill', Record<string, string>> = {
  baseline: {
    total_due: 'P',
    overdue_list: 'F',
    dup_invoices: 'F',
    vat_split: 'P',
    credit_notes: 'F',
    currency_mix: 'P',
    missing_po: 'P',
    late_fees: 'F',
    per_vendor: 'P',
    disputed: 'F',
    partial_pay: 'P',
    summary_file: 'P',
  },
  'with-skill': {
    total_due: 'P',
    overdue_list: 'P',
    dup_invoices: 'P',
    vat_split: 'P',
    credit_notes: 'F',
    currency_mix: 'P',
    missing_po: 'P',
    late_fees: 'F',
    per_vendor: 'P',
    disputed: 'F',
    partial_pay: 'P',
    summary_file: 'P',
  },
};

/** Newest first, as the Experiment list shows them. */
const BASE_SEEDS: ExperimentSeed[] = [
  SKILL_MCP,
  MCP_VS_BASELINE,
  MCP_FIRST_TRY,
  MCP_SMOKE,
  SKILL_VS_NO_SKILL,
  QUICK_CHECK,
];

// ---------------------------------------------------------------------------
// Scenario variants
// ---------------------------------------------------------------------------

function mapMatrix(
  seed: ExperimentSeed,
  fn: (code: CellCode, task: string, config: ConfigName, rep: number) => CellCode,
): ExperimentSeed['matrix'] {
  const out: ExperimentSeed['matrix'] = {};
  for (const config of configsOf(seed)) {
    const rows = seed.matrix[config] ?? {};
    out[config] = Object.fromEntries(
      Object.entries(rows).map(([task, cells]) => [
        task,
        (cells.split('') as CellCode[]).map((c, i) => fn(c, task, config, i + 1)).join(''),
      ]),
    );
  }
  return out;
}

function withMatrixCell(
  seed: ExperimentSeed,
  task: string,
  config: ConfigName,
  rep: number,
  code: CellCode,
): ExperimentSeed['matrix'] {
  return mapMatrix(seed, (c, t, cfg, r) => (t === task && cfg === config && r === rep ? code : c));
}

/** The experiment seeds as a scenario shows them. */
export function experimentSeeds(active: (name: string) => boolean): ExperimentSeed[] {
  if (active('empty') || active('first-launch')) return [];
  return BASE_SEEDS.map((seed) => {
    if (seed.key === 'mcpVsBaseline') return mcpVsBaselineVariant(seed, active);
    if (seed.key === 'skillVsNoSkill') return skillVsNoSkillVariant(seed, active);
    if (seed.key === 'mcpSmoke' && active('verdict-updated')) return smokeAfterRetry(seed);
    if (seed.key === 'mcpSmoke' && active('token-cap')) return smokeTokenCap(seed);
    if (seed.key === 'quickCheck' && active('single-rep')) {
      return {
        ...seed,
        status: 'completed',
        pauseReason: null,
        pausedAt: null,
        finishedAt: at(22, '10:21:40'),
        elapsedS: 23 * 60 + 30,
        remainingEstimateS: null,
        matrix: QUICK_CHECK_DONE,
        spentUsd: 0.31,
        projectedTotalUsd: null,
        remainingCostUsd: null,
        listCostUsd: 0.31,
      };
    }
    return seed;
  });
}

function mcpVsBaselineVariant(
  seed: ExperimentSeed,
  active: (name: string) => boolean,
): ExperimentSeed {
  if (active('paused-ceiling')) {
    return {
      ...seed,
      status: 'paused',
      pauseReason: 'spend_ceiling',
      pausedAt: at(23, '15:08:00'),
      statusReason: 'Paused at the $2.00 spend ceiling',
      lastEventAt: at(23, '15:08:00'),
      matrix: mapMatrix(seed, (c) => (c === 'R' || c === 'S' ? 'Q' : c)),
      spentUsd: 2,
      projectedTotalUsd: 2.45,
      remainingCostUsd: 0.45,
      listCostUsd: 2,
    };
  }
  if (active('paused-provider')) {
    return {
      ...seed,
      status: 'paused',
      pauseReason: 'provider_disconnected',
      pausedAt: at(23, '15:08:00'),
      // Both configurations run on Nous Portal.
      statusReason: 'Paused: Nous Portal is not connected',
      lastEventAt: at(23, '15:08:00'),
      matrix: mapMatrix(seed, (c) => (c === 'R' || c === 'S' || c === 'E' ? 'Q' : c)),
    };
  }
  if (active('no-worker')) {
    const lost = mapMatrix(seed, (c) => (c === 'R' || c === 'S' ? 'E' : c));
    const overrides: Record<RunKey, RunOverride> = {};
    for (const config of configsOf(seed)) {
      for (const [task, cells] of Object.entries(seed.matrix[config] ?? {})) {
        cells.split('').forEach((c, i) => {
          if (c === 'R' || c === 'S') {
            overrides[runKey(task, config, i + 1)] = {
              category: 'worker_lost',
              durationS: 120,
              finishedAt: at(23, '15:31:04'),
            };
          }
        });
      }
    }
    return {
      ...seed,
      matrix: lost,
      runOverrides: { ...seed.runOverrides, ...overrides },
      lastEventAt: at(23, '15:31:04'),
      worker: { connected: false, lastHeartbeatAt: at(23, '15:31:04'), workerLostRuns: 4 },
    };
  }
  if (active('nothing-scored')) {
    let running = 0;
    return {
      ...seed,
      elapsedS: 28,
      remainingEstimateS: 35 * 60,
      lastEventAt: at(23, '14:52:58'),
      matrix: mapMatrix(seed, (_c, _t, _cfg, rep) => {
        if (rep === 1 && running < 3) {
          running += 1;
          return 'R';
        }
        return 'Q';
      }),
      spentUsd: 0,
      projectedTotalUsd: 1.66,
      remainingCostUsd: 1.66,
      feed: [],
      listCostUsd: 0,
    };
  }
  if (active('cancelled')) {
    return {
      ...seed,
      status: 'completed',
      cancelledAt: at(23, '15:30:12'),
      finishedAt: at(23, '15:31:04'),
      elapsedS: 38 * 60 + 34,
      remainingEstimateS: null,
      lastEventAt: at(23, '15:31:04'),
      matrix: mapMatrix(seed, (c, task, config, rep) => {
        if (task === 'summary_file' && config === 'with-mcp' && rep === 5) return 'C';
        return c === 'Q' || c === 'R' ? 'C' : c === 'S' ? 'F' : c;
      }),
      runOverrides: {
        ...seed.runOverrides,
        [runKey('summary_file', 'with-mcp', 5)]: {
          durationS: 31,
          tokens: 8090,
          tokensIn: 7210,
          finishedAt: at(23, '15:31:04'),
        },
      },
    };
  }
  return seed;
}

function skillVsNoSkillVariant(
  seed: ExperimentSeed,
  active: (name: string) => boolean,
): ExperimentSeed {
  if (active('multi-attempt')) {
    return {
      ...seed,
      matrix: withMatrixCell(seed, 'disputed', 'baseline', 4, 'F'),
      runOverrides: {
        ...seed.runOverrides,
        [runKey('disputed', 'baseline', 4)]: {
          attempts: 2,
          durationS: 71,
          tokens: 17130,
          tokensIn: 15020,
          finishedAt: at(23, '14:21:16'),
        },
      },
      keyOverrides: {
        ...seed.keyOverrides,
        [runKey('disputed', 'baseline', 4)]: { rationale: 'P' },
      },
      history: {
        'with-skill': [
          verdictEntry(at(22, '10:51:20'), 'initial', null, 0.217, 0.117, 0.333, 'better'),
          verdictEntry(at(23, '14:21:16'), 'retry', '1 retry', 0.217, 0.117, 0.333, 'better'),
        ],
      },
    };
  }
  if (active('disk-limit')) {
    return {
      ...seed,
      matrix: withMatrixCell(seed, 'summary_file', 'with-skill', 2, 'E'),
      runOverrides: {
        ...seed.runOverrides,
        [runKey('summary_file', 'with-skill', 2)]: { category: 'other', durationS: 41 },
      },
    };
  }
  if (active('timeout-silent')) {
    return {
      ...seed,
      runOverrides: {
        ...seed.runOverrides,
        [runKey('disputed', 'baseline', 4)]: {
          attempts: 1,
          category: 'timeout',
          durationS: 310,
          tokens: 0,
          tokensIn: 0,
          finishedAt: at(22, '10:42:20'),
        },
      },
    };
  }
  if (active('provider-lapsed')) {
    return {
      ...seed,
      matrix: withMatrixCell(seed, 'late_fees', 'with-skill', 3, 'E'),
      runOverrides: {
        ...seed.runOverrides,
        [runKey('late_fees', 'with-skill', 3)]: {
          attempts: 2,
          category: 'provider',
          durationS: 22,
          tokens: 4210,
          tokensIn: 3900,
        },
      },
    };
  }
  return seed;
}

/**
 * A run the model gateway's token cap stopped (execution_error · limit). On
 * the smoke test, which has no brief-stated token means to keep.
 */
function smokeTokenCap(seed: ExperimentSeed): ExperimentSeed {
  return {
    ...seed,
    matrix: withMatrixCell(seed, 'vat_split', 'with-mcp', 3, 'E'),
    runOverrides: {
      ...seed.runOverrides,
      [runKey('vat_split', 'with-mcp', 3)]: {
        category: 'limit',
        durationS: 214,
        tokens: 2_000_418,
        tokensIn: 1_993_870,
      },
    },
  };
}

function smokeAfterRetry(seed: ExperimentSeed): ExperimentSeed {
  return {
    ...seed,
    matrix: withMatrixCell(seed, 'currency_mix', 'with-mcp', 2, 'P'),
    runOverrides: {
      ...seed.runOverrides,
      [runKey('currency_mix', 'with-mcp', 2)]: { attempts: 2, finishedAt: at(23, '14:20:05') },
    },
    history: {
      'with-mcp': [
        // The statistics module's figures for Flow B, then for the matrix after the retry
        // (apps/api compute.spec.ts checks both against the module).
        verdictEntry(at(22, '18:02:12'), 'initial', null, 0.056, -0.111, 0.25, 'inconclusive'),
        verdictEntry(at(23, '14:20:05'), 'retry', '1 retry', 0.083, -0.056, 0.278, 'inconclusive'),
      ],
    },
  };
}

function verdictEntry(
  when: string,
  cause: VerdictHistoryEntry['cause'],
  note: string | null,
  delta: number | null,
  lo: number | null,
  hi: number | null,
  verdict: VerdictState,
): VerdictHistoryEntry {
  return { at: when, cause, note, delta, lo, hi, verdict };
}

export function findSeed(
  active: (name: string) => boolean,
  id: string,
): ExperimentSeed | undefined {
  return experimentSeeds(active).find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export function emptyCounts(): RunCounts {
  return {
    queued: 0,
    running: 0,
    executed: 0,
    scoring: 0,
    scored: 0,
    execution_error: 0,
    cancelled: 0,
  };
}

export function countRuns(runs: RunSeed[]): RunCounts {
  const counts = emptyCounts();
  for (const r of runs) counts[r.status] += 1;
  return counts;
}

export function configRef(seed: ExperimentSeed, config: ConfigName): ExperimentConfigRef {
  const c = CONFIG_VERSIONS[config];
  return {
    configurationId: c.configurationId,
    versionId: c.versionId,
    name: c.name,
    version: c.version,
    role: config === seed.baseline ? 'baseline' : 'candidate',
    model: c.model,
    provider: c.provider,
  };
}

/** Runs that count toward a pass rate: scored, plus execution errors as not passed. */
export function counted(runs: RunSeed[]): RunSeed[] {
  return runs.filter((r) => r.status === 'scored' || r.status === 'execution_error');
}

export function passRate(runs: RunSeed[]): {
  passed: number;
  counted: number;
  rate: number | null;
} {
  const c = counted(runs);
  const passed = c.filter((r) => r.primaryStatus === 'passed').length;
  return { passed, counted: c.length, rate: c.length ? round(passed / c.length, 3) : null };
}

/** Per-task pass rates and changes of one candidate against the baseline. */
export function taskChanges(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
): { improved: number; regressed: number; unchanged: number; delta: number | null } {
  const out = { improved: 0, regressed: 0, unchanged: 0, delta: null as number | null };
  const deltas: number[] = [];
  for (const task of TASK_KEYS) {
    const b = passRate(runs.filter((r) => r.taskKey === task && r.config === seed.baseline));
    const c = passRate(runs.filter((r) => r.taskKey === task && r.config === candidate));
    if (b.rate === null || c.rate === null) continue;
    const d = round(c.rate - b.rate, 2);
    deltas.push(c.passed / c.counted - b.passed / b.counted);
    if (d > 0) out.improved += 1;
    else if (d < 0) out.regressed += 1;
    else out.unchanged += 1;
  }
  out.delta = deltas.length ? round(deltas.reduce((a, d) => a + d, 0) / deltas.length, 3) : null;
  return out;
}

function inFlight(counts: RunCounts): number {
  return counts.queued + counts.running + counts.executed + counts.scoring;
}

/** Each task's primary-key difference (unrounded, task order) and counted runs, for statistics.ts. */
function primaryFigures(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
): { deltas: (number | null)[]; counts: TaskCounts[] } {
  const deltas: (number | null)[] = [];
  const counts: TaskCounts[] = [];
  for (const taskKey of TASK_KEYS) {
    const side = (config: ConfigName) =>
      passRate(runs.filter((r) => r.taskKey === taskKey && r.config === config));
    const b = side(seed.baseline);
    const c = side(candidate);
    deltas.push(b.counted && c.counted ? c.passed / c.counted - b.passed / b.counted : null);
    counts.push({ taskKey, baseline: b.counted, candidate: c.counted });
  }
  return { deltas, counts };
}

/**
 * A candidate's VerdictCard, as the API's experiment views give it
 * (views/verdicts.ts): once completed, the statistics module's verdict on
 * the primary key; while running, paused or failed, the figures so far as
 * `provisional`. One repetition, fewer than 3 tasks or nothing counted is
 * not computable at once; too few runs so far is provisional, and not
 * computable once completed.
 */
function verdictFor(seed: ExperimentSeed, runs: RunSeed[], candidate: ConfigName): VerdictSummary {
  const base = passRate(runs.filter((r) => r.config === seed.baseline));
  const cand = passRate(runs.filter((r) => r.config === candidate));
  const changes = taskChanges(seed, runs, candidate);
  const { deltas, counts } = primaryFigures(seed, runs, candidate);
  const gate = gateOf(seed.repetitions, counts);
  const interval = gate === null ? intervalOf(seed.id, deltas) : null;
  const final = seed.status === 'completed';
  let verdict: VerdictState;
  if (interval) verdict = verdictOf(interval.lo, interval.hi, !final);
  else verdict = final || gate !== 'not_enough_runs' ? 'not_computable' : 'provisional';
  const reason: NotComputableReason | null = verdict === 'not_computable' ? gate : null;
  const delta = gate === 'single_repetition' ? null : changes.delta;
  const lo = interval?.lo ?? null;
  const hi = interval?.hi ?? null;
  // A completed experiment has the entry reconcile appended when it completed.
  const history =
    seed.history[candidate] ??
    (final && seed.finishedAt
      ? [verdictEntry(seed.finishedAt, 'initial', null, delta, lo, hi, verdict)]
      : []);
  return {
    baseline: configRef(seed, seed.baseline),
    candidate: configRef(seed, candidate),
    verdict,
    scoreKey: 'primary',
    delta,
    lo,
    hi,
    passRates: { baseline: base.rate, candidate: cand.rate },
    passCounts: {
      baseline: { passed: base.passed, counted: base.counted },
      candidate: { passed: cand.passed, counted: cand.counted },
    },
    taskCounts: {
      improved: changes.improved,
      regressed: changes.regressed,
      unchanged: changes.unchanged,
    },
    method: { name: 'paired_bootstrap', resamples: 10000, confidence: 0.95 },
    reason,
    history,
  };
}

/** Aggregates per configuration (Overview complete, Comparison secondary metrics). */
export function aggregatesFor(seed: ExperimentSeed, runs: RunSeed[]): ConfigAggregate[] {
  return configsOf(seed).map((config) => {
    const mine = runs.filter((r) => r.config === config);
    const rate = passRate(mine);
    const scored = mine.filter((r) => r.status === 'scored');
    const ran = mine.filter((r) => r.durationS !== null && r.status !== 'cancelled');
    const withTokens = ran.filter((r) => r.tokens);
    const meanScore = rate.counted
      ? round(
          (rate.passed + 0.1 * scored.filter((r) => r.primaryStatus === 'failed').length) /
            rate.counted,
          3,
        )
      : null;
    const errors = mine.filter((r) => r.status === 'execution_error');
    const o = seed.aggregateOverrides[config] ?? {};
    return {
      configuration: configRef(seed, config),
      runs: mine.length,
      passRate: rate.rate,
      meanScore: o.meanScore ?? meanScore,
      medianDurationS: median(ran.map((r) => r.durationS ?? 0)),
      meanTokens: withTokens.length
        ? Math.round(withTokens.reduce((a, r) => a + (r.tokens?.total ?? 0), 0) / withTokens.length)
        : null,
      costUsd:
        o.costUsd ??
        round(
          ran.reduce((a, r) => a + (r.costUsd ?? 0), 0),
          2,
        ),
      executionErrors: errors.length,
      executionErrorCategories: [
        ...new Set(errors.map((r) => r.category).filter((c) => c !== null)),
      ],
      ungradable: scored.filter((r) => r.primaryStatus === 'ungradable').length,
    };
  });
}

function differencesFor(seed: ExperimentSeed): ConfigDifference[] {
  const base = CONFIG_VERSIONS[seed.baseline];
  return seed.candidates.flatMap((name) => {
    const cand = CONFIG_VERSIONS[name];
    const diff = configDiffFixture([base, cand]);
    return diff.rows
      .filter((r) => r.differs)
      .map((r) => ({
        field: r.field,
        candidate: cand.name,
        baselineValue: r.values[0] ?? '—',
        candidateValue: r.values[1] ?? '—',
        hash:
          r.field === 'skills'
            ? (cand.skills[0]?.contentHash ?? null)
            : r.field === 'mcp_servers'
              ? sha(`${cand.mcpServers[0]?.versionId ?? ''}:definition`)
              : null,
      }));
  });
}

function feedFor(seed: ExperimentSeed, runs: RunSeed[]): FeedEntry[] {
  return seed.feed.flatMap(([finishedAt, task, config, rep, durationS]) => {
    const run = runs.find((r) => r.taskKey === task && r.config === config && r.repetition === rep);
    if (!run || (run.status !== 'scored' && run.status !== 'execution_error')) return [];
    return [
      {
        runId: run.id,
        finishedAt,
        taskKey: task,
        configuration: config,
        repetition: rep,
        result:
          run.status === 'execution_error' ? 'execution_error' : (run.primaryStatus ?? 'error'),
        durationS,
      },
    ];
  });
}

/** Runs with the feed's finish times and durations applied. */
export function runsOf(seed: ExperimentSeed): RunSeed[] {
  const runs = experimentRuns(seed);
  for (const [finishedAt, task, config, rep, durationS] of seed.feed) {
    const run = runs.find((r) => r.taskKey === task && r.config === config && r.repetition === rep);
    if (run && run.status !== 'queued' && run.status !== 'running') {
      run.finishedAt = finishedAt;
      run.durationS = durationS;
      run.startedAt = addSeconds(finishedAt, -durationS);
    }
  }
  return runs;
}

export function experimentDetailFixture(
  seed: ExperimentSeed,
  suiteState: SuiteState,
): ExperimentDetail {
  const runs = runsOf(seed);
  const counts = countRuns(runs);
  const newer = newerSuiteVersion(suiteState);
  const perConfiguration: ConfigProgress[] = configsOf(seed).map((config) => {
    const mine = runs.filter((r) => r.config === config);
    const scored = mine.filter((r) => r.status === 'scored');
    const passed = scored.filter((r) => r.primaryStatus === 'passed').length;
    return {
      configuration: configRef(seed, config),
      total: mine.length,
      counts: countRuns(mine),
      passed,
      provisionalPassRate: scored.length ? round(passed / scored.length, 3) : null,
    };
  });
  const failureRun = runs.find((r) => r.status === 'execution_error');
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    status: seed.status,
    pauseReason: seed.pauseReason,
    pausedAt: seed.pausedAt,
    createdAt: seed.createdAt,
    finishedAt: seed.finishedAt,
    cancelledAt: seed.cancelledAt ?? null,
    elapsedS: seed.elapsedS,
    remainingEstimateS: seed.remainingEstimateS,
    lastEventAt: seed.lastEventAt,
    suite: {
      ...SUITE_V1_REF,
      path: SUITE_PATH,
      taskCount: TASK_KEYS.length,
      tasks: TASK_KEYS.map((key) => ({ key, version: 1 })),
      newerVersion: newer
        ? {
            suiteId: newer.suiteId,
            versionNumber: newer.versionNumber,
            changedTasks: newer.changedTasks,
            removedTasks: [],
            invalidTasks: newer.invalidTasks,
          }
        : null,
    },
    baseline: configRef(seed, seed.baseline),
    candidates: seed.candidates.map((c) => configRef(seed, c)),
    differences: differencesFor(seed),
    hermes: HERMES,
    scoreKey: 'primary',
    repetitions: seed.repetitions,
    concurrency: seed.concurrency,
    timeBudgetOverrideS: seed.timeBudgetOverrideS,
    totalRuns: runs.length,
    counts,
    spend: {
      spentUsd: seed.spentUsd,
      ceilingUsd: seed.spendCeilingUsd,
      projectedTotalUsd: seed.projectedTotalUsd,
      remainingEstimateUsd: seed.remainingCostUsd,
      unpricedAttempts: 0,
    },
    perConfiguration,
    feed: feedFor(seed, runs),
    verdicts: seed.candidates.map((c) => verdictFor(seed, runs, c)),
    aggregates: aggregatesFor(seed, runs),
    failure: seed.failure ? { ...seed.failure, runId: failureRun?.id ?? '' } : null,
    worker: seed.worker,
  };
}

export function experimentListRowFixture(seed: ExperimentSeed): ExperimentListRow {
  const runs = runsOf(seed);
  const counts = countRuns(runs);
  const live = seed.status === 'running' || seed.status === 'paused';
  const doneRuns = live ? counts.scored : runs.length - inFlight(counts);
  const verdicts =
    seed.status === 'completed'
      ? seed.candidates.map((c) => {
          const v = verdictFor(seed, runs, c);
          return {
            candidate: c,
            candidateVersionId: CONFIG_VERSIONS[c].versionId,
            verdict: v.verdict,
            delta: v.delta,
            lo: v.lo,
            hi: v.hi,
            reason: v.reason,
          };
        })
      : [];
  return {
    id: seed.id,
    name: seed.name,
    status: seed.status,
    pauseReason: seed.pauseReason,
    statusReason: seed.statusReason,
    suite: SUITE_V1_REF,
    baseline: configRef(seed, seed.baseline),
    candidates: seed.candidates.map((c) => configRef(seed, c)),
    repetitions: seed.repetitions,
    totalRuns: runs.length,
    doneRuns,
    counts,
    verdicts,
    createdAt: seed.createdAt,
    costUsd: seed.listCostUsd,
  };
}

// ---------------------------------------------------------------------------
// Usage of configurations, tasks and suite versions (for other domains)
// ---------------------------------------------------------------------------

/** Experiments that used a configuration, with its results in each. */
export function configurationUsageFixture(
  active: (name: string) => boolean,
  configurationId: string,
): ConfigurationUsage[] {
  return experimentSeeds(active).flatMap((seed) => {
    const config = configsOf(seed).find(
      (c) => CONFIG_VERSIONS[c].configurationId === configurationId,
    );
    if (!config) return [];
    const runs = runsOf(seed);
    const mine = runs.filter((r) => r.config === config);
    const scored = mine.filter((r) => r.status === 'scored');
    const live = seed.status === 'running' || seed.status === 'paused';
    const rate = live
      ? scored.length
        ? round(scored.filter((r) => r.primaryStatus === 'passed').length / scored.length, 3)
        : null
      : passRate(mine).rate;
    const isBaseline = config === seed.baseline;
    const summary = isBaseline ? null : verdictFor(seed, runs, config);
    return [
      {
        experimentId: seed.id,
        experimentName: seed.name,
        role: isBaseline ? 'baseline' : 'candidate',
        status: seed.status,
        version: 1,
        repetitions: seed.repetitions,
        passRate: rate,
        scored: scored.length,
        total: mine.length,
        verdict: summary?.verdict ?? null,
        verdictReason: summary?.reason ?? null,
        baselinePassRate: isBaseline
          ? null
          : passRate(runs.filter((r) => r.config === seed.baseline)).rate,
        taskCount: new Set(runs.map((r) => r.taskKey)).size,
        delta: summary?.delta ?? null,
      },
    ];
  });
}

/** Experiments that included a task, with its pass rate per configuration. */
export function taskUsageFixture(
  active: (name: string) => boolean,
  taskKey: string,
): TaskExperimentUsage[] {
  return experimentSeeds(active)
    .filter((seed) => seed.status !== 'failed')
    .map((seed) => {
      const runs = runsOf(seed).filter((r) => r.taskKey === taskKey);
      return {
        experimentId: seed.id,
        experimentName: seed.name,
        status: seed.status,
        // Every fixture experiment ran the suite's v1, where each task is at v1.
        taskVersion: 1,
        suiteVersion: SUITE_V1_REF.versionNumber,
        rows: configsOf(seed).map((config) => {
          const mine = runs.filter((r) => r.config === config);
          const rate = passRate(mine);
          return {
            configuration: config,
            role: config === seed.baseline ? ('baseline' as const) : ('candidate' as const),
            passRate: rate.rate === null ? null : round(rate.rate, 2),
            scored: rate.counted,
            total: mine.length,
          };
        }),
      };
    });
}

/** Experiments that ran on a suite version. Every fixture experiment ran on v1. */
export function experimentsOnSuiteFixture(
  active: (name: string) => boolean,
  suiteId: string,
): { id: string; name: string }[] {
  if (suiteId !== SUITE_V1_REF.suiteId) return [];
  return experimentSeeds(active).map((s) => ({ id: s.id, name: s.name }));
}

export { MODEL, primaryKey };

// ---------------------------------------------------------------------------
// New experiment: options, estimate and duplicate
// ---------------------------------------------------------------------------

const PER_RUN: Record<ConfigName, { seconds: number; costUsd: number; tokens: number }> = {
  baseline: { seconds: 48, costUsd: 0.01183, tokens: 14200 },
  'with-skill': { seconds: 61, costUsd: 0.01633, tokens: 19800 },
  'with-mcp': { seconds: 58, costUsd: 0.016, tokens: 18400 },
};

/** Without past runs on a suite the estimate assumes budget ÷ 4 and 15,000 tokens. */
const BUDGET_ESTIMATE = { seconds: 75, costUsd: 0.0126, tokens: 15000 };

export function newExperimentOptionsFixture(
  active: (name: string) => boolean,
): NewExperimentOptions {
  const state = suiteStateFrom(active);
  // samples-seeded: a fresh clone, where only the seeded sample configurations exist.
  const seeded = active('samples-seeded');
  const noConfigs = active('empty') || active('first-launch') || seeded;
  const noHistory = active('no-history');
  const configs = noConfigs ? [] : CONFIG_NAMES;
  // openrouter-in-use: every configuration runs on OpenRouter, which has no key (the
  // NewExperimentStates "OpenRouter key missing" frame: tagged rows and the .env blocker).
  const onOpenRouter = active('openrouter-in-use');
  // secret-not-set and mcp-test-failed: INVOICE_DB_URL is missing from the worker, so a
  // configuration with invoice-db names it and cannot launch (Phase 6 S7).
  const invoiceDbUrlMissing = active('secret-not-set') || active('mcp-test-failed');
  const suites = active('empty') ? [] : [suiteDetailFixture(state, currentSuiteId(state))];
  return {
    suites: suites.flatMap((s) =>
      s
        ? [
            {
              suiteId: s.suiteId,
              name: s.name,
              versionNumber: s.versionNumber,
              versionLabel: s.versionLabel,
              contentHash: s.contentHash,
              path: s.path,
              selfCheckAt: s.lastLoad.at,
              taskCount: s.taskCount,
              validCount: s.validCount,
              budgetS: 300,
              tasks: s.tasks.map((t) => ({
                key: t.key,
                version: t.version,
                summary: t.summary,
                verificationCount: t.verificationTypes.length,
                valid: t.valid,
                invalidReason: t.valid ? null : LATE_FEES_INVALID_REASON,
                hasLlmJudge: t.verificationTypes.includes('llm_judge'),
              })),
            },
          ]
        : [],
    ),
    configurations: [
      ...configs.map((name) => {
        const c = configVersionIn(active, name);
        const per = noHistory ? BUDGET_ESTIMATE : PER_RUN[name];
        const estimate = {
          seconds: per.seconds,
          costUsd: per.costUsd,
          tokens: per.tokens,
          basis: noHistory ? ('budget' as const) : ('history' as const),
          pastRuns: noHistory ? 0 : 192,
        };
        return {
          configurationId: c.configurationId,
          versionId: c.versionId,
          name: c.name,
          version: c.version,
          configHash: c.configHash,
          model: c.model,
          provider: onOpenRouter ? ('openrouter' as const) : c.provider,
          mockModel: !onOpenRouter && isMockModelRoute(c),
          memoryEnabled: c.memoryEnabled,
          skills: c.skills.map((s) => `${s.name}@${s.version}`),
          skillLoading: c.skillLoading,
          mcpServers: c.mcpServers.map((m) => `${m.name} (${m.transport})`),
          missingSecrets:
            invoiceDbUrlMissing && c.mcpServers.some((m) => m.name === 'invoice-db')
              ? [{ server: 'invoice-db', name: 'INVOICE_DB_URL', transport: 'stdio' as const }]
              : [],
          estimates: Object.fromEntries(suites.flatMap((s) => (s ? [[s.suiteId, estimate]] : []))),
        };
      }),
      ...(seeded ? sampleConfigOptions(suites.flatMap((s) => (s ? [s.suiteId] : []))) : []),
    ],
    defaults: { repetitions: 5, concurrency: 3 },
    maxConcurrency: 4,
    workerCount: 1,
    priceTable: PRICE_TABLE,
    // Nous with JUDGE_MODEL set, as the run fixtures assume; the mock under judge-mock and
    // samples-seeded (./setup.ts, which System reads too).
    judge: judgeFixture(active),
  };
}

/** GET /experiments/estimate: runs, waves, duration and cost per configuration. */
export function estimateFixture(
  options: NewExperimentOptions,
  query: EstimateQuery,
): ExperimentEstimateView {
  const chosen = options.configurations.filter((c) => query.versionIds.includes(c.versionId));
  const estimates = chosen.map((c) => ({ c, e: c.estimates[query.suiteId] }));
  const runs = query.taskCount * chosen.length * query.repetitions;
  const concurrency = Math.max(1, query.concurrency);
  const waves = Math.ceil(runs / concurrency);
  // Without history a run is assumed to take a quarter of its budget (plan 7.2), and the
  // form's per-run budget replaces each configuration's own, as the API's estimate does.
  const secondsOf = (e: (typeof estimates)[number]['e']): number =>
    e?.basis === 'budget' && query.budgetS ? query.budgetS / 4 : (e?.seconds ?? 75);
  const perRunSeconds = estimates.length
    ? estimates.reduce((a, x) => a + secondsOf(x.e), 0) / estimates.length
    : 0;
  const perConfiguration = estimates.map(({ c, e }) => ({
    versionId: c.versionId,
    name: c.name,
    runs: query.taskCount * query.repetitions,
    costUsd:
      e?.costUsd === null || e?.costUsd === undefined
        ? null
        : round(query.taskCount * query.repetitions * e.costUsd, 2),
  }));
  const unknown = perConfiguration.some((p) => p.costUsd === null);
  return {
    runs,
    waves,
    perRunSeconds: Math.round(perRunSeconds),
    durationS: Math.round(waves * perRunSeconds),
    costUsd: unknown
      ? null
      : round(
          perConfiguration.reduce((a, p) => a + (p.costUsd ?? 0), 0),
          2,
        ),
    perConfiguration,
    basis: estimates.every((x) => x.e?.basis === 'history') ? 'history' : 'budget',
    pastRuns:
      estimates.reduce((a, x) => a + (x.e?.pastRuns ?? 0), 0) / Math.max(1, estimates.length),
  };
}

/** Duplicate: the form prefilled on the suite's current version, listing what moved on. */
export function duplicateDraftFixture(
  active: (name: string) => boolean,
  seed: ExperimentSeed,
): NewExperimentDraft {
  const state = suiteStateFrom(active);
  const current = suiteDetailFixture(state, currentSuiteId(state));
  const invalid = current?.tasks.filter((t) => !t.valid).map((t) => t.key) ?? [];
  const changed = current?.tasks.filter((t) => t.version > 1).map((t) => t.key) ?? [];
  return {
    sourceExperimentId: seed.id,
    values: {
      name: seed.name,
      description: seed.description,
      suiteId: current?.suiteId ?? SUITE_V1_REF.suiteId,
      taskKeys: TASK_KEYS.filter((k) => !invalid.includes(k)),
      baselineVersionId: CONFIG_VERSIONS[seed.baseline].versionId,
      candidateVersionIds: seed.candidates.map((c) => CONFIG_VERSIONS[c].versionId),
      repetitions: seed.repetitions,
      concurrency: seed.concurrency,
      spendCeilingUsd: seed.spendCeilingUsd,
      timeBudgetOverrideS: seed.timeBudgetOverrideS,
    },
    changes: {
      suiteVersionFrom: 1,
      suiteVersionTo: current?.versionNumber ?? 1,
      changedTasks: changed.filter((k) => !invalid.includes(k)),
      removedTasks: [],
      invalidTasks: invalid.map((key) => ({ key, reason: LATE_FEES_INVALID_REASON })),
    },
  };
}
