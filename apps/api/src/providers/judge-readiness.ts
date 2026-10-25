/**
 * Whether the LLM judge can grade the llm_judge keys of some tasks (Phase 3
 * S3, plan 6.1's "Re-score with llm_judge" row): launch answers 409 when a
 * selected task has an llm_judge key and the judge's provider is not ready,
 * and so does a re-score of a run whose task has one. At scoring time the
 * judge client asks the same question (scoring/judge/egress-judge.ts) and a
 * provider that is not ready gives `error`, never a zero.
 *
 * Which provider: resolveJudgeModel's rule, so the check and the scorer
 * agree. Every key's judge runs on JUDGE_PROVIDER (or `nous` when it is
 * unset), so there is at most one provider to ask. A key with no judge model
 * at all (no `model:` and no JUDGE_MODEL) needs no provider: it is published
 * as `error` with NO_JUDGE_MODEL_MESSAGE, and does not block. It is counted
 * in `unconfigured` so a caller can warn.
 *
 * Readiness itself is the caller's: the API passes ProviderGate.readiness,
 * the worker providerReadiness bound to its own egress. A check that throws
 * counts as not ready, with why, as ProviderGate does.
 */
import type { Provider, VerificationEntry } from '@hermes-evals/shared';
import { resolveJudgeModel, type JudgeSettings } from '../scoring/judge/contracts.js';
import type { ProviderReadiness } from './readiness.js';

export interface JudgeReadinessDeps {
  /** One provider's readiness, e.g. `(p) => gate.readiness(p)` in the API. */
  readiness(provider: Provider): Promise<ProviderReadiness>;
}

export interface JudgeReadiness {
  /** False only when some llm_judge key's judge provider is not ready. */
  ready: boolean;
  /** The 409 message when not ready, e.g. "The LLM judge's provider is not ready: Nous Portal is not connected." */
  reason: string | null;
  /** The provider the judge runs on; null when no llm_judge key has a judge model. */
  provider: Provider | null;
  /** llm_judge keys among the entries. */
  judgeKeys: number;
  /** Of those, keys with no judge model: they will be published as `error`. */
  unconfigured: number;
}

/** The `model:` a stored llm_judge entry names, if it names a usable one. */
const checkModel = (params: Record<string, unknown>): string | undefined =>
  typeof params.model === 'string' ? params.model : undefined;

/**
 * Checks the judge for a set of verification entries, e.g. every selected
 * task's: `tasks.flatMap((t) => t.verification)`. Asks for readiness only
 * when some llm_judge key has a judge model, and at most once.
 */
export async function judgeReadiness(
  entries: Iterable<Pick<VerificationEntry, 'type' | 'params'>>,
  settings: JudgeSettings,
  deps: JudgeReadinessDeps,
): Promise<JudgeReadiness> {
  let judgeKeys = 0;
  let unconfigured = 0;
  let provider: Provider | null = null;
  for (const entry of entries) {
    if (entry.type !== 'llm_judge') continue;
    judgeKeys += 1;
    const target = resolveJudgeModel({ model: checkModel(entry.params) }, settings);
    if (target === null) unconfigured += 1;
    else provider = target.provider;
  }
  const summary = { provider, judgeKeys, unconfigured };
  if (provider === null) return { ready: true, reason: null, ...summary };

  let answer: ProviderReadiness;
  try {
    answer = await deps.readiness(provider);
  } catch (err) {
    return {
      ready: false,
      reason: `Whether the LLM judge's provider (${provider}) is ready could not be checked: ${(err as Error).message}`,
      ...summary,
    };
  }
  if (answer.ready) return { ready: true, reason: null, ...summary };
  return {
    ready: false,
    reason: `The LLM judge's provider is not ready: ${answer.reason ?? `${provider} is ${answer.status}`}`,
    ...summary,
  };
}
