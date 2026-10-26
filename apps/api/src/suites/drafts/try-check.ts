/**
 * Try it (plan 4.6, SA.7): one answer check of a draft task run in the API
 * on the reference, or on a reply the author pastes. The reply goes through
 * the same extraction as a run's final text (scoring/extraction.ts) and the
 * check through its own scorer, so what Try it says is what scoring will
 * say. Nothing is stored and no model is called.
 */
import type {
  ExtractedAnswer,
  JsonValue,
  TryCheckRequest,
  TryCheckResult,
} from '@hermes-evals/shared';
import { resolveAnswerPath } from '../../scoring/answer-path.js';
import { scoreAnswer, scoreReferenceAsAnswer, type AnswerKey } from '../../scoring/answer.js';
import { extractAnswer, extractionComment } from '../../scoring/extraction.js';
import { isAnswerScorerType, parseVerificationEntry } from '../../scoring/registry.js';
import type { ScorerResult } from '../../scoring/result.js';
import { checkTaskYaml } from '../loader/task-yaml.js';
import { parseYamlSource } from '../loader/yaml-source.js';

/** Why Try it cannot run: the HTTP status and the message. */
export interface TryRefusal {
  status: 404 | 422;
  message: string;
}

const SCORED_LATER = {
  file_check: 'it runs in the worker against the expected workspace: use Run self-check',
  verifier_script: 'it runs in the worker: use Run self-check',
  trajectory_match: 'it is checked when runs are scored',
  llm_judge: 'it is checked when runs are scored',
} as const;

/** A value as compact JSON. */
const compact = (value: JsonValue): string => JSON.stringify(value);

/** The check `request.key` of the draft task on the reference or on `request.reply`. */
export function tryCheck(
  task: { taskYaml: string | null; reference: string | null },
  request: TryCheckRequest,
): TryCheckResult | TryRefusal {
  const parsed = task.taskYaml === null ? null : parseYamlSource('task.yaml', task.taskYaml);
  if (parsed === null || !parsed.ok) {
    return { status: 422, message: 'task.yaml has an error; fix it before trying a check' };
  }
  const entry = checkTaskYaml(parsed.value, parsed.doc, parsed.lines).verification.find(
    (e) => e.key === request.key,
  );
  if (!entry) return { status: 404, message: `check ${request.key} not found` };
  if (!isAnswerScorerType(entry.type)) {
    return {
      status: 422,
      message: `Try it runs answer checks; ${entry.key} is ${entry.type}, and ${SCORED_LATER[entry.type as keyof typeof SCORED_LATER]}`,
    };
  }
  let reference: JsonValue;
  try {
    reference = JSON.parse(task.reference ?? '') as JsonValue;
  } catch {
    return { status: 422, message: 'Add a valid reference answer before trying a check' };
  }
  const path = typeof entry.params.path === 'string' ? entry.params.path : null;
  const base = { key: entry.key, type: entry.type, path };
  const key = parseVerificationEntry(entry);
  if (!key.success) {
    return {
      ...base,
      against: request.reply === null ? 'reference' : 'reply',
      extraction: null,
      value: null,
      status: 'error',
      score: null,
      comment: "The check's settings are not valid; fix them to try it.",
      passAt: null,
      evidence: null,
    };
  }
  const answerKey = key.data as AnswerKey;
  const passAt =
    answerKey.type === 'json_match' || answerKey.type === 'text_match'
      ? answerKey.params.pass_at
      : null;

  let answer: ExtractedAnswer;
  let result: ScorerResult;
  let extraction: TryCheckResult['extraction'] = null;
  if (request.reply === null) {
    answer = { status: 'found', block_count: 1, start: 0, end: 0, value: reference };
    result = scoreReferenceAsAnswer(answerKey, reference);
  } else {
    answer = extractAnswer(request.reply);
    result = scoreAnswer(answerKey, answer, reference);
    extraction = {
      status: answer.status,
      block: answer.status === 'missing' ? null : request.reply.slice(answer.start, answer.end),
      error: answer.status === 'invalid' ? answer.error : null,
    };
  }
  const found = answer.status === 'found' ? valueAt(answer.value, path) : undefined;
  const comment =
    answer.status === 'missing'
      ? 'No fenced json block found in the reply'
      : answer.status === 'invalid'
        ? `${extractionComment(answer).replace(/^./, (c) => c.toUpperCase())}`
        : result.comment;
  return {
    ...base,
    against: request.reply === null ? 'reference' : 'reply',
    extraction,
    value: found === undefined ? null : compact(found),
    status: result.status,
    score: result.score,
    comment,
    passAt,
    ...(result.expected !== undefined ? { expected: result.expected } : {}),
    ...(result.observed !== undefined ? { observed: result.observed } : {}),
    evidence: result.evidence ?? null,
  };
}

/** The value at `path`, or undefined when it is missing or the path is malformed. */
function valueAt(value: JsonValue, path: string | null): JsonValue | undefined {
  try {
    const found = resolveAnswerPath(value, path ?? undefined);
    return found.found ? found.value : undefined;
  } catch {
    return undefined;
  }
}
