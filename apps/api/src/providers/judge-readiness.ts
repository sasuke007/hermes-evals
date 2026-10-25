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
 * at all (no `model:` and no JUDGE_MODEL) could only be published as `error`
 * with NO_JUDGE_MODEL_MESSAGE, after the runs were paid for, so it blocks too
 * (Phase 3 question 2), before any provider is asked, with the fix in the
 * message (noJudgeModelReason).
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
  /** False when some llm_judge key has no judge model, or its judge's provider is not ready. */
  ready: boolean;
  /** The 409 message when not ready, e.g. "The LLM judge's provider is not ready: Nous Portal is not connected." */
  reason: string | null;
  /** The provider the judge runs on; null when no llm_judge key has a judge model. */
  provider: Provider | null;
  /** llm_judge keys among the entries. */
  judgeKeys: number;
  /** Of those, keys with no judge model: they block. */
  unconfigured: number;
}

/** An llm_judge entry as the check reads it; `task` names its task in the message. */
export type JudgedEntry = Pick<VerificationEntry, 'type' | 'params'> & {
  key?: string;
  task?: string;
};

/** How to give the judge a model: the API and the worker both read the settings. */
export const JUDGE_MODEL_FIX =
  'set JUDGE_MODEL (and JUDGE_PROVIDER, nous when unset) in .env, then docker compose up -d api worker';

/** Keys named in one message before the rest are counted. */
const MAX_NAMED_KEYS = 5;

/** `late_fees.quality, vat_split.tone and 2 more`: the keys a refusal names. */
export function namedKeys(labels: readonly string[]): string {
  const shown = labels.slice(0, MAX_NAMED_KEYS);
  const rest = labels.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/**
 * The launch's 409 for llm_judge keys no model can grade: "The LLM judge
 * has no model for late_fees.quality: set JUDGE_MODEL … or give the check
 * its own model: in task.yaml."
 */
export function noJudgeModelReason(labels: readonly string[]): string {
  const one = labels.length === 1;
  return (
    `The LLM judge has no model for ${namedKeys(labels)}: ${JUDGE_MODEL_FIX}, or give ` +
    `${one ? 'the check' : 'each check'} its own model: in task.yaml.`
  );
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
  entries: Iterable<JudgedEntry>,
  settings: JudgeSettings,
  deps: JudgeReadinessDeps,
): Promise<JudgeReadiness> {
  let judgeKeys = 0;
  let provider: Provider | null = null;
  const unjudged: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'llm_judge') continue;
    judgeKeys += 1;
    const target = resolveJudgeModel({ model: checkModel(entry.params) }, settings);
    if (target !== null) provider = target.provider;
    else {
      const key = entry.key ?? `llm_judge key ${unjudged.length + 1}`;
      unjudged.push(entry.task ? `${entry.task}.${key}` : key);
    }
  }
  const summary = { provider, judgeKeys, unconfigured: unjudged.length };
  if (unjudged.length > 0) {
    return { ready: false, reason: noJudgeModelReason(unjudged), ...summary };
  }
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
