/**
 * How a run names its configuration and what model access its actions need:
 * ExperimentConfigRef (with the baseline or candidate role the experiment
 * gave the version) and RunModelNeeds (BlockedReason on Retry and Re-score).
 */
import type { ExperimentConfigRef, RunModelNeeds, VerificationEntry } from '@hermes-evals/shared';
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
 * What Retry and Re-score need from model access. The judge is not built
 * until Phase 3; it judges with the configuration's own provider (plan 9.3,
 * "pointed at the configured provider base URL"), so a task with llm_judge
 * keys needs that provider for Re-score too.
 */
export function runNeeds(
  config: Pick<ConfigVersionRecord, 'provider'>,
  verification: readonly VerificationEntry[],
): RunModelNeeds {
  const judgeKeys = verification.filter((v) => v.type === 'llm_judge').map((v) => v.key);
  return {
    provider: config.provider,
    judgeKeys,
    judgeProvider: judgeKeys.length > 0 ? config.provider : null,
  };
}

/** The task's primary verification key: the entry marked primary (a valid task has exactly one). */
export function primaryKeyOf(verification: readonly VerificationEntry[]): string {
  return (verification.find((v) => v.primary) ?? verification[0])?.key ?? '';
}
