/**
 * Rows 12 and 13 of the readiness panel (SA.8): the self-check and
 * "Doing nothing doesn't pass".
 *
 * Answer checks are self-checked here, live: scoring the reference as if it
 * were the answer is pure (plan 4.3 mode `answer`), so it runs on every
 * change. File checks and verifier scripts run user code or read files, so
 * only the worker self-checks them (POST …/self-check); their rows show the
 * last worker run while it ran on the task's current content, and wait
 * (`pending`) once an edit made it out of date.
 */
import type {
  DraftSelfCheckView,
  JsonValue,
  ReadinessRuleResult,
  VerificationEntry,
} from '@hermes-evals/shared';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import { scoreReferenceAsAnswer, type AnswerKey } from '../../scoring/answer.js';
import {
  parseVerificationEntry,
  selfCheckModeFor,
  type SelfCheckFolders,
  type SelfCheckMode,
} from '../../scoring/registry.js';
import { codeList } from './readiness-cross.js';

export interface SelfCheckInput {
  verification: readonly VerificationEntry[];
  /** undefined while reference.json is missing or not valid JSON. */
  reference: JsonValue | undefined;
  folders: SelfCheckFolders;
  /** task.yaml's negative_control, defaulted as the loader defaults it. */
  negativeControl: boolean;
  lastSelfCheck: DraftSelfCheckRecord | null;
  /** The task's content hash now. */
  contentHash: string;
  /** Raw index of a check in task.yaml's list, for Fix targets. */
  indexOf: (key: string) => number;
}

export interface SelfCheckRows {
  selfCheck: ReadinessRuleResult;
  negativeControl: ReadinessRuleResult;
  needsWorker: boolean;
}

const WORKER_MODES: readonly SelfCheckMode[] = ['script', 'workspace', 'home'];

const row = (
  rule: 'self_check' | 'negative_control',
  status: ReadinessRuleResult['status'],
  message: string,
  target: ReadinessRuleResult['target'] = null,
): ReadinessRuleResult => ({ rule, status, message, target });

const checkTarget = (index: number): ReadinessRuleResult['target'] => ({
  section: 'checks',
  field: index >= 0 ? `checks.${index}` : null,
});

const seconds = (ms: number | null): string => `${((ms ?? 0) / 1000).toFixed(1)} s`;

/** Why the reference fails an answer check: "no value at `overdue`", or the scorer's line. */
function failure(comment: string): string {
  const missing = /^the reference has no value at (.+)$/.exec(comment);
  return missing ? `no value at \`${missing[1]}\`` : comment.replace(/\.$/, '');
}

/** "untouched workspace" or "home seeds alone", where a negative control runs. */
const untouched = (mode: string): string =>
  mode === 'home' ? 'the home seeds alone' : 'the untouched workspace';

export function selfCheckRows(input: SelfCheckInput): SelfCheckRows {
  const entries = input.verification.map((entry) => ({
    entry,
    mode: selfCheckModeFor(entry, input.folders),
  }));
  const answers = entries.filter((e) => e.mode === 'answer');
  const workers = entries.filter((e) => WORKER_MODES.includes(e.mode));
  const scoredLater = entries.filter((e) => e.mode === 'none').map((e) => e.entry.key);
  const needsWorker = workers.length > 0;
  if (entries.length === 0) {
    return {
      selfCheck: row('self_check', 'pending', 'Runs once there is a check.'),
      negativeControl: row('negative_control', 'pending', 'Shown once there is a check.'),
      needsWorker,
    };
  }
  const later =
    scoredLater.length === 0
      ? ''
      : `${codeList(scoredLater)} ${scoredLater.length === 1 ? 'is' : 'are'} checked when runs are scored.`;

  // Answer checks, live.
  let answerRow: ReadinessRuleResult | null = null;
  if (answers.length > 0) {
    if (input.reference === undefined) {
      answerRow = row('self_check', 'pending', 'Runs once the reference is valid JSON.');
    } else {
      const reference = input.reference;
      const failed = answers
        .map(({ entry }) => {
          const parsed = parseVerificationEntry(entry);
          if (!parsed.success) return { key: entry.key, why: 'its settings are not valid' };
          const result = scoreReferenceAsAnswer(parsed.data as AnswerKey, reference);
          return result.status === 'passed'
            ? null
            : { key: entry.key, why: failure(result.comment) };
        })
        .find((f) => f !== null);
      answerRow = failed
        ? row(
            'self_check',
            'problem',
            `Reference fails \`${failed.key}\`: ${failed.why}.`,
            checkTarget(input.indexOf(failed.key)),
          )
        : null;
    }
  }
  const passedAnswers =
    answers.length > 0 ? `Reference passes ${codeList(answers.map((a) => a.entry.key))}` : '';

  // Checks that need the worker: the last run, while it is current.
  const last = input.lastSelfCheck;
  const current =
    last !== null && last.content_hash === input.contentHash && last.status !== 'skipped';
  const results = current ? last.results : [];
  const workerKeys = new Set(workers.map((w) => w.entry.key));
  const positive = results.filter((r) => workerKeys.has(r.key) && r.expect !== 'fail');
  const negative = results.filter((r) => workerKeys.has(r.key) && r.expect === 'fail');
  const brokenRun = positive.find((r) => r.status !== 'passed');
  const passingControl = negative.find((r) => r.status === 'passed');

  let selfCheck: ReadinessRuleResult;
  if (answerRow?.status === 'problem') {
    selfCheck = answerRow;
  } else if (needsWorker && current && passingControl) {
    selfCheck = row(
      'self_check',
      'problem',
      `\`${passingControl.key}\` passed on ${untouched(passingControl.mode)}, so doing nothing would pass. Make the check depend on what the agent writes.`,
      checkTarget(input.indexOf(passingControl.key)),
    );
  } else if (needsWorker && current && brokenRun) {
    const exited =
      brokenRun.timed_out === true
        ? 'the verifier script timed out, so the check is error'
        : brokenRun.exit_code !== undefined &&
            brokenRun.exit_code !== null &&
            brokenRun.exit_code !== 0
          ? `the verifier script exited with status ${brokenRun.exit_code}, so the check is error`
          : brokenRun.comment.replace(/\.$/, '');
    selfCheck = row(
      'self_check',
      'problem',
      `\`${brokenRun.key}\`: ${exited}.`,
      checkTarget(input.indexOf(brokenRun.key)),
    );
  } else if (answerRow !== null) {
    selfCheck = answerRow;
  } else if (needsWorker && !current) {
    selfCheck = row(
      'self_check',
      'pending',
      'File checks and verifier scripts run in the worker. Takes seconds.',
    );
  } else if (needsWorker) {
    const each = positive.map((r) =>
      r.type === 'verifier_script'
        ? `\`${r.key}\` scores ${(r.score ?? 0).toFixed(1)}`
        : `\`${r.key}\` passes on the expected ${r.mode === 'home' ? 'home' : 'workspace'}`,
    );
    const tail = [passedAnswers ? `${passedAnswers}.` : '', later].filter(Boolean).join(' ');
    selfCheck = row(
      'self_check',
      'passed',
      `Self-check passed · ${seconds(last?.duration_ms ?? null)}.${each.length > 0 ? ` ${each.join('; ')}.` : ''}${tail ? ` ${tail}` : ''}`,
    );
  } else if (answers.length > 0) {
    selfCheck = row(
      'self_check',
      'passed',
      `${passedAnswers} · checked live as you type${later ? `. ${later}` : ''}`,
    );
  } else {
    selfCheck = row('self_check', 'passed', `No answer checks to self-check. ${later}`.trim());
  }

  return {
    selfCheck,
    negativeControl: negativeRow(input, entries, {
      current,
      negative,
      workerFailed: selfCheck.status === 'problem',
    }),
    needsWorker,
  };
}

/** Row 13: the primary check, or every file check's negative control, must not pass on nothing. */
function negativeRow(
  input: SelfCheckInput,
  entries: ReadonlyArray<{ entry: VerificationEntry; mode: SelfCheckMode }>,
  run: {
    current: boolean;
    negative: DraftSelfCheckRecord['results'];
    workerFailed: boolean;
  },
): ReadinessRuleResult {
  const files = entries.filter((e) => e.mode === 'workspace' || e.mode === 'home');
  if (files.length > 0) {
    if (!input.negativeControl) {
      return row(
        'negative_control',
        'warning',
        'The negative control is off, so nothing checks that doing nothing fails.',
        { section: 'expected', field: 'negativeControl' },
      );
    }
    if (!run.current || run.negative.length === 0) {
      return row(
        'negative_control',
        'pending',
        run.workerFailed ? 'Shown after the self-check passes.' : 'Shown after the self-check.',
      );
    }
    const passing = run.negative.filter((r) => r.status === 'passed');
    if (passing.length > 0) {
      const first = passing[0]!;
      return row(
        'negative_control',
        'problem',
        `${codeList(passing.map((r) => r.key))} ${passing.length === 1 ? 'passes' : 'pass'} on ${untouched(first.mode)}.`,
        checkTarget(input.indexOf(first.key)),
      );
    }
    const keys = run.negative.map((r) => r.key).filter((k, i, all) => all.indexOf(k) === i);
    const mode = run.negative[0]!.mode;
    return row(
      'negative_control',
      'passed',
      `${codeList(keys)} ${keys.length === 1 ? 'fails' : 'fail'} on ${untouched(mode)}, as ${keys.length === 1 ? 'it' : 'they'} should.`,
    );
  }
  const primary = entries.find((e) => e.entry.primary) ?? entries[0]!;
  const { entry, mode } = primary;
  if (mode === 'answer') {
    return row(
      'negative_control',
      'passed',
      "Answer checks are ungradable with no answer, so doing nothing can't pass.",
    );
  }
  if (entry.type === 'trajectory_match') {
    const parsed = parseVerificationEntry(entry);
    if (!parsed.success || parsed.data.type !== 'trajectory_match') {
      return row('negative_control', 'pending', 'Shown once the check is valid.');
    }
    const { tool, min_calls: min, mode: compare } = parsed.data.params;
    if (compare === undefined && min === 0) {
      return row(
        'negative_control',
        'problem',
        `\`${entry.key}\` passes with no \`${tool}\` call, so doing nothing would pass.`,
        checkTarget(input.indexOf(entry.key)),
      );
    }
    const calls = compare !== undefined || min <= 1 ? 'at least one' : `at least ${min}`;
    return row(
      'negative_control',
      'passed',
      `\`${entry.key}\` needs ${calls} \`${tool}\` call${calls === 'at least one' ? '' : 's'}, so doing nothing fails.`,
    );
  }
  if (entry.type === 'llm_judge') {
    return row(
      'negative_control',
      'passed',
      `\`${entry.key}\` grades the final reply when runs are scored.`,
    );
  }
  return row(
    'negative_control',
    'passed',
    `\`${entry.key}\` runs on the answer, which is null when the agent gives none.`,
  );
}

/** The transcript of one result that ran a command, as the self-check block shows it. */
function transcriptOf(result: DraftSelfCheckRecord['results'][number]): string | null {
  if (result.argv === undefined) return null;
  const exit = result.timed_out ? 'timed out' : `exit status ${result.exit_code ?? '?'}`;
  return [
    `$ ${result.argv.join(' ')}`,
    ...(result.stderr_tail ? [result.stderr_tail.replace(/\n$/, '')] : []),
    `${exit} · ${result.comment} · ${seconds(result.duration_ms ?? null)}`,
  ].join('\n');
}

/** A stored worker self-check as the editor shows it; null when it never ran. */
export function selfCheckView(
  record: DraftSelfCheckRecord | null,
  contentHash: string | null,
): DraftSelfCheckView | null {
  if (record === null || record.ran_at === null) return null;
  return {
    status: record.status,
    ranAt: record.ran_at,
    durationMs: record.duration_ms ?? 0,
    contentHash: record.content_hash,
    current: record.content_hash === contentHash,
    results: record.results.map((r) => ({
      key: r.key,
      type: r.type,
      mode: r.mode,
      expect: r.expect ?? 'pass',
      status: r.status,
      score: r.score,
      comment: r.comment,
      transcript: transcriptOf(r),
    })),
  };
}
