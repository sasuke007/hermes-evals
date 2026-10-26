/**
 * The failure panel of an invalid task (SelfCheckFailureView): a headline
 * such as "verifier_script check_late_fees.py printed no result line on the
 * reference answer · score status error", the run exactly as the self-check
 * captured it, a plain-English explanation of the likely cause and fix, and
 * how the same check did on the previous load.
 *
 * A task invalid because it could not be loaded (load issues, so no check
 * ran) gets the same panel built from its issues, so the UI can always say
 * why a task cannot be selected.
 */
import type {
  LoadIssue,
  SelfCheck,
  SelfCheckFailureView,
  VerificationEntry,
} from '@hermes-evals/shared';
import { baseName, formatThreshold, listPhrase, suiteDisplayPath } from './format.js';
import {
  diagnose,
  failurePhrase,
  isHomeCheck,
  keyChecks,
  keyStatus,
  lastLine,
  targetOf,
  type Diagnosis,
  type KeyCheck,
  type SelfCheckResult,
} from './self-check.js';

/** The same task key as checked on the previous load of its directory. */
export interface PreviousCheck {
  selfCheck: SelfCheck;
  verification: readonly VerificationEntry[];
  /** When that check ran (its suite version's load time when it has no time of its own). */
  ranAt: string;
}

export interface FailureInput {
  /** Suite directory relative to SUITES_DIR. */
  sourcePath: string;
  taskKey: string;
  valid: boolean;
  invalidReason: string | null;
  verification: readonly VerificationEntry[];
  selfCheck: SelfCheck;
  loadIssues: readonly LoadIssue[];
  /** The suite version's load time, for a check without a time of its own. */
  loadedAt: string;
  previous: PreviousCheck | null;
  /** Files of this task that changed since `previous` (changes.ts changedFiles). */
  changedSincePrevious: readonly string[];
}

/** The failure panel, or null for a valid task. */
export function selfCheckFailureView(input: FailureInput): SelfCheckFailureView | null {
  if (input.valid) return null;
  const failing = keyChecks(input.selfCheck, input.verification).find(
    (check) => !['passed', 'skipped'].includes(keyStatus(check)),
  );
  if (failing) return checkFailure(input, failing);
  return loadFailure(input);
}

function checkFailure(input: FailureInput, check: KeyCheck): SelfCheckFailureView {
  const d = diagnose(check);
  const status = keyStatus(check);
  const title =
    d.kind === 'negative_control_passed'
      ? `${check.type} ${subjectOf(check)} passed on ${untouchedOf(check)} (negative control)`
      : `${check.type} ${subjectOf(check)} ${failurePhrase(check, d)} · score status ${status}`;
  return {
    key: check.key,
    type: check.type,
    title,
    status: status === 'skipped' ? 'error' : status,
    ranAt: input.selfCheck.ran_at ?? input.loadedAt,
    durationMs: (check.run?.duration_ms ?? 0) + (check.negative?.duration_ms ?? 0),
    previousRun: previousRun(input.previous, check.key),
    transcript: transcriptOf(check, d),
    explanation: [explain(check, d), changedHint(input, check, d), fixHint(input)]
      .filter(Boolean)
      .join(' '),
  };
}

/** The panel for a task whose load issues kept its checks from running. */
function loadFailure(input: FailureInput): SelfCheckFailureView | null {
  const errors = input.loadIssues.filter((issue) => issue.severity === 'error');
  const issue = errors[0];
  const entry =
    input.verification.find((e) => e.key === issue?.key) ??
    input.verification.find((e) => e.primary) ??
    input.verification[0];
  // The view needs a scorer type; a task with no parseable entry has none to show.
  if (!entry) return null;
  const message = issue?.message ?? input.invalidReason ?? 'the task did not pass its self-check';
  const where = issue?.path ?? 'task.yaml';
  return {
    key: entry.key,
    type: entry.type,
    title: issue ? `${where}: ${message}` : message,
    status: 'error',
    ranAt: input.selfCheck.ran_at ?? input.loadedAt,
    durationMs: input.selfCheck.duration_ms ?? 0,
    previousRun: previousRun(input.previous, entry.key),
    transcript: input.loadIssues
      .map((i) => [i.severity, i.code, i.path ?? '', i.message].filter(Boolean).join('  '))
      .join('\n'),
    explanation: [
      errors.length > 0
        ? `The task could not be loaded as written (${errors.length === 1 ? '1 error' : `${errors.length} errors`}), so its checks did not run.`
        : (input.invalidReason ?? ''),
      fixHint(input),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** What the headline names after the type: the script, the file, or the answer path. */
function subjectOf(check: KeyCheck): string {
  const params = check.entry?.params ?? {};
  const text = (name: string): string | null =>
    typeof params[name] === 'string' ? (params[name] as string) : null;
  switch (check.type) {
    case 'verifier_script':
      return baseName(text('script') ?? check.key);
    case 'file_check':
      return text('path') ?? check.key;
    case 'numeric_tolerance':
    case 'json_match':
    case 'exact_match':
      return `on ${text('path') ?? 'the whole answer'}`;
    default:
      return check.key;
  }
}

function previousRun(
  previous: PreviousCheck | null,
  key: string,
): SelfCheckFailureView['previousRun'] {
  if (!previous) return null;
  const check = keyChecks(previous.selfCheck, previous.verification).find((c) => c.key === key);
  const status =
    check && (check.run || check.negative) ? keyStatus(check) : previous.selfCheck.status;
  if (status === 'skipped') return null;
  return {
    at: previous.selfCheck.ran_at ?? previous.ranAt,
    status: status === 'ungradable' ? 'error' : status,
  };
}

/** What a key's negative control runs on: the untouched fixtures, or the home seeds alone. */
const untouchedOf = (check: KeyCheck): string =>
  isHomeCheck(check) ? 'the home seeds alone' : 'the untouched fixtures';

/** The runs of one key as captured: command, output, exit, then what was expected. */
function transcriptOf(check: KeyCheck, d: Diagnosis): string {
  const runs: string[] = [];
  if (check.run) runs.push(runTranscript(check, check.run, null));
  if (check.negative)
    runs.push(runTranscript(check, check.negative, `negative control, on ${untouchedOf(check)}`));
  if (d.kind === 'negative_control_passed') runs.push('expected the negative control not to pass');
  return runs.join('\n\n');
}

function runTranscript(check: KeyCheck, run: SelfCheckResult, label: string | null): string {
  const lines: string[] = [];
  if (label) lines.push(`# ${label}`);
  if (run.argv) {
    lines.push(`$ ${run.argv.map(shellQuote).join(' ')}`);
    for (const tail of [run.stdout_tail, run.stderr_tail]) {
      if (tail && tail.trim() !== '') lines.push(tail.replace(/\s+$/, ''));
    }
    if (run.timed_out) lines.push('timed out; the process was killed');
    else if (run.exit_code !== undefined && run.exit_code !== null)
      lines.push(`exit code ${run.exit_code}`);
    if (check.type === 'verifier_script' && run.expect !== 'fail') {
      const line = lastLine(run.stdout_tail ?? '');
      lines.push(
        `expected on stdout: one JSON line {"key": "${check.key}", "score": …, "comment": "…"}`,
      );
      lines.push(`got: ${line ?? 'no line'}`);
    }
  } else {
    lines.push(
      `${check.type} ${check.key} on ${run.expect === 'fail' ? untouchedOf(check) : targetOf(check)}`,
    );
    if (check.entry) lines.push(`params: ${JSON.stringify(check.entry.params)}`);
  }
  const score = run.score === null ? '' : ` · score ${run.score}`;
  lines.push(`status: ${run.status}${score}${run.comment ? ` · ${run.comment}` : ''}`);
  return lines.join('\n');
}

const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** A Python exception line from stderr, e.g. `KeyError: 'late_fee_rate'`. */
function exceptionOf(run: SelfCheckResult | undefined): string | null {
  const lines = (run?.stderr_tail ?? '').split(/\r?\n/).map((l) => l.trim());
  const match = lines
    .reverse()
    .find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b:?/.test(l));
  return match ?? null;
}

function explain(check: KeyCheck, d: Diagnosis): string {
  const comment = check.run?.comment ? `: ${withStop(check.run.comment)}` : '.';
  const home = isHomeCheck(check);
  const whatIsChecked = home
    ? 'the files in the expected home (self_check.expected_home)'
    : targetOf(check) === 'the expected workspace'
      ? 'the files in expected/'
      : 'reference.json';
  switch (d.kind) {
    case 'negative_control_passed':
      return home
        ? 'The check also passes on the home seeds alone, so it would pass an agent that saved nothing. ' +
            'Make it check what the task asks the agent to save, or make sure the expected home really differs from home/.'
        : 'The check also passes on the untouched fixtures, so it would pass an agent that did nothing. ' +
            'Make it check what the task asks the agent to produce, or make sure expected/ really differs from fixtures/.';
    case 'timed_out':
      return `The script ran past its ${d.timeoutS ?? 30} s timeout on ${targetOf(check)}. Make it faster, or raise timeout_s in task.yaml (at most 300).`;
    case 'below_pass_at':
      return `The script scored ${targetOf(check)} ${d.score}${d.passAt === null ? '' : `, below pass_at ${formatThreshold(d.passAt)}`}. Either ${whatIsChecked} or the script is wrong.`;
    case 'no_result_line': {
      const exception = exceptionOf(check.run);
      const exit = check.run?.exit_code;
      return (
        `The script must print one JSON line such as {"key": "${check.key}", "score": 1, "comment": "…"} on stdout, and printed none.` +
        (exception
          ? ` It raised ${exception} first (see the traceback).`
          : exit !== undefined && exit !== null && exit !== 0
            ? ` It exited with code ${exit}.`
            : '')
      );
    }
    case 'bad_json':
      return 'The last line the script printed is not valid JSON. Print exactly one JSON object as the last line of stdout.';
    case 'no_score':
      return 'The result line has no numeric "score". Print {"key": …, "score": <0 to 1>, "comment": …}.';
    case 'nonzero_exit':
      return `The script printed a result but exited with code ${d.exitCode}. A verifier must exit 0 after printing its result line.`;
    case 'check_failed':
      if (home) {
        return `The expected home (home/ overlaid with self_check.expected_home) does not pass this check${comment} Fix the expected home or the entry's params in task.yaml.`;
      }
      return targetOf(check) === 'the expected workspace'
        ? `The expected workspace (fixtures/ overlaid with expected/) does not pass this check${comment} Fix expected/ or the entry's params in task.yaml.`
        : `reference.json does not satisfy its own ${check.type} check${comment} Fix reference.json or the entry's params in task.yaml.`;
    case 'check_error':
      return `The check itself failed with an error${comment}`;
  }
}

/** Points at files that changed since the last load, the usual cause of a newly failing check. */
function changedHint(input: FailureInput, check: KeyCheck, d: Diagnosis): string {
  const files = input.changedSincePrevious;
  if (!input.previous || files.length === 0) return '';
  const passedBefore = previousRun(input.previous, check.key)?.status === 'passed';
  const keysHint =
    d.kind === 'no_result_line' &&
    /^KeyError\b/.test(exceptionOf(check.run) ?? '') &&
    files.some((f) => f.endsWith('.json'))
      ? ', and its keys may no longer match what the script reads'
      : '';
  return `${listPhrase(files)} changed since the previous load${passedBefore ? ', when this check passed' : ''}${keysHint}.`;
}

/** A sentence ends with a full stop unless it already has one. */
const withStop = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

const fixHint = (input: FailureInput): string =>
  `Fix it in ${suiteDisplayPath(input.sourcePath)}/${input.taskKey}/, then reload.`;
