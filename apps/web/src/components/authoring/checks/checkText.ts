/**
 * The words of the Checks section (SA.7, SA.7a): each type's name and picker card, the
 * default key of a new check, a check in one line ("json_match on `overdue_by_vendor`, pass
 * at 0.8"), its rule line once expanded ("Scores the share of keys that match. Passes at
 * 0.80 or above."), the settings a change of type drops, and the reason a type is
 * suggested. Copy with `code` in backticks, as CodeText draws it.
 */
import { suggestedCheckType, type JsonValue, type ScorerType } from '@hermes-evals/shared';
import type { TaskFormCheck } from '@/api/types/authoring';

export const CHECK_TYPE_NAMES: Record<ScorerType, string> = {
  numeric_tolerance: 'Number within tolerance',
  json_match: 'JSON match',
  exact_match: 'Exact text',
  text_match: 'Text match',
  file_check: 'File check',
  trajectory_match: 'Tool use',
  llm_judge: 'Rubric judge',
  verifier_script: 'Verifier script',
};

export const ANSWER_CHECK_TYPES: readonly ScorerType[] = [
  'numeric_tolerance',
  'json_match',
  'exact_match',
  'text_match',
];
export const isAnswerCheck = (type: ScorerType): boolean => ANSWER_CHECK_TYPES.includes(type);

export interface PickerCard {
  type: ScorerType;
  what: string;
  use: string;
  tags: string[];
}

/** The picker's groups and cards, in the board's order and words (CheckPicker). */
export const PICKER_GROUPS: Array<{ id: string; label: string; cards: PickerCard[] }> = [
  {
    id: 'answer',
    label: 'Answer checks',
    cards: [
      {
        type: 'numeric_tolerance',
        what: 'A number, equal or within an absolute or relative tolerance.',
        use: 'A total, a count, a rate: `total_due` = 99,760.52 ± 0.01',
        tags: [],
      },
      {
        type: 'json_match',
        what: 'An object or list, key by key or item by item, optionally ignoring order or some keys.',
        use: 'Several values at once: counts per vendor; pairs of duplicate invoices in any order',
        tags: ['partial credit'],
      },
      {
        type: 'exact_match',
        what: 'A string, equal after optional trimming and case folding.',
        use: 'An id, a name, a yes/no: `INV-1042`',
        tags: [],
      },
      {
        type: 'text_match',
        what: 'A string that must contain phrases or match a pattern.',
        use: 'A sentence that must mention something: the late-fee rule mentions "1.5%" and "30 days"',
        tags: ['partial credit'],
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace checks',
    cards: [
      {
        type: 'file_check',
        what: 'A file the agent leaves: format, columns, rows, schema, contents.',
        use: '`summary.csv` with columns `vendor_name`, `total_due` and 9 rows',
        tags: ['needs an expected workspace'],
      },
    ],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    cards: [
      {
        type: 'trajectory_match',
        what: 'Which tools the agent called, with which arguments, how often.',
        use: 'It read `invoices.csv` at least once',
        tags: ['checked when runs are scored'],
      },
    ],
  },
  {
    id: 'judge',
    label: 'Judge',
    cards: [
      {
        type: 'llm_judge',
        what: 'A model grades the reply against your rubric, 0–1.',
        use: 'Open-ended answers: an explanation of why two invoices are duplicates',
        tags: ['partial credit', 'checked when runs are scored'],
      },
    ],
  },
  {
    id: 'script',
    label: 'Script',
    cards: [
      {
        type: 'verifier_script',
        what: 'Anything else, in Python, returning 0–1.',
        use: 'Rules too complex for the other checks: late fees under the policy terms',
        tags: ['partial credit', 'edited on disk'],
      },
    ],
  },
];

const KEY_BY_TYPE: Record<ScorerType, string> = {
  numeric_tolerance: 'answer',
  json_match: 'answer',
  exact_match: 'answer',
  text_match: 'answer',
  file_check: 'file',
  trajectory_match: 'tool_use',
  llm_judge: 'judge',
  verifier_script: 'script',
};

/** `answer` for the first answer check, then `file`, `tool_use`, `judge`, `script`, with `_2` for duplicates. */
export function defaultCheckKey(type: ScorerType, taken: readonly string[]): string {
  const base = KEY_BY_TYPE[type];
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * The params a new card starts with. A Verifier script names the script the picker asked
 * for (Phase 5b question 19), never simply the first file under `verify/`.
 */
export function defaultParams(
  type: ScorerType,
  script: string | null = null,
): Record<string, JsonValue> {
  if (type === 'numeric_tolerance') return { abs: 0 };
  if (type === 'trajectory_match') return { min_calls: 1 };
  if (type === 'llm_judge') return { rubric: 'rubric.md' };
  if (type === 'verifier_script') return script ? { script } : {};
  return {};
}

const str = (v: JsonValue | undefined): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const numOr = (v: JsonValue | undefined, fallback: number): number =>
  typeof v === 'number' ? v : fallback;
const list = (v: JsonValue | undefined): string[] => (Array.isArray(v) ? v.map(String) : []);
const flowArgs = (v: JsonValue | undefined): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.entries(v)
        .map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`)
        .join(', ')}}`
    : '';
const f2 = (n: number): string => n.toFixed(2);
const share = (n: number): string => (n < 1 ? String(n) : '1.0');

/** The path an answer check reads: its own, else the answer path it inherits as primary. */
export function effectivePath(check: TaskFormCheck, answerPath: string | null): string | null {
  return str(check.params.path) ?? (check.primary ? answerPath : null);
}

/** A check in one line, after its type in mono: "on `overdue_count`, abs 0". */
export function checkSentence(check: TaskFormCheck, answerPath: string | null): string {
  const p = check.params;
  const path = effectivePath(check, answerPath);
  const on = path ? `on \`${path}\`` : 'on the whole answer';
  switch (check.type) {
    case 'numeric_tolerance': {
      const tol =
        typeof p.abs === 'number'
          ? `, abs ${p.abs}`
          : typeof p.rel === 'number'
            ? `, rel ${p.rel}`
            : ', equal';
      return `${on}${tol}`;
    }
    case 'json_match':
      return `${on}${p.unordered === true ? ', unordered' : ''}, pass at ${share(numOr(p.pass_at, 1))}`;
    case 'exact_match':
      return `${on}, ${p.trim === false ? 'untrimmed' : 'trimmed'}, ${p.case_sensitive === false ? 'case-insensitive' : 'case-sensitive'}`;
    case 'text_match': {
      const phrases = list(p.contains);
      if (phrases.length === 0 && !str(p.pattern)) return `${on}, no phrases yet`;
      const parts = phrases.map((x) => `"${x}"`);
      if (str(p.pattern)) parts.push(`/${String(p.pattern)}/`);
      return `${on}, contains ${parts.join(', ')}`;
    }
    case 'file_check': {
      const file = str(p.path) ? `on \`${String(p.path)}\`` : 'on no file yet';
      const format = str(p.format);
      const bits: string[] = [];
      if (format) bits.push(format);
      if (p.json_schema !== undefined)
        bits.push(format === 'json' ? 'a JSON Schema' : 'with a JSON Schema');
      if (list(p.columns).length) bits.push(`${list(p.columns).length} columns`);
      if (typeof p.row_count === 'number') bits.push(`${p.row_count} rows`);
      return bits.length ? `${file}, ${bits.join(', ')}` : file;
    }
    case 'trajectory_match': {
      const tool = str(p.tool) ? `calls \`${String(p.tool)}\`` : 'calls no tool yet';
      const args = flowArgs(p.args);
      const min = numOr(p.min_calls, 1);
      const count =
        typeof p.max_calls === 'number'
          ? `, min ${min}, max ${p.max_calls}`
          : min === 1
            ? ', at least once'
            : `, at least ${min} times`;
      return `${tool}${args ? ` with ${args}` : ''}${count}`;
    }
    case 'llm_judge':
      return `with \`${str(p.rubric) ?? 'rubric.md'}\`, pass at ${numOr(p.pass_at, 0.7)}`;
    case 'verifier_script':
      return `runs \`verify/${str(p.script) ?? '…'}\`, pass at ${numOr(p.pass_at, 1)}, timeout ${numOr(p.timeout_s, 30)} s`;
  }
}

/**
 * The plain rule line of an expanded card, or null when the settings have a problem (the
 * card then says "Fix … to see when this check passes."). `reference` is the value the
 * check reads in the reference, when it has one.
 */
export function ruleLine(check: TaskFormCheck, reference: JsonValue | undefined): string | null {
  const p = check.params;
  const ref = reference === undefined ? 'the reference' : `\`${JSON.stringify(reference)}\``;
  switch (check.type) {
    case 'numeric_tolerance': {
      const tol =
        typeof p.abs === 'number'
          ? `\`${p.abs}\``
          : typeof p.rel === 'number'
            ? `\`${p.rel}\` × |${ref}|`
            : null;
      const lead = tol ? `Passes when |answer − ${ref}| ≤ ${tol}. ` : '';
      return `${lead}With neither tolerance: passes only when the numbers are equal. Scores 1 or 0.`;
    }
    case 'json_match': {
      const at = numOr(p.pass_at, 1);
      const items = Array.isArray(reference) && p.unordered === true;
      if (at >= 1)
        return items
          ? 'Passes only when every item matches, in any order.'
          : 'Passes only when every key matches.';
      const keys =
        reference && typeof reference === 'object' && !Array.isArray(reference)
          ? Object.keys(reference).length
          : 0;
      const example =
        keys > 0 ? `: here, ${Math.ceil(at * keys - 1e-9)} of the ${keys} keys.` : '.';
      return `Scores the share of keys that match. Passes at ${f2(at)} or above${example}`;
    }
    case 'exact_match': {
      const trim = p.trim === false ? '' : ', after trimming';
      const cased = p.case_sensitive === false ? ', ignoring case' : '';
      return `Passes when the text equals the reference exactly${trim}${cased}. Scores 1 or 0.`;
    }
    case 'text_match': {
      const phrases = list(p.contains).map((x) => `"${x}"`);
      if (phrases.length === 0 && !str(p.pattern))
        return 'Add a phrase or a pattern to see when this check passes.';
      const at = numOr(p.pass_at, 1);
      if (at < 1) return `Scores the share of phrases found. Passes at ${f2(at)} or above.`;
      const all = [...phrases, ...(str(p.pattern) ? [`a match for \`${String(p.pattern)}\``] : [])];
      return `Passes when the text contains ${all.join(' and ')}.`;
    }
    case 'file_check': {
      const file = str(p.path) ? `\`${String(p.path)}\`` : 'the file';
      const parts = [p.must_exist === false ? `${file} is absent, or` : `${file} exists`];
      const format = str(p.format);
      if (format) parts.push(`is ${format === 'text' ? 'text' : format.toUpperCase()}`);
      const columns = list(p.columns).map((c) => `\`${c}\``);
      const rows = typeof p.row_count === 'number' ? `${p.row_count} data rows` : null;
      if (columns.length && rows) parts.push(`has columns ${columns.join(', ')} and ${rows}`);
      else if (columns.length) parts.push(`has columns ${columns.join(', ')}`);
      else if (rows) parts.push(`has ${rows}`);
      if (p.json_schema !== undefined) parts.push('matches the JSON Schema');
      for (const c of list(p.contains)) parts.push(`contains "${c}"`);
      return `Passes when ${parts.join(', ')}.`;
    }
    case 'trajectory_match': {
      if (str(p.mode))
        return `Passes when the whole trajectory matches in ${String(p.mode)} mode. Scores 1 or 0.`;
      const tool = str(p.tool) ? `\`${String(p.tool)}\`` : 'the tool';
      const args = flowArgs(p.args);
      const min = numOr(p.min_calls, 1);
      const times =
        typeof p.max_calls === 'number'
          ? `between ${min} and ${p.max_calls} times`
          : min === 1
            ? 'at least once'
            : `at least ${min} times`;
      return `Passes when the run calls ${tool}${args ? ` with \`${args}\`` : ''} ${times}. Scores 1 or 0.`;
    }
    case 'llm_judge':
      return `A model scores the final reply against this rubric, 0 to 1. Passes at \`${numOr(p.pass_at, 0.7)}\` or above.`;
    case 'verifier_script':
      return null;
  }
}

const PARAM_WORDS: Record<string, string> = {
  pass_at: 'pass threshold',
  exclude_keys: 'keys to ignore',
  unordered: 'list order',
  inner_unordered: 'nested list order',
  abs: 'absolute tolerance',
  rel: 'relative tolerance',
  trim: 'trimming',
  case_sensitive: 'case',
  contains: 'phrases',
  pattern: 'pattern',
};

/** What a change of answer type keeps (key, primary, path) and the settings it drops. */
export function changeType(
  check: TaskFormCheck,
  to: ScorerType,
  script: string | null = null,
): { check: TaskFormCheck; dropped: string[] } {
  const keepPath = isAnswerCheck(check.type) && isAnswerCheck(to) && str(check.params.path);
  const params: Record<string, JsonValue> = keepPath ? { path: check.params.path! } : {};
  const fresh = defaultParams(to, script);
  const dropped = Object.keys(check.params)
    .filter((k) => k !== 'path' && !(k in fresh))
    .map((k) =>
      k === 'pass_at' && check.type === 'json_match' ? 'share of keys' : (PARAM_WORDS[k] ?? k),
    );
  return { check: { ...check, type: to, params: { ...fresh, ...params } }, dropped };
}

const KIND_WORDS = (v: JsonValue): string =>
  typeof v === 'number'
    ? 'a number'
    : Array.isArray(v)
      ? 'a list'
      : v !== null && typeof v === 'object'
        ? 'an object'
        : typeof v === 'string'
          ? 'a string'
          : 'a value';

/** The suggested type and why: "the reference at `overdue_by_vendor` is an object". */
export function suggestion(
  value: JsonValue | undefined,
  path: string | null,
): { type: ScorerType; reason: string } | null {
  const type = suggestedCheckType(value);
  if (!type || value === undefined) return null;
  const where = path ? `the reference at \`${path}\`` : 'the reference';
  return { type, reason: `${where} is ${KIND_WORDS(value)}` };
}

/** The value at `totals.vat` or `bands[2].net`; the whole value for no path. */
export function valueAtPath(
  value: JsonValue | undefined,
  path: string | null,
): JsonValue | undefined {
  if (!path) return value;
  let node = value;
  for (const part of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    const index = /^\[(\d+)\]$/.exec(part);
    if (index) node = Array.isArray(node) ? node[Number(index[1])] : undefined;
    else
      node =
        Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, part)
          ? undefined
          : node[part];
  }
  return node;
}
