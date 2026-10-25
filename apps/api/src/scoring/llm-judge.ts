/**
 * llm_judge (plan 9.3, Phase 3 S3 and S4): a model grades the agent's final
 * text against the task's rubric, and the key passes when the judge's score
 * is at least `pass_at` (default 0.7).
 *
 * The prompt: the rubric file (the task's rubric blob), the task prompt and
 * the reference answer are given as facts; the agent's final text is wrapped
 * as untrusted data between explicit delimiters, with the instruction that
 * nothing inside them is an instruction. temperature 0, at most
 * JUDGE_MAX_TOKENS, JUDGE_TIMEOUT_MS per call, one retry on a transport
 * error or a 5xx (the JudgeClient's job), none on a 4xx.
 *
 * The answer must be a score in [0, 1] and a comment, parsed strictly:
 * anything else (no JSON, a score out of range, a refusal) is `error` with
 * the reason, as is a JudgeError, no judge model (NO_JUDGE_MODEL_MESSAGE),
 * no JudgeClient, or a judge provider that is not ready. Never a zero.
 *
 * Evidence: `evidence.judge` (records.ts JudgeEvidenceSchema) with the
 * provider, model, calls, tokens and the cost priced from the experiment's
 * frozen price table (null when the judge model has no price). Judge cost is
 * grading cost (plan 9.5): the spend guard never counts it.
 *
 * Order, so nothing is spent on a key that cannot be graded: no judge model
 * or no client is `error`; no final text is `ungradable` (there is nothing
 * to judge, which is not the agent's zero); an empty rubric is `error`; then
 * the call. The client checks the judge provider's readiness first.
 */
import type { JsonValue, JudgeEvidence, LlmJudgeParams, PriceTable } from '@hermes-evals/shared';
import { attemptCost } from '../execution/pricing.js';
import {
  JUDGE_MAX_TOKENS,
  JUDGE_TIMEOUT_MS,
  JudgeError,
  NO_JUDGE_MODEL_MESSAGE,
  resolveJudgeModel,
  type JudgeClient,
  type JudgeSettings,
  type JudgeTarget,
  type JudgeTokens,
} from './judge/contracts.js';
import { JudgeCallError } from './judge/call-error.js';
import { buildJudgePrompt, JUDGED_TEXT_MAX_CHARS } from './judge/prompt.js';
import { parseJudgeVerdict } from './judge/verdict.js';
import { describeThrown, graded, scorerError, ungradable, type ScorerResult } from './result.js';

/**
 * What the judge reads about one attempt. A structural slice of the
 * evaluation's ScorerContext (evaluation/context.ts) plus the task prompt,
 * so this file does not depend on the evaluation module.
 */
export interface LlmJudgeInput {
  task: {
    key: string;
    /** prompt.md, verbatim: exactly what the agent received. */
    prompt: string;
    /** reference.json; null only for a task stored without one (never a valid task). */
    reference: JsonValue | null;
  };
  /** The attempt's recorded final text; null when Hermes printed none. */
  attempt: { finalText: string | null };
}

export interface LlmJudgeDeps {
  /** Null where no judge can be called (no egress socket): the key is `error`. */
  judge: JudgeClient | null;
  /** The rubric file's text, read from the task's rubric blob (`params.rubric`). */
  rubric: string;
  /** The experiment's frozen price table (experiments.price_table), for evidence.judge.cost_usd. */
  priceTable: PriceTable;
  /** JUDGE_PROVIDER, JUDGE_MODEL and JUDGE_BASE_URL; see resolveJudgeModel. */
  settings: JudgeSettings;
  /** Aborts the judge call, e.g. when the evaluation's claim is lost. */
  signal?: AbortSignal;
}

/** The `error` comment when the worker has no JudgeClient (no egress admin socket). */
export const NO_JUDGE_CLIENT_MESSAGE =
  'No LLM judge can be called from this worker (it has no egress admin socket)';

/** What the judge's calls cost under the frozen table; null when the model has no price. */
function judgeCost(table: PriceTable, model: string, tokens: JudgeTokens): number | null {
  return attemptCost(table, model, { ...tokens, cache_read: 0, cache_write: 0 });
}

/** evidence.judge for calls that were made: who judged, what it used and what that cost. */
function judgeEvidence(
  target: JudgeTarget,
  priceTable: PriceTable,
  call: { calls: number; tokens: JudgeTokens; latencyMs: number; finishReason?: string | null },
): JudgeEvidence {
  return {
    provider: target.provider,
    ...(target.provider === 'custom' && target.baseUrl ? { base_url: target.baseUrl } : {}),
    model: target.model,
    calls: call.calls,
    tokens: { input: call.tokens.input, output: call.tokens.output, total: call.tokens.total },
    cost_usd: judgeCost(priceTable, target.model, call.tokens),
    latency_ms: Math.max(0, Math.round(call.latencyMs)),
    ...(call.finishReason !== undefined ? { finish_reason: call.finishReason } : {}),
  };
}

/**
 * The evidence of a failed judge request, when it reached a provider: a
 * JudgeCallError says how many calls it made; a bare JudgeError that still
 * carries tokens or a status made one.
 */
function failedCallEvidence(
  err: JudgeError,
  target: JudgeTarget,
  priceTable: PriceTable,
): JudgeEvidence | null {
  const calls =
    err instanceof JudgeCallError ? err.calls : err.status !== null || err.tokens.total > 0 ? 1 : 0;
  if (calls === 0) return null;
  const latencyMs = err instanceof JudgeCallError ? err.latencyMs : 0;
  return judgeEvidence(target, priceTable, { calls, tokens: err.tokens, latencyMs });
}

const formatScore = (score: number): string => String(Math.round(score * 1000) / 1000);

/** Grades one llm_judge key. Never throws: every failure is an `error` result. */
export async function scoreLlmJudge(
  ctx: LlmJudgeInput,
  params: LlmJudgeParams,
  deps: LlmJudgeDeps,
): Promise<ScorerResult> {
  const target = resolveJudgeModel(params, deps.settings);
  if (target === null) return scorerError(NO_JUDGE_MODEL_MESSAGE);
  if (deps.judge === null) return scorerError(NO_JUDGE_CLIENT_MESSAGE);
  const response = ctx.attempt.finalText;
  if (response === null || response.trim() === '') {
    return ungradable('The attempt has no final text for the judge to grade.');
  }
  if (deps.rubric.trim() === '') {
    return scorerError(`The rubric file ${params.rubric} is empty.`);
  }

  let prompt;
  try {
    prompt = buildJudgePrompt({
      rubric: deps.rubric,
      taskPrompt: ctx.task.prompt,
      reference: ctx.task.reference,
      response,
    });
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`The judge prompt could not be built: ${message}`, detail);
  }

  let answer;
  try {
    answer = await deps.judge.complete(
      {
        provider: target.provider,
        model: target.model,
        baseUrl: target.baseUrl,
        messages: { system: prompt.system, user: prompt.user },
        maxTokens: JUDGE_MAX_TOKENS,
        timeoutMs: JUDGE_TIMEOUT_MS,
        responseFormat: { type: 'json_object' },
      },
      deps.signal,
    );
  } catch (err) {
    const evidence =
      err instanceof JudgeError ? failedCallEvidence(err, target, deps.priceTable) : null;
    const { message, detail } = describeThrown(err);
    return scorerError(
      err instanceof JudgeError ? message : `The judge call failed: ${message}`,
      err instanceof JudgeError
        ? `judge ${err.kind}${err.status !== null ? ` (${err.status})` : ''}`
        : detail,
      evidence ? { evidence: { judge: evidence } } : {},
    );
  }

  const judge = judgeEvidence(target, deps.priceTable, answer);
  const verdict = parseJudgeVerdict(answer.text, answer.finishReason);
  if (!verdict.ok) return scorerError(verdict.reason, null, { evidence: { judge } });
  const passed = verdict.score >= params.pass_at;
  const truncated = prompt.truncated
    ? ` (judged on the first ${JUDGED_TEXT_MAX_CHARS} characters of the response)`
    : '';
  return graded(
    passed,
    verdict.score,
    `Judge score ${formatScore(verdict.score)}, ${passed ? 'at or above' : 'below'} ${formatScore(params.pass_at)}${truncated}: ${verdict.comment}`,
    { value: formatScore(verdict.score), evidence: { judge } },
  );
}
