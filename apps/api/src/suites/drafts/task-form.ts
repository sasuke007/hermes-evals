/**
 * task.yaml as the task editor's Form tab sees it (plan 4.6, SA.4 to SA.7):
 * formOf reads the file into TaskForm fields, or says why the form cannot
 * show it (formLock: the Form tab is locked and the task.yaml tab is the way
 * to fix it); applyForm writes a submitted form back, changing only the
 * fields that differ from the file, through the byte-stable patcher
 * (yaml-patch.ts), so comments, key order and an unchanged field's
 * formatting survive (V5).
 *
 * Keys are strict, values are not: an unknown key or a value of a kind no
 * field can hold (a list where a number goes, two checks marked primary for
 * the Primary radio) locks the form, while a value a field can hold but the
 * rules refuse (`max_turns: 250`) is shown and reported by the readiness
 * rules, never refused.
 */
import { parseDocument } from 'yaml';
import {
  SCORER_TYPES,
  type JsonValue,
  type ScorerType,
  type TaskForm,
  type TaskFormCheck,
} from '@hermes-evals/shared';
import { parseYamlSource, positionOf } from '../loader/yaml-source.js';
import { patchYaml, renderYaml, sameValue } from './yaml-patch.js';

/** Where and why the form cannot show task.yaml: "line 9, col 7: unknown key `prmary`. …". */
export interface FormLock {
  line: number | null;
  column: number | null;
  message: string;
}

export type FormRead = { form: TaskForm; lock: null } | { form: null; lock: FormLock };

/** A form submitted while task.yaml locks the form. */
export class FormLockedError extends Error {
  constructor(readonly lock: FormLock) {
    super(`task.yaml cannot be edited in the form: ${lock.message}`);
    this.name = 'FormLockedError';
  }
}

/** The limits a blank task starts with (Flow E: 20 turns · 300 s · file, terminal). */
export const BLANK_LIMITS = { maxTurns: 20, runBudgetSeconds: 300, toolsets: ['file', 'terminal'] };

/** The form of a blank task. */
export const BLANK_FORM: TaskForm = {
  summary: '',
  maxTurns: BLANK_LIMITS.maxTurns,
  runBudgetSeconds: BLANK_LIMITS.runBudgetSeconds,
  toolsetsNeeded: [...BLANK_LIMITS.toolsets],
  answerPath: null,
  checks: [],
  expectedWorkspace: null,
  expectedHome: null,
  negativeControl: null,
};

/** The keys the form has a field for, by section. */
const KEYS = {
  root: ['summary', 'limits', 'answer', 'verification', 'self_check'],
  limits: ['max_turns', 'run_budget_seconds', 'toolsets_needed'],
  answer: ['format', 'path'],
  check: ['key', 'type', 'primary', 'params'],
  self_check: ['expected_workspace', 'expected_home', 'negative_control'],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Edit distance, for "Did you mean primary?". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

function unknownKey(key: string, known: readonly string[]): string {
  const near = known
    .map((k) => ({ k, d: distance(key.toLowerCase(), k) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)[0];
  return `unknown key \`${key}\`.${near ? ` Did you mean \`${near.k}\`?` : ''}`;
}

class Lock extends Error {
  constructor(
    readonly path: readonly PropertyKey[],
    message: string,
  ) {
    super(message);
  }
}

/** A text field: a string, or a number or boolean read as its text; null when empty. */
function text(value: unknown, path: readonly PropertyKey[], name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Lock(path, `${name} must be text.`);
}

function wholeNumber(value: unknown, path: readonly PropertyKey[], name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new Lock(path, `${name} must be a whole number.`);
}

function flag(value: unknown, path: readonly PropertyKey[], name: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  throw new Lock(path, `${name} must be true or false.`);
}

function section(
  value: unknown,
  path: readonly PropertyKey[],
  known: readonly string[],
): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    const name = path.length === 0 ? 'task.yaml' : String(path.at(-1));
    throw new Lock(path, `${name} must be a mapping of keys.`);
  }
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new Lock([...path, key], unknownKey(key, known));
  }
  return value;
}

function checkOf(value: unknown, index: number): TaskFormCheck {
  const path = ['verification', index];
  const entry = section(value, path, KEYS.check);
  if (!isRecord(value)) throw new Lock(path, 'Each check must be a mapping of keys.');
  const type = entry.type;
  if (type === undefined || type === null) throw new Lock(path, 'A check has no type.');
  if (typeof type !== 'string' || !(SCORER_TYPES as readonly string[]).includes(type)) {
    throw new Lock([...path, 'type'], `unknown check type ${JSON.stringify(type)}.`);
  }
  const params = entry.params ?? {};
  if (!isRecord(params)) throw new Lock([...path, 'params'], 'params must be a mapping of keys.');
  return {
    key: text(entry.key, [...path, 'key'], 'key') ?? '',
    type: type as ScorerType,
    primary: flag(entry.primary, [...path, 'primary'], 'primary') ?? false,
    params: params as Record<string, JsonValue>,
  };
}

function formOfValue(raw: unknown): TaskForm {
  const root = section(raw, [], KEYS.root);
  const limits = section(root.limits, ['limits'], KEYS.limits);
  const answer = section(root.answer, ['answer'], KEYS.answer);
  const selfCheck = section(root.self_check, ['self_check'], KEYS.self_check);
  const toolsets = limits.toolsets_needed ?? [];
  if (!Array.isArray(toolsets) || toolsets.some((t) => typeof t !== 'string')) {
    throw new Lock(['limits', 'toolsets_needed'], 'toolsets_needed must be a list of names.');
  }
  const list = root.verification ?? [];
  if (!Array.isArray(list))
    throw new Lock(['verification'], 'verification must be a list of checks.');
  const checks = list.map(checkOf);
  const primaries = checks.flatMap((c, i) => (c.primary ? [i] : []));
  if (primaries.length > 1) {
    throw new Lock(
      ['verification', primaries[1]!, 'primary'],
      'a second check is marked primary. Mark exactly one check as primary.',
    );
  }
  const answerPath = text(answer.path, ['answer', 'path'], 'path');
  return {
    summary: text(root.summary, ['summary'], 'summary') ?? '',
    maxTurns: wholeNumber(limits.max_turns, ['limits', 'max_turns'], 'max_turns'),
    runBudgetSeconds: wholeNumber(
      limits.run_budget_seconds,
      ['limits', 'run_budget_seconds'],
      'run_budget_seconds',
    ),
    toolsetsNeeded: toolsets as string[],
    answerPath: answerPath === '' ? null : answerPath,
    checks,
    expectedWorkspace: text(
      selfCheck.expected_workspace,
      ['self_check', 'expected_workspace'],
      'expected_workspace',
    ),
    expectedHome: text(selfCheck.expected_home, ['self_check', 'expected_home'], 'expected_home'),
    negativeControl: flag(
      selfCheck.negative_control,
      ['self_check', 'negative_control'],
      'negative_control',
    ),
  };
}

/** The form of task.yaml, or why the form cannot show it. A missing or empty file is a blank form. */
export function formOf(taskYaml: string | null): FormRead {
  if (taskYaml === null || taskYaml.trim() === '') {
    return {
      form: { ...BLANK_FORM, maxTurns: null, runBudgetSeconds: null, toolsetsNeeded: [] },
      lock: null,
    };
  }
  const parsed = parseYamlSource('task.yaml', taskYaml);
  if (!parsed.ok) {
    const { line, column, message } = parsed.error;
    return { form: null, lock: { line, column, message } };
  }
  try {
    return { form: formOfValue(parsed.value), lock: null };
  } catch (err) {
    if (!(err instanceof Lock)) throw err;
    const pos = positionOf(parsed.doc, parsed.lines, err.path);
    return {
      form: null,
      lock: { line: pos?.line ?? null, column: pos?.column ?? null, message: err.message },
    };
  }
}

/** One check as task.yaml writes it: `primary` only when set (or written before), `params` only when any. */
function entryOf(
  check: TaskFormCheck,
  before: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { key: check.key, type: check.type };
  if (check.primary || (before !== undefined && Object.hasOwn(before, 'primary'))) {
    entry.primary = check.primary;
  }
  if (
    Object.keys(check.params).length > 0 ||
    (before !== undefined && Object.hasOwn(before, 'params'))
  ) {
    entry.params = check.params;
  }
  return entry;
}

/** task.yaml's value for a form, in the canonical key order. */
function valueOfForm(form: TaskForm): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  if (form.maxTurns !== null) limits.max_turns = form.maxTurns;
  if (form.runBudgetSeconds !== null) limits.run_budget_seconds = form.runBudgetSeconds;
  limits.toolsets_needed = form.toolsetsNeeded;
  const value: Record<string, unknown> = {
    summary: form.summary,
    limits,
    answer:
      form.answerPath === null
        ? { format: 'fenced_json' }
        : { format: 'fenced_json', path: form.answerPath },
    verification: form.checks.map((c) => entryOf(c, undefined)),
  };
  const selfCheck = selfCheckOf({}, form);
  if (Object.keys(selfCheck).length > 0) value.self_check = selfCheck;
  return value;
}

function selfCheckOf(
  current: Record<string, unknown>,
  form: TaskForm,
  old?: TaskForm,
): Record<string, unknown> {
  const out = { ...current };
  const fields = [
    ['expected_workspace', form.expectedWorkspace, old?.expectedWorkspace],
    ['expected_home', form.expectedHome, old?.expectedHome],
    ['negative_control', form.negativeControl, old?.negativeControl],
  ] as const;
  for (const [key, value, before] of fields) {
    if (old !== undefined && value === before) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** task.yaml for a new task, in the canonical style. */
export function newTaskYaml(form: TaskForm): string {
  return renderYaml(valueOfForm(form));
}

/** Sets `key` of the mapping at `owner[name]` (created when absent), or deletes it for null. */
function setIn(owner: Record<string, unknown>, name: string, key: string, value: unknown): void {
  const map = isRecord(owner[name]) ? owner[name] : {};
  if (value === null) delete map[key];
  else map[key] = value;
  if (Object.keys(map).length === 0) delete owner[name];
  else owner[name] = map;
}

/**
 * `current` with the fields of `form` that differ from the file's own form
 * written into it; the rest of the file is untouched. A missing or empty
 * file is written new. Throws FormLockedError when the form cannot show the
 * file.
 */
export function applyForm(current: string | null, form: TaskForm): string {
  if (current === null || current.trim() === '') return newTaskYaml(form);
  const read = formOf(current);
  if (read.form === null) throw new FormLockedError(read.lock);
  const old = read.form;
  const doc = parseDocument(current);
  const next = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (form.summary !== old.summary) next.summary = form.summary;
  if (form.maxTurns !== old.maxTurns) setIn(next, 'limits', 'max_turns', form.maxTurns);
  if (form.runBudgetSeconds !== old.runBudgetSeconds) {
    setIn(next, 'limits', 'run_budget_seconds', form.runBudgetSeconds);
  }
  if (!sameValue(form.toolsetsNeeded, old.toolsetsNeeded)) {
    setIn(next, 'limits', 'toolsets_needed', form.toolsetsNeeded);
  }
  if (form.answerPath !== old.answerPath) {
    if (!isRecord(next.answer)) next.answer = { format: 'fenced_json' };
    setIn(next, 'answer', 'path', form.answerPath);
  }
  if (!sameValue(form.checks, old.checks)) {
    const before = (Array.isArray(next.verification) ? next.verification : []) as unknown[];
    const byKey = new Map(before.filter(isRecord).map((e) => [String(e.key), e] as const));
    next.verification = form.checks.map((c, i) => {
      const at = before[i];
      return entryOf(c, byKey.get(c.key) ?? (isRecord(at) ? at : undefined));
    });
  }
  const selfCheckChanged =
    form.expectedWorkspace !== old.expectedWorkspace ||
    form.expectedHome !== old.expectedHome ||
    form.negativeControl !== old.negativeControl;
  if (selfCheckChanged) {
    const selfCheck = selfCheckOf(isRecord(next.self_check) ? next.self_check : {}, form, old);
    if (Object.keys(selfCheck).length > 0) next.self_check = selfCheck;
    else delete next.self_check;
  }
  return patchYaml(current, next);
}
