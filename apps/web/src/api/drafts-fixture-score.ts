/**
 * Try it and the worker self-check in fixtures mode (SA.7, SA.8): the last fenced json
 * block of a reply, the value at the check's path, and a small stand-in for each answer
 * scorer, with the comment lines the boards show ("|17 − 17| = 0 ≤ 0", "4 of 5 keys
 * match", "Found 1 of 2: `1.5%` ✓ `30 days` ✗"). The API runs the real extraction and
 * scorers (plan 9.1, 9.3); live mode never uses this file.
 */
import type { JsonValue, ScoreEvidence } from '@hermes-evals/shared';
import type {
  DraftSelfCheckResult,
  DraftSelfCheckView,
  TaskForm,
  TaskFormCheck,
  TryCheckResult,
} from './types/authoring';
import { sha } from '@/fixtures/suites';

export const ANSWER_TYPES: readonly string[] = [
  'numeric_tolerance',
  'json_match',
  'exact_match',
  'text_match',
];

export function parseReference(
  text: string | null,
): { ok: true; value: JsonValue } | { ok: false } {
  if (text === null || text.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

/** The path an answer check reads: its own, else the answer path when it is primary. */
export function checkPath(form: TaskForm, index: number): string | null {
  const check = form.checks[index]!;
  const own = check.params.path;
  if (typeof own === 'string' && own !== '') return own;
  return check.primary ? form.answerPath : null;
}

/** The value at `totals.vat` or `bands[2].net` in a JSON value; the whole value for no path. */
export function answerValueAt(
  value: JsonValue | undefined,
  path: string | null,
): JsonValue | undefined {
  if (path === null || path === '') return value;
  let node = value;
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) return undefined;
    const steps: Array<string | number> = match[1] ? [match[1]] : [];
    for (const i of match[2]!.matchAll(/\[(\d+)\]/g)) steps.push(Number(i[1]));
    for (const step of steps) {
      if (node === null || node === undefined || typeof node !== 'object') return undefined;
      if (typeof step === 'number') {
        if (!Array.isArray(node)) return undefined;
        node = node[step];
      } else {
        if (Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, step))
          return undefined;
        node = node[step];
      }
    }
  }
  return node;
}

/** The last ```json block of a reply (plan 9.1). */
export function extractAnswerBlock(reply: string): NonNullable<TryCheckResult['extraction']> {
  const blocks = [...reply.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  const last = blocks[blocks.length - 1];
  if (!last) return { status: 'missing', block: null, error: null };
  const block = last[1]!.trim();
  try {
    JSON.parse(block);
    return { status: 'found', block, error: null };
  } catch (err) {
    return { status: 'invalid', block, error: err instanceof Error ? err.message : String(err) };
  }
}

const equal = (a: JsonValue | undefined, b: JsonValue | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
const tidy = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));

type Scored = Pick<TryCheckResult, 'status' | 'score' | 'comment' | 'passAt' | 'evidence'>;

/** One answer scorer on the extracted value. */
export function scoreAnswer(
  check: TaskFormCheck,
  expected: JsonValue | undefined,
  observed: JsonValue | undefined,
  extraction: TryCheckResult['extraction'],
): Scored {
  const fractional = check.type === 'json_match' || check.type === 'text_match';
  const passAt = fractional ? num(check.params.pass_at, 1) : null;
  if (extraction && extraction.status !== 'found') {
    const comment =
      extraction.status === 'missing'
        ? 'No fenced json block found in the reply'
        : `The fenced json block is not valid JSON: ${extraction.error ?? ''}`;
    return { status: 'ungradable', score: null, comment, passAt, evidence: null };
  }
  if (observed === undefined)
    return {
      status: 'ungradable',
      score: null,
      comment: 'The answer has no value at the path',
      passAt,
      evidence: null,
    };
  let score = 0;
  let comment = '';
  let evidence: ScoreEvidence | null = null;
  if (check.type === 'numeric_tolerance') {
    const abs = num(check.params.abs, 0);
    const rel = num(check.params.rel, 0) * Math.abs(Number(expected));
    const tolerance = Math.max(abs, rel);
    const diff = Math.abs(Number(observed) - Number(expected));
    score = diff <= tolerance + 1e-9 ? 1 : 0;
    comment = `|${tidy(Number(observed))} − ${tidy(Number(expected))}| = ${tidy(diff)} ${score ? '≤' : '>'} ${tidy(tolerance)}`;
  } else if (check.type === 'exact_match') {
    const norm = (v: JsonValue | undefined) => {
      let s = typeof v === 'string' ? v : JSON.stringify(v);
      if (check.params.trim !== false) s = s.trim();
      return check.params.case_sensitive === false ? s.toLowerCase() : s;
    };
    score = norm(observed) === norm(expected) ? 1 : 0;
    const show = (v: JsonValue | undefined) => (typeof v === 'string' ? v : JSON.stringify(v));
    comment = `\`${show(expected)}\` ${score ? '=' : '≠'} \`${show(observed)}\``;
  } else if (check.type === 'json_match') {
    const match = jsonMatch(expected, observed, check.params.unordered === true);
    score = match.total === 0 ? 1 : match.matched / match.total;
    comment = `${match.matched} of ${match.total} ${match.unit} match`;
    evidence = { json_match: match };
  } else {
    const text = typeof observed === 'string' ? observed : JSON.stringify(observed);
    const cased = check.params.case_sensitive === true;
    const phrases = Array.isArray(check.params.contains) ? check.params.contains.map(String) : [];
    const items = phrases.map((label) => ({
      kind: 'phrase' as const,
      label,
      found: cased ? text.includes(label) : text.toLowerCase().includes(label.toLowerCase()),
    }));
    if (typeof check.params.pattern === 'string') {
      let found = false;
      try {
        found = new RegExp(check.params.pattern, cased ? '' : 'i').test(text);
      } catch {
        found = false;
      }
      items.push({ kind: 'phrase', label: check.params.pattern, found });
    }
    const hits = items.filter((i) => i.found).length;
    score = items.length === 0 ? 0 : hits / items.length;
    const list = items.map((i) => `\`${i.label}\` ${i.found ? '✓' : '✗'}`).join(' ');
    comment = `Found ${hits} of ${items.length}: ${list}`;
    evidence = { text: { items, truncated: false } };
  }
  const passed = score >= (passAt ?? 1) - 1e-9;
  return { status: passed ? 'passed' : 'failed', score, comment, passAt, evidence };
}

function jsonMatch(
  expected: JsonValue | undefined,
  observed: JsonValue | undefined,
  unordered: boolean,
) {
  if (Array.isArray(expected) && unordered) {
    const pool = Array.isArray(observed) ? [...observed] : [];
    let matched = 0;
    const mismatches: string[] = [];
    expected.forEach((item, i) => {
      const at = pool.findIndex((o) => equal(o, item));
      if (at >= 0) {
        matched++;
        pool.splice(at, 1);
      } else mismatches.push(`[${i}]`);
    });
    return { unit: 'items' as const, matched, total: expected.length, mismatches };
  }
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const got =
      observed !== null && typeof observed === 'object' && !Array.isArray(observed) ? observed : {};
    const keys = Object.keys(expected);
    const mismatches = keys.filter((k) => !equal(expected[k], got[k]));
    return {
      unit: 'keys' as const,
      matched: keys.length - mismatches.length,
      total: keys.length,
      mismatches,
    };
  }
  const same = equal(expected, observed);
  return { unit: 'value' as const, matched: same ? 1 : 0, total: 1, mismatches: same ? [] : [''] };
}

/** Try it on a fixture task: extraction, then the check's scorer (SA.7). */
export function fixtureTry(
  form: TaskForm,
  reference: string | null,
  key: string,
  reply: string | null,
): TryCheckResult | null {
  const index = form.checks.findIndex((c) => c.key === key);
  const check = form.checks[index];
  if (!check || !ANSWER_TYPES.includes(check.type)) return null;
  const path = checkPath(form, index);
  const ref = parseReference(reference);
  const expected = ref.ok ? answerValueAt(ref.value, path) : undefined;
  let extraction: TryCheckResult['extraction'] = null;
  let answer: JsonValue | undefined = ref.ok ? ref.value : undefined;
  if (reply !== null) {
    extraction = extractAnswerBlock(reply);
    answer =
      extraction.status === 'found' ? (JSON.parse(extraction.block!) as JsonValue) : undefined;
  }
  const observed = answer === undefined ? undefined : answerValueAt(answer, path);
  return {
    key,
    type: check.type,
    against: reply === null ? 'reference' : 'reply',
    extraction,
    path,
    value: observed === undefined ? null : JSON.stringify(observed),
    ...scoreAnswer(check, expected, observed, extraction),
    ...(expected === undefined ? {} : { expected }),
    ...(observed === undefined ? {} : { observed }),
  };
}

const TRANSCRIPT = `$ python3 verify/check_summary.py --answer answer.json --workspace /tmp/selfcheck-3/expected
Traceback (most recent call last):
  File "verify/check_summary.py", line 12, in <module>
    if abs(float(r["total_due"]) - ref["totals"][r["vendor_name"]]) <= 0.01)
KeyError: 'totals'
exit status 1 · no result line · 0.2 s`;

export type SelfCheckOutcome = 'passed' | 'failed' | 'failed-negative' | 'error';

/** The worker's self-check of a fixture task, in one of the designed outcomes (SA.8). */
export function fixtureSelfCheck(
  form: TaskForm,
  outcome: SelfCheckOutcome,
  now: string,
  contentKey: string,
): DraftSelfCheckView {
  const results: DraftSelfCheckResult[] = [];
  for (const check of form.checks) {
    const base = { key: check.key, type: check.type, transcript: null };
    if (ANSWER_TYPES.includes(check.type)) {
      results.push({
        ...base,
        mode: 'answer',
        expect: 'pass',
        status: 'passed',
        score: 1,
        comment: 'passes on the reference',
      });
    } else if (check.type === 'file_check') {
      const failed = outcome === 'failed';
      const leaky = outcome === 'failed-negative';
      results.push({
        ...base,
        mode: 'workspace',
        expect: 'pass',
        status: failed ? 'failed' : 'passed',
        score: failed ? 0 : 1,
        comment: failed
          ? "the expected workspace's `summary.csv` has 8 data rows; the check needs 9."
          : '`/workspace/summary.csv` exists, is CSV, has both columns and 9 data rows',
      });
      results.push({
        ...base,
        mode: 'workspace',
        expect: 'fail',
        status: leaky ? 'passed' : 'failed',
        score: leaky ? 1 : 0,
        comment: leaky
          ? '`summary.csv` exists in the untouched workspace'
          : "`summary.csv` doesn't exist",
      });
    } else if (check.type === 'verifier_script') {
      const error = outcome === 'error';
      results.push({
        ...base,
        mode: 'workspace',
        expect: 'pass',
        status: error ? 'error' : 'passed',
        score: error ? null : 1,
        comment: error
          ? 'the verifier script exited with status 1, so the check is error.'
          : '9 of 9 vendor totals match',
        transcript: error ? TRANSCRIPT : null,
      });
    } else {
      results.push({
        ...base,
        mode: 'none',
        expect: 'pass',
        status: 'skipped',
        score: null,
        comment: 'Checked when runs are scored.',
      });
    }
  }
  const status = outcome === 'passed' ? 'passed' : outcome === 'error' ? 'error' : 'failed';
  return {
    status,
    ranAt: now,
    durationMs: 400,
    contentHash: sha(contentKey),
    current: true,
    results,
  };
}
