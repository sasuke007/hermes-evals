/**
 * What the API answers about a draft task in fixtures mode: the 13 readiness rules (SA.8),
 * Try it (SA.7) and the worker self-check. The API runs the loader's own analysis and the
 * real scorers (plan 4.6, V3); this file only stands in for them so the editor reacts as
 * it would, with the boards' wording, while the fixtures are edited in the browser and in
 * the component tests. Live mode never uses it.
 */
import {
  ANSWER_INSTRUCTIONS_LEAD,
  READINESS_RULES,
  SCORER_PARAM_SCHEMAS,
  summariseReadiness,
  VerificationKeySchema,
  type ReadinessRule,
} from '@hermes-evals/shared';
import type {
  ReadinessIssue,
  ReadinessRuleResult,
  ReadinessTarget,
  ReferenceValue,
  TaskReadiness,
} from './types/authoring';
import { ANSWER_TYPES, answerValueAt, checkPath, parseReference } from './drafts-fixture-score';
import {
  andList,
  code,
  leaks,
  mentioned,
  ok,
  row,
  selfCheckRows,
  settingMessage,
  type ReadinessInput,
} from './drafts-fixture-rules';

export type { ReadinessInput };

const WORKER_TYPES = ['file_check', 'verifier_script'];

/** The readiness of a fixture task, worded as SA.8 draws it. */
export function fixtureReadiness(input: ReadinessInput): TaskReadiness {
  const { form, files } = input;
  const rules = new Map<ReadinessRule, ReadinessRuleResult>();
  const issues: ReadinessIssue[] = [];
  const issue = (
    rule: ReadinessRule,
    target: ReadinessTarget,
    message: string,
    severity: 'problem' | 'warning' = 'problem',
  ) => issues.push({ rule, severity, target, message });
  const prompt = input.prompt ?? '';
  const ref = parseReference(input.reference);
  const checks = form.checks;
  const answerChecks = checks.filter((c) => ANSWER_TYPES.includes(c.type));
  const workerChecks = checks.filter((c) => WORKER_TYPES.includes(c.type));

  // 1 Key and summary
  if (form.summary.trim() === '') {
    issue('key_summary', { section: 'task', field: 'summary' }, 'Add a one-line summary.');
    rules.set(
      'key_summary',
      row('key_summary', 'problem', 'Add a one-line summary.', {
        section: 'task',
        field: 'summary',
      }),
    );
  } else rules.set('key_summary', ok('key_summary'));
  if (prompt.trim() === '')
    issue('answer_block', { section: 'prompt', field: 'prompt' }, 'The prompt is empty.');

  // 2 task.yaml, with the limits it holds
  const limitProblems: Array<[string, string]> = [];
  if (form.maxTurns !== null && (form.maxTurns < 1 || form.maxTurns > 200))
    limitProblems.push(['maxTurns', 'Max turns is 1 to 200.']);
  if (
    form.runBudgetSeconds !== null &&
    (form.runBudgetSeconds < 30 || form.runBudgetSeconds > 3600)
  )
    limitProblems.push(['runBudgetSeconds', 'Run budget is 30 to 3600 seconds.']);
  for (const [field, message] of limitProblems)
    issue('task_yaml', { section: 'limits', field }, message);
  if (input.lock) {
    const where = input.lock.line ? `line ${input.lock.line}: ` : '';
    rules.set(
      'task_yaml',
      row('task_yaml', 'problem', `${where}${input.lock.message}`, {
        section: 'yaml',
        field: null,
      }),
    );
  } else if (limitProblems.length > 0) {
    rules.set(
      'task_yaml',
      row('task_yaml', 'problem', limitProblems[0]![1], {
        section: 'limits',
        field: limitProblems[0]![0],
      }),
    );
  } else rules.set('task_yaml', ok('task_yaml'));

  // 3 checks and the primary
  const primaries = checks.filter((c) => c.primary);
  if (checks.length === 0)
    rules.set(
      'checks',
      row('checks', 'problem', 'Add at least one check.', { section: 'checks', field: null }),
    );
  else if (primaries.length !== 1)
    rules.set(
      'checks',
      row('checks', 'problem', 'Mark exactly one check as primary.', {
        section: 'checks',
        field: null,
      }),
    );
  else
    rules.set(
      'checks',
      ok(
        'checks',
        `${code(primaries[0]!.key)} is primary · ${checks.length} ${checks.length === 1 ? 'check' : 'checks'}`,
      ),
    );

  // 4 every check's settings
  let firstSetting: string | null = null;
  checks.forEach((check, i) => {
    const keyCheck = VerificationKeySchema.safeParse(check.key);
    if (!keyCheck.success) {
      const message = 'Check keys use lowercase letters, digits and `_`, starting with a letter.';
      issue('check_settings', { section: 'checks', field: `checks.${i}.key` }, message);
      firstSetting ??= message;
    } else if (checks.findIndex((c) => c.key === check.key) < i) {
      const message = `Two checks are named ${code(check.key)}.`;
      issue('check_settings', { section: 'checks', field: `checks.${i}.key` }, message);
      firstSetting ??= message;
    }
    const params = SCORER_PARAM_SCHEMAS[check.type].safeParse(check.params);
    if (!params.success) {
      const first = params.error.issues[0]!;
      const field = first.path.map(String).join('.');
      const message = settingMessage(check.type, field, first.message);
      issue(
        'check_settings',
        { section: 'checks', field: `checks.${i}.params${field ? `.${field}` : ''}` },
        message,
      );
      firstSetting ??= message;
    }
  });
  rules.set(
    'check_settings',
    firstSetting
      ? row('check_settings', 'problem', firstSetting, { section: 'checks', field: null })
      : ok('check_settings'),
  );

  // 5 reference JSON
  if (!ref.ok) {
    const empty = (input.reference ?? '').trim() === '';
    const message = empty ? 'Add the reference answer.' : 'The reference is not valid JSON.';
    rules.set(
      'reference_json',
      row('reference_json', 'problem', message, { section: 'reference', field: 'reference' }),
    );
  } else rules.set('reference_json', ok('reference_json'));

  // 6 every path a check reads
  const referenceValues: ReferenceValue[] = [];
  let missingPath: string | null = null;
  checks.forEach((check, i) => {
    if (!ANSWER_TYPES.includes(check.type)) return;
    const path = checkPath(form, i);
    const value = ref.ok ? answerValueAt(ref.value, path) : undefined;
    const preview = value === undefined ? null : JSON.stringify(value).slice(0, 80);
    if (ref.ok) referenceValues.push({ key: check.key, path, found: value !== undefined, preview });
    if (ref.ok && value === undefined && missingPath === null) {
      missingPath = `No value at ${code(path ?? '')} (check ${code(check.key)}).`;
    }
  });
  if (answerChecks.length === 0)
    rules.set(
      'reference_paths',
      checks.length === 0
        ? row('reference_paths', 'pending', 'Shown once a check reads a path.', null)
        : ok('reference_paths', 'No check reads the reference.'),
    );
  else if (missingPath)
    rules.set(
      'reference_paths',
      row('reference_paths', 'problem', missingPath, { section: 'answer', field: 'answerPath' }),
    );
  else if (!ref.ok)
    rules.set(
      'reference_paths',
      row('reference_paths', 'pending', 'Shown once the reference is valid JSON.', null),
    );
  else {
    const first = referenceValues[0]!;
    rules.set(
      'reference_paths',
      ok(
        'reference_paths',
        `${code(first.key)} reads ${first.path ? code(first.path) : 'the whole answer'}.`,
      ),
    );
  }

  // 7 file checks need an expected workspace
  const fileChecks = checks.filter((c) => c.type === 'file_check');
  const expected = files.filter((f) => f.kind === 'expected');
  if (fileChecks.length === 0)
    rules.set('expected_folders', ok('expected_folders', 'No file checks.'));
  else if (!form.expectedWorkspace || expected.length === 0)
    rules.set(
      'expected_folders',
      row('expected_folders', 'problem', 'Add an expected workspace: file checks run against it.', {
        section: 'expected',
        field: null,
      }),
    );
  else
    rules.set(
      'expected_folders',
      ok(
        'expected_folders',
        `${code(`${form.expectedWorkspace}/`)} has ${expected.length} ${expected.length === 1 ? 'file' : 'files'}.`,
      ),
    );

  // 8 the answer paragraph; an empty prompt is this row's problem, as in the API
  const asks = prompt.includes(ANSWER_INSTRUCTIONS_LEAD) || /```json/i.test(prompt);
  if (prompt.trim() === '')
    rules.set(
      'answer_block',
      row('answer_block', 'problem', 'The prompt is empty.', {
        section: 'prompt',
        field: 'prompt',
      }),
    );
  else if (!asks && answerChecks.length > 0)
    rules.set(
      'answer_block',
      row('answer_block', 'warning', "The prompt doesn't ask for a fenced json block.", {
        section: 'prompt',
        field: 'prompt',
      }),
    );
  else rules.set('answer_block', ok('answer_block'));

  // 9 files the prompt mentions
  const mentionedFiles = mentioned(prompt, files, form);
  const missing = mentionedFiles.filter((m) => m.location === 'missing').map((m) => code(m.name));
  const present = mentionedFiles.filter((m) => m.location === 'workspace').map((m) => code(m.name));
  if (missing.length > 0)
    rules.set(
      'mentioned_files',
      row(
        'mentioned_files',
        'warning',
        `${andList(missing)} ${missing.length === 1 ? 'is' : 'are'} mentioned but not in workspace files.`,
        { section: 'workspace', field: null },
      ),
    );
  else
    rules.set(
      'mentioned_files',
      ok(
        'mentioned_files',
        present.length
          ? `${andList(present)} ${present.length === 1 ? 'is' : 'are'} in workspace files.`
          : '',
      ),
    );

  // 10 no workspace file contains a reference value
  const leak = ref.ok ? leaks(ref.value, input.texts, files)[0] : undefined;
  if (leak) {
    const message = `${code(leak.file)} contains ${code(leak.value)}, the reference value at ${code(leak.path)}. The agent could read the answer.`;
    rules.set(
      'reference_leak',
      row('reference_leak', 'warning', message, { section: 'workspace', field: leak.file }),
    );
    issue('reference_leak', { section: 'workspace', field: leak.file }, message, 'warning');
  } else rules.set('reference_leak', ok('reference_leak'));

  // 11 files within limits
  rules.set('file_limits', ok('file_limits'));

  // 12 and 13 the self-check and the negative control
  const [selfRow, negativeRow] = selfCheckRows(
    input,
    answerChecks.map((c) => c.key),
    workerChecks.map((c) => c.key),
    missingPath,
  );
  rules.set('self_check', selfRow);
  rules.set('negative_control', negativeRow);

  const list = READINESS_RULES.map((r) => rules.get(r)!);
  const { summary, counts } = summariseReadiness(list);
  return {
    summary,
    counts,
    rules: list,
    issues,
    mentionedFiles,
    referenceValues,
    needsWorker: workerChecks.length > 0,
    checkedAt: input.now,
  };
}
