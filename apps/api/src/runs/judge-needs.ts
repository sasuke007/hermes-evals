/**
 * What a task's llm_judge keys need from model access (plan 6.1 "Nudges",
 * Phase 3 decision S3): the provider their judge calls go to. One reading
 * of the rule, for the run views' `needs.judgeProvider` (BlockedReason on
 * Re-score) and for the Re-score check that answers 409 while that provider
 * is not ready, so the button and the endpoint never disagree.
 *
 * The judge is the platform's, not the run's: a key's own `model:`, else
 * JUDGE_MODEL, on JUDGE_PROVIDER (scoring/judge/contracts.ts
 * resolveJudgeModel). A key with neither model is published as `error` at
 * scoring time and needs no provider.
 */
import type { ConfigService } from '@nestjs/config';
import type { Provider, VerificationEntry } from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import {
  judgeSettingsOf,
  resolveJudgeModel,
  type JudgeSettings,
} from '../scoring/judge/contracts.js';

export interface JudgeNeeds {
  /** Every llm_judge key of the task, in declaration order. */
  keys: string[];
  /** The keys that will call the judge: those with a model from the check or the settings. */
  judged: string[];
  /** The provider of those calls; null when no key calls the judge. */
  provider: Provider | null;
}

/** The judge settings of the process (JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL). */
export function judgeSettingsFrom(config: Pick<ConfigService<Env, true>, 'get'>): JudgeSettings {
  return judgeSettingsOf({
    JUDGE_PROVIDER: config.get('JUDGE_PROVIDER', { infer: true }),
    JUDGE_MODEL: config.get('JUDGE_MODEL', { infer: true }),
    JUDGE_BASE_URL: config.get('JUDGE_BASE_URL', { infer: true }),
  });
}

/** The judge needs of a task's verification list. */
export function judgeNeedsOf(
  verification: readonly VerificationEntry[],
  settings: JudgeSettings,
): JudgeNeeds {
  const needs: JudgeNeeds = { keys: [], judged: [], provider: null };
  for (const entry of verification) {
    if (entry.type !== 'llm_judge') continue;
    needs.keys.push(entry.key);
    const model = entry.params['model'];
    const target = resolveJudgeModel(
      { model: typeof model === 'string' ? model : undefined },
      settings,
    );
    if (!target) continue;
    needs.judged.push(entry.key);
    // Every key runs on the same provider (JUDGE_PROVIDER), whichever model it names.
    needs.provider ??= target.provider;
  }
  return needs;
}
