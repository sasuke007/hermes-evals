/**
 * The one-line sentence Task detail shows for each verification entry
 * (VerificationSentence in the web), e.g. "json_match on duplicates,
 * unordered, pass at 1.0". Built from the entry's params after the scorer's
 * own schema applies its defaults, so the sentence states what scoring will
 * actually do, not only what the author wrote.
 */
import {
  SCORER_PARAM_SCHEMAS,
  type ExactMatchParams,
  type FileCheckParams,
  type JsonMatchParams,
  type LlmJudgeParams,
  type NumericToleranceParams,
  type ScorerType,
  type TextMatchParams,
  type TrajectoryMatchParams,
  type VerificationEntry,
  type VerifierScriptParams,
} from '@hermes-evals/shared';
import { formatNumber, formatThreshold, round } from './format.js';

/** The sentence of one entry. `answerPath` is task.yaml's `answer.path`, which the primary key scores when its params name no path. */
export function verificationSentence(entry: VerificationEntry, answerPath?: string): string {
  const parsed = SCORER_PARAM_SCHEMAS[entry.type].safeParse(entry.params);
  if (!parsed.success) return `${entry.type} · params are not valid`;
  const target = (path: string | undefined): string =>
    path ?? (entry.primary && answerPath ? answerPath : 'the whole answer');
  return SENTENCES[entry.type](parsed.data as never, target);
}

type Target = (path: string | undefined) => string;
type SentenceOf = { [T in ScorerType]: (params: ParamsOf[T], target: Target) => string };
interface ParamsOf {
  numeric_tolerance: NumericToleranceParams;
  json_match: JsonMatchParams;
  exact_match: ExactMatchParams;
  file_check: FileCheckParams;
  trajectory_match: TrajectoryMatchParams;
  verifier_script: VerifierScriptParams;
  llm_judge: LlmJudgeParams;
  text_match: TextMatchParams;
}

const SENTENCES: SentenceOf = {
  numeric_tolerance: (p, target) => `numeric_tolerance on ${target(p.path)}, ${tolerance(p)}`,

  json_match: (p, target) => {
    const parts = [`json_match on ${target(p.path)}`];
    if (p.unordered) parts.push('unordered');
    else if (p.inner_unordered) parts.push('inner lists unordered');
    if (p.exclude_keys?.length) parts.push(`ignoring ${p.exclude_keys.join(', ')}`);
    parts.push(`pass at ${formatThreshold(p.pass_at)}`);
    return parts.join(', ');
  },

  exact_match: (p, target) =>
    `exact_match on ${target(p.path)}, ${p.trim ? 'whitespace trimmed' : 'whitespace kept'}, ` +
    (p.case_sensitive ? 'case-sensitive' : 'case-insensitive'),

  file_check: (p) => {
    const where = p.root === 'home' ? ' in the home' : '';
    let text = `file_check: ${p.path}${where} ${p.must_exist ? 'exists' : '(optional)'}`;
    if (p.columns?.length) text += ` with columns ${p.columns.join(', ')}`;
    else if (p.format === 'csv') text += ' as CSV';
    if (p.format === 'json') text += p.json_schema ? ' as JSON matching its schema' : ' as JSON';
    if (p.format === 'text') text += ' as text';
    if (p.row_count !== undefined) text += `; ${count(p.row_count, 'row')}`;
    if (p.contains?.length)
      text += `; contains ${p.contains.map((s) => JSON.stringify(s)).join(', ')}`;
    return text;
  },

  trajectory_match: (p) => {
    const call = `${p.tool}${argsPhrase(p.args)}`;
    if (p.mode) return `trajectory_match: calls to ${call} match the trajectory (${p.mode} mode)`;
    if (p.max_calls === 0) return `trajectory_match: never calls ${call}`;
    return `trajectory_match: calls ${call} ${callCount(p.min_calls, p.max_calls)}`;
  },

  verifier_script: (p) =>
    `verifier_script ${p.script} returns score ≥ ${formatThreshold(p.pass_at)}, timeout ${p.timeout_s} s`,

  llm_judge: (p) =>
    `llm_judge with rubric ${p.rubric}, pass at score ≥ ${formatThreshold(p.pass_at)}` +
    (p.model ? `, judged by ${p.model}` : ''),

  text_match: (p, target) => {
    const parts = [`text_match on ${target(p.path)}`];
    if (p.contains?.length)
      parts.push(`contains ${p.contains.map((s) => JSON.stringify(s)).join(', ')}`);
    if (p.pattern !== undefined) parts.push(`matches /${p.pattern}/`);
    if (p.case_sensitive) parts.push('case-sensitive');
    if (p.pass_at < 1) parts.push(`pass at ${formatThreshold(p.pass_at)}`);
    return parts.join(', ');
  },
};

function tolerance(p: NumericToleranceParams): string {
  const abs = p.abs === undefined ? null : `±${formatNumber(p.abs)}`;
  const rel = p.rel === undefined ? null : `±${formatNumber(round(p.rel * 100))}%`;
  if (abs && rel) return `within ${abs} or ${rel} of the reference`;
  if (abs ?? rel) return `within ${abs ?? rel} of the reference`;
  return 'equal to the reference';
}

/** ` on invoices.csv` for the common single-path case, otherwise the arguments spelled out. */
function argsPhrase(args: TrajectoryMatchParams['args']): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return '';
  const [first] = entries;
  if (entries.length === 1 && first && first[0] === 'path' && typeof first[1] === 'string') {
    return ` on ${first[1]}`;
  }
  return ` with ${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}`;
}

function callCount(min: number, max: number | undefined): string {
  if (max === undefined) return min === 0 ? 'any number of times' : `at least ${times(min)}`;
  if (min === max) return `exactly ${times(min)}`;
  if (min === 0) return `at most ${times(max)}`;
  return `between ${min} and ${max} times`;
}

const times = (n: number): string => (n === 1 ? 'once' : `${n} times`);

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
