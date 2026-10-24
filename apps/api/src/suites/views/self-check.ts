/**
 * Self-check results as Task detail shows them (TaskSelfCheckView), and the
 * diagnosis of a failing check that the failure view (self-check-failure.ts)
 * turns into a headline and an explanation.
 *
 * The loader stores one result per run: an entry checked on the hidden
 * expected workspace has a second result for its negative control (the same
 * check on the untouched fixtures, `expect: 'fail'`), whose status is the
 * check's own verdict. A negative control that passes means the check would
 * pass an agent that did nothing, so it fails the self-check. The view shows
 * one row per verification entry with both runs folded together.
 */
import type {
  ScoreStatus,
  ScorerType,
  SelfCheck,
  TaskSelfCheckResultView,
  TaskSelfCheckView,
  VerificationEntry,
} from '@hermes-evals/shared';
import { formatNumber, formatThreshold } from './format.js';

export type SelfCheckResult = SelfCheck['results'][number];

/** Every run of one verification key. */
export interface KeyCheck {
  key: string;
  type: ScorerType;
  /** The task.yaml entry, absent only for a result whose key is no longer declared. */
  entry: VerificationEntry | undefined;
  /** The check run as declared: on the reference answer or the expected workspace. */
  run: SelfCheckResult | undefined;
  /** The negative control on the untouched fixtures, when one ran. */
  negative: SelfCheckResult | undefined;
}

/** Results grouped by key, in task.yaml order; every declared entry gets a group. */
export function keyChecks(
  selfCheck: SelfCheck,
  verification: readonly VerificationEntry[],
): KeyCheck[] {
  const groups = new Map<string, KeyCheck>();
  for (const entry of verification) {
    groups.set(entry.key, {
      key: entry.key,
      type: entry.type,
      entry,
      run: undefined,
      negative: undefined,
    });
  }
  for (const result of selfCheck.results) {
    let group = groups.get(result.key);
    if (!group) {
      group = {
        key: result.key,
        type: result.type,
        entry: undefined,
        run: undefined,
        negative: undefined,
      };
      groups.set(result.key, group);
    }
    if (result.expect === 'fail') group.negative ??= result;
    else group.run ??= result;
  }
  return [...groups.values()];
}

/** The self-check verdict of one key: a passing negative control fails it. */
export function keyStatus(check: KeyCheck): ScoreStatus | 'skipped' {
  if (check.run && check.run.status !== 'passed') return check.run.status;
  if (check.negative?.status === 'passed') return 'failed';
  return check.run || check.negative ? 'passed' : 'skipped';
}

/** What went wrong with a failing key, for the note, the headline and the explanation. */
export type Diagnosis =
  | { kind: 'negative_control_passed' }
  | { kind: 'timed_out'; timeoutS: number | null }
  | { kind: 'below_pass_at'; score: number; passAt: number | null }
  | { kind: 'no_result_line' }
  | { kind: 'bad_json'; line: string }
  | { kind: 'no_score'; line: string }
  | { kind: 'nonzero_exit'; exitCode: number }
  | { kind: 'check_failed' }
  | { kind: 'check_error' };

/** Why a key whose status is not passed failed, from what the run captured. */
export function diagnose(check: KeyCheck): Diagnosis {
  const run = check.run;
  if (!run || run.status === 'passed') return { kind: 'negative_control_passed' };
  const params = check.entry?.params ?? {};
  if (run.timed_out) return { kind: 'timed_out', timeoutS: numberParam(params, 'timeout_s', 30) };
  if (run.status === 'failed' && run.score !== null && check.type === 'verifier_script') {
    return { kind: 'below_pass_at', score: run.score, passAt: numberParam(params, 'pass_at', 1) };
  }
  if (run.argv) {
    const line = lastLine(run.stdout_tail ?? '');
    if (line === null) return { kind: 'no_result_line' };
    const parsed = parseLine(line);
    if (parsed === undefined) return { kind: 'bad_json', line };
    if (!hasScore(parsed)) return { kind: 'no_score', line };
    if (run.exit_code !== undefined && run.exit_code !== null && run.exit_code !== 0) {
      return { kind: 'nonzero_exit', exitCode: run.exit_code };
    }
  }
  return run.status === 'failed' ? { kind: 'check_failed' } : { kind: 'check_error' };
}

/** `the reference answer` or `the expected workspace`, whichever the check ran on. */
export const targetOf = (check: KeyCheck): string =>
  check.run?.mode === 'workspace' || (!check.run && check.negative)
    ? 'the expected workspace'
    : 'the reference answer';

/** The short phrase after the check's name: "printed no result line on the reference answer". */
export function failurePhrase(check: KeyCheck, d: Diagnosis = diagnose(check)): string {
  const target = targetOf(check);
  switch (d.kind) {
    case 'negative_control_passed':
      return 'passes on the untouched fixtures too, so it would pass any agent';
    case 'timed_out':
      return d.timeoutS === null
        ? `timed out on ${target}`
        : `timed out after ${d.timeoutS} s on ${target}`;
    case 'below_pass_at':
      return (
        `scored ${formatNumber(d.score)} on ${target}` +
        (d.passAt === null ? '' : `, below pass at ${formatThreshold(d.passAt)}`)
      );
    case 'no_result_line':
      return `printed no result line on ${target}`;
    case 'bad_json':
      return `printed a result line that is not JSON on ${target}`;
    case 'no_score':
      return `printed a result line without a score on ${target}`;
    case 'nonzero_exit':
      return `exited with code ${d.exitCode} on ${target}`;
    case 'check_failed':
      return `fails on ${target}`;
    case 'check_error':
      return `errored on ${target}`;
  }
}

const SKIPPED_NOTES: Partial<Record<ScorerType, string>> = {
  trajectory_match:
    'definition valid · needs a trajectory, so it is not scored against the reference',
  llm_judge: 'definition valid · never called at load',
};

function noteOf(check: KeyCheck, status: ScoreStatus | 'skipped', loadErrors: boolean): string {
  if (status === 'skipped') {
    if (loadErrors && !check.run) return 'not run: the task has load errors';
    return SKIPPED_NOTES[check.type] ?? (check.run?.comment || 'not run at load');
  }
  if (status !== 'passed') return failurePhrase(check);
  if (check.run?.mode === 'workspace') {
    return check.negative
      ? 'passes on the expected workspace; fails on the untouched fixtures, as it should'
      : 'passes on the expected workspace';
  }
  return 'scored against the reference answer';
}

/** Task detail's self-check panel. `fallbackRanAt` is the suite's load time, for a check that never ran. */
export function selfCheckView(
  selfCheck: SelfCheck,
  verification: readonly VerificationEntry[],
  fallbackRanAt: string,
): TaskSelfCheckView {
  const loadErrors = selfCheck.status === 'skipped';
  const results: TaskSelfCheckResultView[] = keyChecks(selfCheck, verification).map((check) => {
    const status = keyStatus(check);
    return {
      key: check.key,
      type: check.type,
      status,
      score: check.run?.score ?? null,
      note: noteOf(check, status, loadErrors),
    };
  });
  return {
    status: selfCheck.status,
    ranAt: selfCheck.ran_at ?? fallbackRanAt,
    trigger: 'suite reload',
    results,
  };
}

function numberParam(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
): number | null {
  const value = params[name];
  if (value === undefined) return fallback;
  return typeof value === 'number' ? value : null;
}

/** The last non-blank line of a stdout tail, or null when nothing was printed. */
export function lastLine(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.at(-1)?.trim() ?? null;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

const hasScore = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { score?: unknown }).score === 'number';
