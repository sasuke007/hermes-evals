/**
 * How a run names its configuration and what model access its actions need:
 * ExperimentConfigRef (with the baseline or candidate role the experiment
 * gave the version) and RunModelNeeds (BlockedReason on Retry and Re-score).
 */
import type { ExperimentConfigRef, RunModelNeeds, VerificationEntry } from '@hermes-evals/shared';
import type { JudgeSettings } from '../../scoring/judge/contracts.js';
import { judgeNeedsOf, noJudgeModelRefusal, unjudgedKeys } from '../judge-needs.js';
import type { ConfigVersionRecord, ExperimentRecord } from './rows.js';

/** The experiment's configuration versions in display order: the baseline, then the candidates. */
export function configOrder(experiment: ExperimentRecord): string[] {
  return [experiment.baselineVersionId, ...experiment.candidateVersionIds];
}

export function experimentConfigRef(
  experiment: ExperimentRecord,
  config: ConfigVersionRecord,
): ExperimentConfigRef {
  return {
    configurationId: config.configurationId,
    versionId: config.versionId,
    name: config.name,
    version: config.version,
    role: config.versionId === experiment.baselineVersionId ? 'baseline' : 'candidate',
    model: config.model,
    provider: config.provider,
  };
}

/**
 * What Retry and Re-score need from model access. Retry runs Hermes on the
 * configuration's provider; Re-score calls the platform's judge for the
 * task's llm_judge keys, on the judge's provider (judge-needs.ts), which is
 * null when no key has a judge model. A key with no judge model makes
 * Re-score answer 409, so its keys and that 409 are named here (Phase 4
 * question 10) for the button to be disabled with the fix.
 */
export function runNeeds(
  config: Pick<ConfigVersionRecord, 'provider'>,
  verification: readonly VerificationEntry[],
  judge: JudgeSettings,
): RunModelNeeds {
  const needs = judgeNeedsOf(verification, judge);
  const withoutModel = unjudgedKeys(needs);
  return {
    provider: config.provider,
    judgeKeys: needs.keys,
    judgeProvider: needs.provider,
    judgeKeysWithoutModel: withoutModel,
    noJudgeModelReason: withoutModel.length > 0 ? noJudgeModelRefusal(withoutModel) : null,
  };
}

/** The task's primary verification key: the entry marked primary (a valid task has exactly one). */
export function primaryKeyOf(verification: readonly VerificationEntry[]): string {
  return (verification.find((v) => v.primary) ?? verification[0])?.key ?? '';
}
