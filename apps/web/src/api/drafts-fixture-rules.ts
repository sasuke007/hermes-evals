/**
 * The parts of the fixture readiness (./drafts-fixture-checks.ts) that word single rows:
 * the files a prompt mentions, a reference value leaking into a text fixture, the designed
 * messages of a check's settings (SA.5, SA.7), and the self-check and negative-control rows
 * of SA.8. Live mode never uses it.
 */
import type { JsonValue, ReadinessRule } from '@hermes-evals/shared';
import type {
  DraftFileView,
  DraftSelfCheckView,
  MentionedFile,
  ReadinessRuleResult,
  ReadinessTarget,
  TaskForm,
} from './types/authoring';
import type { YamlLock } from './drafts-fixture-tasks';
import { parseReference } from './drafts-fixture-score';

export interface ReadinessInput {
  key: string;
  form: TaskForm;
  lock: YamlLock | null;
  prompt: string | null;
  reference: string | null;
  files: DraftFileView[];
  texts: Record<string, string>;
  selfCheck: DraftSelfCheckView | null;
  /** Other task keys of the draft (a rename onto one is refused). */
  otherKeys: string[];
  now: string;
}

export const code = (s: string) => `\`${s}\``;
export const andList = (items: string[]) =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** Backticked names with an extension in the prompt: the files it mentions. */
export function mentioned(prompt: string, files: DraftFileView[], form: TaskForm): MentionedFile[] {
  const names = [
    ...new Set([...prompt.matchAll(/`([\w./-]+\.[A-Za-z0-9]{2,5})`/g)].map((m) => m[1]!)),
  ];
  return names.map((name) => {
    const has = (kind: string) =>
      files.some((f) => f.kind === kind && (f.path.endsWith(`/${name}`) || f.path === name));
    if (has('fixture')) return { name, location: 'workspace' as const };
    if (has('expected') || (form.expectedWorkspace && name.endsWith('.csv') && has('expected')))
      return { name, location: 'expected' as const };
    if (has('home_seed')) return { name, location: 'home' as const };
    return { name, location: 'missing' as const };
  });
}

/** Reference leaf values of 4 or more characters found in a text fixture (rule 10). */
export function leaks(
  reference: JsonValue | undefined,
  texts: Record<string, string>,
  files: DraftFileView[],
) {
  const leaves: string[] = [];
  const walk = (v: JsonValue | undefined, path: string) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k);
      return;
    }
    const text = String(v);
    if (text.length >= 4) leaves.push(`${path}\u0000${text}`);
  };
  walk(reference, '');
  const found: Array<{ file: string; value: string; path: string }> = [];
  for (const f of files.filter((x) => x.kind === 'fixture' && texts[x.path] !== undefined)) {
    for (const leaf of leaves) {
      const [path, value] = leaf.split('\u0000') as [string, string];
      if (texts[f.path]!.includes(value)) found.push({ file: f.path, value, path });
    }
  }
  return found;
}

export const ok = (rule: ReadinessRule, message = ''): ReadinessRuleResult => ({
  rule,
  status: 'passed',
  message,
  target: null,
});
export const row = (
  rule: ReadinessRule,
  status: 'warning' | 'problem' | 'pending',
  message: string,
  target: ReadinessTarget | null,
): ReadinessRuleResult => ({ rule, status, message, target: status === 'pending' ? null : target });

/** The designed messages of a param error, where the boards draw one (SA.5, SA.7). */
export function settingMessage(type: string, field: string, fallback: string): string {
  if (field === 'abs' || field === 'rel') return "Tolerance can't be negative.";
  if (field === 'pass_at') return 'Use a number between 0 and 1.';
  if (field === 'timeout_s') return 'Timeout is 1 to 300 seconds.';
  if (field === 'max_calls') return 'Max calls must be at least min calls.';
  if (type === 'file_check' && (field === 'columns' || field === 'row_count'))
    return 'Columns and row count need format csv.';
  if (field === 'json_schema') return 'A JSON Schema needs format json.';
  if (type === 'text_match' && field === 'contains' && /phrase or a pattern/.test(fallback))
    return 'Add at least one phrase or a pattern.';
  return fallback;
}

export function selfCheckRows(
  input: ReadinessInput,
  answerKeys: string[],
  workerKeys: string[],
  missingPath: string | null,
): [ReadinessRuleResult, ReadinessRuleResult] {
  const checksTarget: ReadinessTarget = { section: 'checks', field: null };
  if (answerKeys.length === 0 && workerKeys.length === 0) {
    if (input.form.checks.length === 0)
      return [
        row('self_check', 'pending', 'Runs once there is a check.', null),
        row('negative_control', 'pending', 'Shown once there is a check.', null),
      ];
    const key = input.form.checks[0]!.key;
    return [
      ok(
        'self_check',
        `No answer checks to self-check. ${code(key)} is checked when runs are scored.`,
      ),
      ok('negative_control', ''),
    ];
  }
  if (workerKeys.length === 0) {
    if (!input.reference || parseReference(input.reference).ok === false)
      return [
        row('self_check', 'pending', 'Runs once the reference is valid JSON.', null),
        row('negative_control', 'pending', 'Shown once the self-check can run.', null),
      ];
    if (missingPath)
      return [
        row(
          'self_check',
          'problem',
          `Reference fails ${code(answerKeys[0]!)}: ${missingPath.charAt(0).toLowerCase()}${missingPath.slice(1).replace(/ \(check .*\)\.$/, '.')}`,
          checksTarget,
        ),
        ok('negative_control', 'Answer checks are ungradable with no answer.'),
      ];
    return [
      ok('self_check', `Reference passes ${code(answerKeys[0]!)} · checked live as you type`),
      ok(
        'negative_control',
        "Answer checks are ungradable with no answer, so doing nothing can't pass.",
      ),
    ];
  }
  const run = input.selfCheck;
  if (!run || !run.current)
    return [
      row(
        'self_check',
        'pending',
        'File checks and verifier scripts run in the worker. Takes seconds.',
        null,
      ),
      row('negative_control', 'pending', 'Shown after the self-check.', null),
    ];
  const negative = run.results.find((r) => r.expect === 'fail' && r.status === 'passed');
  if (negative)
    return [
      row(
        'self_check',
        'problem',
        `${code(negative.key)} passed on the untouched workspace, so doing nothing would pass. Make the check depend on what the agent writes.`,
        checksTarget,
      ),
      row(
        'negative_control',
        'problem',
        `${code(negative.key)} passes on the untouched workspace.`,
        checksTarget,
      ),
    ];
  const errored = run.results.find((r) => r.status === 'error');
  if (errored)
    return [
      row('self_check', 'problem', `${code(errored.key)}: ${errored.comment}`, checksTarget),
      row('negative_control', 'pending', 'Shown after the self-check passes.', null),
    ];
  const failed = run.results.find(
    (r) => r.expect === 'pass' && r.status !== 'passed' && r.status !== 'skipped',
  );
  const control = run.results.find((r) => r.expect === 'fail');
  const negativeOk = ok(
    'negative_control',
    control ? `${code(control.key)} fails on the untouched workspace, as it should.` : '',
  );
  if (failed)
    return [
      row('self_check', 'problem', `${code(failed.key)}: ${failed.comment}`, checksTarget),
      negativeOk,
    ];
  const ran = new Date(run.ranAt);
  const clock = `${String(ran.getHours()).padStart(2, '0')}:${String(ran.getMinutes()).padStart(2, '0')}`;
  return [
    ok('self_check', `Self-check passed · ${clock} · ${(run.durationMs / 1000).toFixed(1)} s.`),
    negativeOk,
  ];
}
