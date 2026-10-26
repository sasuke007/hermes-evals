/**
 * Fixture content of draft tasks (SA.3 to SA.8): the text files and file lists the editor
 * shows in fixtures mode. Base tasks are the suite fixtures' tasks (src/fixtures/suites.ts);
 * the tasks the authoring boards add (`overdue_count`, Flow E's `unmatched_lines`) are here.
 *
 * The API writes task.yaml through the yaml Document API and reads it back as a TaskForm
 * (plan 4.6, V5). The browser has no YAML library, so this file stands in for both sides
 * with the canonical style new files use, and a line reader that is just enough for the
 * designed states: the fields the boards edit, an unknown key and a second primary, which
 * lock the form (SA.6, SA.5). Live mode never uses it.
 */
import { ANSWER_INSTRUCTIONS_LEAD, isHomeSeedPath } from '@hermes-evals/shared';
import type { JsonValue } from '@hermes-evals/shared';
import type { DraftFileView, DraftFileViewKind, TaskForm } from './types/authoring';
import type { TaskDetail } from './types/suites';
import { sha } from '@/fixtures/suites';

const FENCE = '```';

// ---------------------------------------------------------------------------
// task.yaml, canonical style
// ---------------------------------------------------------------------------

const PLAIN = /^[A-Za-z_./][\w ./%-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

/** A scalar as YAML writes it: plain when it reads back the same, else double-quoted. */
function scalar(value: JsonValue): string {
  if (typeof value === 'string') {
    const plain = PLAIN.test(value) && !RESERVED.test(value) && value.trim() === value;
    return plain ? value : JSON.stringify(value);
  }
  return flow(value);
}

/** A value in flow style: `{ abs: 0 }`, `[file, terminal]`. */
export function flow(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${flow(v)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  return typeof value === 'string' ? scalar(value) : String(value);
}

/** task.yaml in the style new files are written in (plan 4.6, "one canonical style"). */
export function taskYamlOf(form: TaskForm): string {
  const lines = [`summary: ${scalar(form.summary)}`, 'limits:'];
  if (form.maxTurns !== null) lines.push(`  max_turns: ${form.maxTurns}`);
  if (form.runBudgetSeconds !== null) lines.push(`  run_budget_seconds: ${form.runBudgetSeconds}`);
  lines.push(`  toolsets_needed: ${flow(form.toolsetsNeeded)}`);
  const answer: Record<string, JsonValue> = { format: 'fenced_json' };
  if (form.answerPath) answer.path = form.answerPath;
  lines.push(`answer: ${flow(answer)}`);
  lines.push('verification:');
  for (const check of form.checks) {
    lines.push(`  - key: ${scalar(check.key)}`, `    type: ${check.type}`);
    if (check.primary) lines.push('    primary: true');
    if (Object.keys(check.params).length > 0) lines.push(`    params: ${flow(check.params)}`);
  }
  const selfCheck: Record<string, JsonValue> = {};
  if (form.expectedWorkspace) selfCheck.expected_workspace = form.expectedWorkspace;
  if (form.expectedHome) selfCheck.expected_home = form.expectedHome;
  if (form.negativeControl !== null) selfCheck.negative_control = form.negativeControl;
  if (form.answersFromFixtures) selfCheck.answers_from_fixtures = true;
  if (Object.keys(selfCheck).length > 0) {
    lines.push('self_check:');
    for (const [k, v] of Object.entries(selfCheck)) lines.push(`  ${k}: ${scalar(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Reading task.yaml back (fixtures only)
// ---------------------------------------------------------------------------

const KNOWN_KEYS = [
  'summary',
  'limits',
  'max_turns',
  'run_budget_seconds',
  'toolsets_needed',
  'answer',
  'format',
  'path',
  'verification',
  'key',
  'type',
  'primary',
  'params',
  'self_check',
  'expected_workspace',
  'expected_home',
  'negative_control',
  'answers_from_fixtures',
];

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

export interface YamlLock {
  line: number | null;
  column: number | null;
  message: string;
}

/**
 * The form task.yaml describes, as far as the designed states need: the scalar fields, or
 * the lock an unknown key or a second primary puts on the form. Fields this reader does not
 * follow keep their value from `previous`.
 */
export function readTaskYaml(
  text: string,
  previous: TaskForm,
): { form: TaskForm; lock: null } | { form: null; lock: YamlLock } {
  const lines = text.split('\n');
  let paramsIndent = -1;
  let primaries = 0;
  const form: TaskForm = structuredClone(previous);
  for (const [i, raw] of lines.entries()) {
    const match = /^(\s*)(- )?([A-Za-z_][\w]*):\s*(.*)$/.exec(raw);
    if (!match) continue;
    const indent = match[1]!.length + (match[2] ? 2 : 0);
    const name = match[3]!;
    const rest = match[4]!.trim();
    if (paramsIndent >= 0 && indent > paramsIndent) continue;
    paramsIndent = name === 'params' && rest === '' ? indent : -1;
    if (!KNOWN_KEYS.includes(name)) {
      const near = KNOWN_KEYS.find((k) => distance(k, name) <= 2);
      const hint = near ? ` Did you mean \`${near}\`?` : '';
      return {
        form: null,
        lock: { line: i + 1, column: indent + 1, message: `unknown key \`${name}\`.${hint}` },
      };
    }
    if (name === 'primary' && rest === 'true' && ++primaries > 1) {
      return {
        form: null,
        lock: {
          line: i + 1,
          column: indent + 1,
          message: 'a second check is marked primary. Mark exactly one check as primary.',
        },
      };
    }
    const number = Number(rest);
    if (name === 'summary') form.summary = rest.replace(/^"(.*)"$/, '$1');
    if (name === 'max_turns') form.maxTurns = Number.isInteger(number) ? number : null;
    if (name === 'run_budget_seconds')
      form.runBudgetSeconds = Number.isInteger(number) ? number : null;
    if (name === 'answers_from_fixtures') form.answersFromFixtures = rest === 'true' ? true : null;
  }
  return { form, lock: null };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** What a row of the Files tab says about a kind: who sees it and where. */
export function fileView(
  path: string,
  kind: DraftFileViewKind,
  sizeBytes: number,
  typeLabel: string,
  sha256 = sha(`draft:${path}:${sizeBytes}`),
): DraftFileView {
  const inside = (dir: string) => path.slice(dir.length + 1);
  let visibility: DraftFileView['visibility'] = 'hidden';
  let agentPath: string | null = null;
  if (kind === 'prompt') [visibility, agentPath] = ['agent', 'task.txt'];
  if (kind === 'fixture') [visibility, agentPath] = ['agent', `/workspace/${inside('fixtures')}`];
  if (kind === 'home_seed') [visibility, agentPath] = ['agent', `~/${inside('home')}`];
  if (kind === 'other') visibility = 'other';
  return { path, kind, visibility, agentPath, sizeBytes, sha256, typeLabel };
}

/** "CSV · 31 rows · 5 columns", "Text · 3 lines", "PDF", from a name and its text. */
export function typeLabelOf(name: string, text: string | null): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (text === null) return ext ? ext.toUpperCase() : 'File';
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (ext === 'csv' || ext === 'tsv') {
    const columns = (lines[0] ?? '').split(ext === 'csv' ? ',' : '\t').length;
    return `CSV · ${Math.max(0, lines.length - 1)} rows · ${columns} columns`;
  }
  if (ext === 'json') return 'JSON';
  return `Text · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
}

/** The kind of a task-folder path, as the draft stores it (plan 4.6, V2). */
export function kindOfPath(path: string, form: TaskForm): DraftFileViewKind {
  const under = (dir: string | null) => !!dir && path.startsWith(`${dir.replace(/\/$/, '')}/`);
  if (path.startsWith('fixtures/')) return 'fixture';
  if (isHomeSeedPath(path)) return 'home_seed';
  if (path.toLowerCase().startsWith('verify/')) return 'verifier';
  if (under(form.expectedHome)) return 'expected_home';
  if (under(form.expectedWorkspace)) return 'expected';
  return 'other';
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Everything a fixture task holds; DraftTaskDetail is built from it. */
export interface FixtureTaskContent {
  form: TaskForm;
  prompt: string | null;
  reference: string | null;
  rubrics: Array<{ path: string; text: string }>;
  /** Files other than the text files the forms edit. */
  files: DraftFileView[];
  /** Text of files a View or a leak check reads (verify/ sources, text fixtures). */
  texts: Record<string, string>;
}

/** A base task of the suite fixtures, as a draft holds it. */
export function contentOfTask(
  task: Omit<TaskDetail, 'experiments' | 'homeFiles'>,
): FixtureTaskContent {
  const primary = task.verification.find((v) => v.primary);
  const answerPath = typeof primary?.params.path === 'string' ? primary.params.path : null;
  const form: TaskForm = {
    summary: task.summary,
    maxTurns: task.limits.maxTurns,
    runBudgetSeconds: task.limits.budgetS,
    toolsetsNeeded: task.limits.toolsetsNeeded,
    answerPath,
    checks: task.verification.map((v) => {
      const params = { ...v.params };
      if (v.primary && answerPath) delete params.path;
      return { key: v.key, type: v.type, primary: v.primary, params };
    }),
    expectedWorkspace: task.verification.some((v) => v.type === 'file_check') ? 'expected' : null,
    expectedHome: null,
    negativeControl: null,
  };
  const files = task.fixtures.map((f) =>
    fileView(`fixtures/${f.path}`, 'fixture', f.sizeBytes, f.typeLabel, f.sha256),
  );
  const texts: Record<string, string> = {};
  if (form.expectedWorkspace) {
    files.push(fileView('expected/summary.csv', 'expected', 307, 'CSV · 9 rows · 2 columns'));
  }
  if (task.verifier) {
    const size = new TextEncoder().encode(task.verifier.source).length;
    files.push(fileView(task.verifier.path, 'verifier', size, 'Python', task.verifier.sha256));
    texts[task.verifier.path] = task.verifier.source;
  }
  const rubrics = task.verification
    .filter((v) => v.type === 'llm_judge' && typeof v.params.rubric === 'string')
    .map((v) => ({ path: String(v.params.rubric), text: RUBRIC }));
  return {
    form,
    prompt: task.prompt.markdown,
    reference: `${JSON.stringify(task.reference.value, null, 2)}\n`,
    rubrics,
    files,
    texts,
  };
}

const RUBRIC = `Score 1 when the reply states the rule it used and gives exactly one answer.
Score 0.5 when it gives the answer without the rule.
Score 0 when it gives no answer.
Ignore formatting.
`;

const answerParagraph = (shape: string) =>
  `${ANSWER_INSTRUCTIONS_LEAD}\n\n${FENCE}json\n${shape}\n${FENCE}`;

const INVOICES = fileView('fixtures/invoices.csv', 'fixture', 4198, 'CSV · 48 rows · 8 columns');

/** overdue_count, the task SA.4 adds to invoices-v1. */
export function overdueCountContent(): FixtureTaskContent {
  return {
    form: {
      summary: 'Count invoices past due as of 1 Oct 2026',
      maxTurns: 20,
      runBudgetSeconds: 300,
      toolsetsNeeded: ['file', 'terminal'],
      answerPath: 'overdue_count',
      checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
      expectedWorkspace: null,
      expectedHome: null,
      negativeControl: null,
    },
    prompt: `Your working directory contains \`invoices.csv\`, our accounts-payable ledger. Treat 1 October 2026 as today.

An invoice is overdue when its \`status\` is not \`paid\` and its \`due_date\` is before today.

How many invoices are overdue?

${answerParagraph('{ "overdue_count": 0 }')}
`,
    reference: '{ "overdue_count": 17 }\n',
    rubrics: [],
    files: [INVOICES],
    texts: {},
  };
}

/** The same task in SA.5's problems state: a wrong path, no answer paragraph, ledger.csv missing. */
export function overdueCountProblems(): FixtureTaskContent {
  const content = overdueCountContent();
  content.form.answerPath = 'overdue';
  content.prompt = `Your working directory contains \`invoices.csv\`, our accounts-payable ledger, and \`ledger.csv\`, last month's payments. Treat 1 October 2026 as today.

An invoice is overdue when its \`status\` is not \`paid\` and its \`due_date\` is before today.

How many invoices are overdue?
`;
  content.files.push(
    fileView('fixtures/docs/payment-terms.pdf', 'fixture', 98_304, 'PDF · 2 pages'),
  );
  return content;
}

/** A blank task: what Add task › Blank task creates (Flow E step 3). */
export function blankContent(): FixtureTaskContent {
  return {
    form: {
      summary: '',
      maxTurns: 20,
      runBudgetSeconds: 300,
      toolsetsNeeded: ['file', 'terminal'],
      answerPath: null,
      checks: [],
      expectedWorkspace: null,
      expectedHome: null,
      negativeControl: null,
    },
    prompt: '',
    reference: '',
    rubrics: [],
    files: [],
    texts: {},
  };
}

/** Flow E step 4: unmatched_lines with its summary and prompt, no files, no check. */
export function unmatchedLinesContent(): FixtureTaskContent {
  const content = blankContent();
  content.form.summary = 'Count statement lines with no matching ledger entry';
  content.form.answerPath = 'unmatched_lines';
  content.prompt = `Your working directory contains \`statements.csv\`, the September statement from Fjord Software, and \`ledger.csv\`, our ledger entries for the same vendor. A statement line is matched when the ledger has an entry with the same invoice number and the same amount. How many statement lines are unmatched?

${answerParagraph('{ "unmatched_lines": 0 }')}
`;
  return content;
}
