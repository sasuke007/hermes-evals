/**
 * The comparison statistics the fixtures show, as the API's statistics
 * module computes them (apps/api/src/statistics: a paired bootstrap over
 * tasks, 10,000 resamples, seeded from the experiment id). The fixtures have
 * no bootstrap of their own: they compute each task's difference from their
 * run matrices, and look the 95% interval up here by the experiment id and
 * those differences, so a page in fixtures mode shows the figures the API
 * would (Phase 4 question 4). The gate, the verdict rule and the sentences
 * are the module's too (compute.ts).
 *
 * INTERVALS is generated from the module, not designed:
 * apps/api/src/statistics/compute.spec.ts recomputes every interval the
 * fixtures show, in every scenario and under every key, and fails on one
 * that differs or is missing, naming the entry to add.
 */
import type { ExperimentStatus, NotComputableReason, VerdictState } from '@hermes-evals/shared';
import { plural } from '@/lib/format';

/** A verdict needs this many counted runs of every task under each configuration. */
export const MIN_RUNS_PER_TASK = 2;
/** A verdict needs this many selected tasks: the bootstrap resamples tasks. */
export const MIN_TASKS = 3;

/** Running, paused or failed: a verdict is provisional (Retry failed runs can resume a failed one). */
export const isProvisional = (status: ExperimentStatus): boolean =>
  status === 'running' || status === 'paused' || status === 'failed';

/** How INTERVALS names one interval: the experiment and each task's difference, in task order. */
export function intervalKey(experimentId: string, deltas: readonly number[]): string {
  return `${experimentId}|${deltas.map((d) => d.toFixed(4)).join(',')}`;
}

/**
 * The module's 95% interval for these per-task differences, its bounds
 * rounded to three decimals as the API answers them. Keyed by intervalKey.
 */
const INTERVALS: Readonly<Record<string, readonly [number, number]>> = {
  // default · mcpVsBaseline · with-mcp · primary
  'exp_01JBFMCPVB|-0.2500,0.5000,0.5000,-0.2500,0.0833,0.0000,-0.2500,0.3333,0.0000,-0.2500,0.0000,-0.3333':
    [-0.146, 0.174],
  // default · mcpVsBaseline · with-mcp · primary, without broken runs
  'exp_01JBFMCPVB|-0.2500,0.5000,0.5000,-0.2500,0.0833,0.2500,-0.2500,0.3333,0.0000,-0.2500,0.0000,-0.3333':
    [-0.132, 0.194],
  // default · mcpVsBaseline · with-mcp · any_failed
  'exp_01JBFMCPVB|-0.2500,0.5000,0.0000,-0.2500,0.0833,0.0000,-0.2500,0.3333,0.7500,-0.2500,0.0000,-0.3333':
    [-0.146, 0.222],
  // default · mcpVsBaseline · with-mcp · any_failed, without broken runs
  'exp_01JBFMCPVB|-0.2500,0.5000,0.0000,-0.2500,0.0833,0.2500,-0.2500,0.3333,0.7500,-0.2500,0.0000,-0.3333':
    [-0.132, 0.243],
  // default · mcpSmoke · with-mcp · primary
  'exp_01JBCMCPSM|0.0000,0.0000,0.3333,0.0000,-0.3333,-0.3333,0.0000,1.0000,0.0000,0.0000,0.0000,0.0000':
    [-0.111, 0.25],
  // default · mcpSmoke · with-mcp · primary, without broken runs
  'exp_01JBCMCPSM|0.0000,0.0000,0.3333,0.0000,-0.3333,0.0000,0.0000,1.0000,0.0000,0.0000,0.0000,0.0000':
    [-0.056, 0.278],
  // default · mcpSmoke · with-mcp · any_failed
  'exp_01JBCMCPSM|0.0000,0.0000,0.0000,0.0000,-0.3333,-0.3333,0.0000,1.0000,1.0000,0.0000,0.0000,0.0000':
    [-0.083, 0.389],
  // default · mcpSmoke · with-mcp · any_failed, without broken runs
  'exp_01JBCMCPSM|0.0000,0.0000,0.0000,0.0000,-0.3333,0.0000,0.0000,1.0000,1.0000,0.0000,0.0000,0.0000':
    [-0.056, 0.389],
  // default · skillVsNoSkill · with-skill · primary
  'exp_01JBB7SVNS|0.0000,0.4000,0.6000,0.2000,0.4000,0.2000,0.0000,0.4000,0.0000,0.2000,0.2000,0.0000':
    [0.117, 0.333],
  // default · skillVsNoSkill · with-skill · primary, without broken runs
  'exp_01JBB7SVNS|0.0000,0.4000,0.6000,0.2000,0.3500,0.2000,0.0000,0.3500,0.0000,0.1500,0.2000,0.0000':
    [0.104, 0.312],
  // default · skillVsNoSkill · with-skill · any_failed
  'exp_01JBB7SVNS|0.0000,0.4000,0.8000,0.2000,0.2000,0.2000,0.0000,0.4000,0.0000,0.2000,0.2000,0.0000':
    [0.1, 0.35],
  // default · skillVsNoSkill · with-skill · any_failed, without broken runs
  'exp_01JBB7SVNS|0.0000,0.4000,0.8000,0.2000,0.2500,0.2000,0.0000,0.3500,0.0000,0.1500,0.2000,0.0000':
    [0.1, 0.35],
  // no-worker · mcpVsBaseline · with-mcp · primary
  'exp_01JBFMCPVB|-0.2500,0.5000,0.5000,-0.2500,0.0833,-0.1500,-0.2500,0.3333,0.0000,-0.2500,0.1667,-0.3333':
    [-0.151, 0.181],
  // no-worker · mcpVsBaseline · with-mcp · any_failed
  'exp_01JBFMCPVB|-0.2500,0.5000,0.0000,-0.2500,0.0833,-0.1500,-0.2500,0.3333,0.7500,-0.2500,0.1667,-0.3333':
    [-0.147, 0.229],
  // multi-attempt · skillVsNoSkill · with-skill · primary, without broken runs
  'exp_01JBB7SVNS|0.0000,0.4000,0.6000,0.2000,0.3500,0.2000,0.0000,0.3500,0.0000,0.2000,0.2000,0.0000':
    [0.108, 0.313],
  // multi-attempt · skillVsNoSkill · with-skill · any_failed, without broken runs
  'exp_01JBB7SVNS|0.0000,0.4000,0.8000,0.2000,0.2500,0.2000,0.0000,0.3500,0.0000,0.2000,0.2000,0.0000':
    [0.104, 0.35],
  // disk-limit · skillVsNoSkill · with-skill · primary
  'exp_01JBB7SVNS|0.0000,0.4000,0.6000,0.2000,0.4000,0.2000,0.0000,0.4000,0.0000,0.2000,0.2000,-0.2000':
    [0.083, 0.317],
  // disk-limit · skillVsNoSkill · with-skill · any_failed
  'exp_01JBB7SVNS|0.0000,0.4000,0.8000,0.2000,0.2000,0.2000,0.0000,0.4000,0.0000,0.2000,0.2000,-0.2000':
    [0.067, 0.35],
  // token-cap · mcpSmoke · with-mcp · primary
  'exp_01JBCMCPSM|0.0000,0.0000,0.3333,-0.3333,-0.3333,-0.3333,0.0000,1.0000,0.0000,0.0000,0.0000,0.0000':
    [-0.139, 0.25],
  // token-cap · mcpSmoke · with-mcp · any_failed
  'exp_01JBCMCPSM|0.0000,0.0000,0.0000,-0.3333,-0.3333,-0.3333,0.0000,1.0000,1.0000,0.0000,0.0000,0.0000':
    [-0.139, 0.361],
  // provider-lapsed · skillVsNoSkill · with-skill · primary, without broken runs
  'exp_01JBB7SVNS|0.0000,0.4000,0.6000,0.2000,0.3500,0.2000,0.0000,0.5000,0.0000,0.1500,0.2000,0.0000':
    [0.108, 0.333],
  // provider-lapsed · skillVsNoSkill · with-skill · any_failed, without broken runs
  'exp_01JBB7SVNS|0.0000,0.4000,0.8000,0.2000,0.2500,0.2000,0.0000,0.5000,0.0000,0.1500,0.2000,0.0000':
    [0.104, 0.367],
};

/** The module's interval for an experiment's per-task differences (every task has one). */
export function intervalOf(
  experimentId: string,
  deltas: readonly (number | null)[],
): { lo: number; hi: number } {
  if (deltas.some((d) => d === null)) {
    throw new Error(`a task without a difference passed the gate in ${experimentId}`);
  }
  const key = intervalKey(experimentId, deltas as number[]);
  const found = INTERVALS[key];
  if (!found) {
    throw new Error(
      `No computed interval for ${key}: run apps/api's compute.spec.ts and add the entry it names to fixtures/statistics.ts`,
    );
  }
  return { lo: found[0], hi: found[1] };
}

/** better if lo > 0, worse if hi < 0, else inconclusive; provisional while running, paused or failed. */
export function verdictOf(lo: number, hi: number, provisional: boolean): VerdictState {
  if (provisional) return 'provisional';
  return lo > 0 ? 'better' : hi < 0 ? 'worse' : 'inconclusive';
}

/** The mean of the defined differences, three decimals; null when there are none. */
export function meanDelta(deltas: readonly (number | null)[]): number | null {
  const defined = deltas.filter((d): d is number => d !== null);
  if (defined.length === 0) return null;
  const mean = defined.reduce((sum, d) => sum + d, 0) / defined.length;
  return Math.round(mean * 1000) / 1000 || 0;
}

/** Counted runs of one task on each side. */
export interface TaskCounts {
  taskKey: string;
  baseline: number;
  candidate: number;
}

/**
 * Why there is no interval, in the module's order, or null: one repetition,
 * fewer than 3 tasks, nothing counted on either side, or some task with
 * fewer than 2 counted runs on a side.
 */
export function gateOf(
  repetitions: number,
  tasks: readonly TaskCounts[],
): NotComputableReason | null {
  if (repetitions === 1) return 'single_repetition';
  if (tasks.length < MIN_TASKS) return 'too_few_tasks';
  if (tasks.every((t) => t.baseline === 0 && t.candidate === 0)) return 'nothing_scored';
  if (!enoughRuns(tasks)) return 'not_enough_runs';
  return null;
}

/** Every task has at least 2 counted runs on both sides (and there are enough tasks). */
export const enoughRuns = (tasks: readonly TaskCounts[]): boolean =>
  tasks.length >= MIN_TASKS &&
  tasks.every((t) => t.baseline >= MIN_RUNS_PER_TASK && t.candidate >= MIN_RUNS_PER_TASK);

export interface SentenceInput {
  provisional: boolean;
  labels: { baseline: string; candidate: string };
  rates: { baseline: number | null; candidate: number | null };
  tasks: readonly TaskCounts[];
  /** Runs of the two configurations, cancelled included. */
  total: number;
}

const rateText = (rate: number | null): string => rate?.toFixed(2) ?? '—';
const PANEL_RULE = 'once every task has at least 2 scored repetitions per configuration.';

/**
 * The sentence the panel shows instead of the statistics, the module's word
 * for word (compute.ts messageOf): while the experiment runs, the design's,
 * which promise the panel; once it has settled, what is missing.
 */
export function notComputableMessage(reason: NotComputableReason, input: SentenceInput): string {
  const rates = `${input.labels.baseline} ${rateText(input.rates.baseline)}, ${input.labels.candidate} ${rateText(input.rates.candidate)}`;
  const tasks = plural(input.tasks.length, 'task');
  switch (reason) {
    case 'single_repetition':
      return (
        `No interval with 1 repetition. Pass rates: ${rates} on ${tasks}. ` +
        (input.tasks.length < MIN_TASKS
          ? `Run at least 2 repetitions of at least ${MIN_TASKS} tasks for a verdict.`
          : 'Run at least 2 repetitions for a verdict.')
      );
    case 'too_few_tasks':
      return (
        `No interval with ${tasks}. Pass rates: ${rates}. ` +
        `A verdict needs at least ${MIN_TASKS} tasks: the interval resamples the tasks, ` +
        'and with fewer it cannot say how sure the difference is.'
      );
    case 'nothing_scored':
      return input.provisional
        ? `0 of ${input.total} runs scored. Rows fill in as runs are scored; ` +
            `the statistics panel appears ${PANEL_RULE}`
        : `0 of ${input.total} runs scored: there are no pass rates to compare.`;
    case 'not_enough_runs': {
      if (input.provisional) return `The statistics panel appears ${PANEL_RULE}`;
      const short = input.tasks
        .filter((t) => Math.min(t.baseline, t.candidate) < MIN_RUNS_PER_TASK)
        .map((t) => t.taskKey);
      const named = short.length <= 3 ? short.join(', ') : `${short.slice(0, 3).join(', ')}, …`;
      return (
        `No interval: ${plural(short.length, 'task')} (${named}) counted fewer than 2 runs ` +
        'under a configuration, and cancelled runs do not count. ' +
        'A verdict needs at least 2 per task and configuration.'
      );
    }
  }
}
