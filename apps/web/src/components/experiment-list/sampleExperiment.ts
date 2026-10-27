/**
 * "Run a sample experiment" (Phase 8 G4): the launch body of invoices-v1's baseline against
 * its with-skill arm on the scripted mock model, every valid task, 2 repetitions
 * (SAMPLE_EXPERIMENT), built from New experiment's options so it goes through the normal
 * launch with the hashes the form would send. Or, when it cannot launch, why: the suite or a
 * seeded configuration is missing, or what blocks any launch (the worker, the sandbox).
 * A pure function, so the empty Experiments page and New experiment say the same thing.
 */
import {
  LaunchExperimentInputSchema,
  MAX_CONCURRENCY,
  SAMPLE_EXPERIMENT,
  type LaunchExperimentInput,
} from '@hermes-evals/shared';
import type { NewExperimentOptions } from '@/api/types/experiments';
import {
  launchBlockers,
  type ProviderSnapshot,
  type WorkerSnapshot,
} from '../new-experiment/launchReadiness';

export const SAMPLE_DESCRIPTION =
  'Started with Run a sample experiment: every valid task of invoices-v1, its baseline against its with-skill arm, both on the scripted mock model.';

/** Where the fix of a reason is: System (the seed's report, the worker) or Suites. */
export type SampleFix = 'system' | 'suites';

/** What the button does: launch this body, or stay disabled with this reason. */
export type SamplePlan =
  | { input: LaunchExperimentInput; reason: null; fix: null }
  | { input: null; reason: string; fix: SampleFix | null };

const blocked = (reason: string, fix: SampleFix | null = null): SamplePlan => ({
  input: null,
  reason,
  fix,
});

/** "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The sample's launch body from the options, or the first reason it cannot launch. `null`
 * options: they have not loaded (or failed to), so nothing can be said yet.
 */
export function sampleExperimentPlan(
  options: NewExperimentOptions | null,
  providers: ProviderSnapshot,
  workers: WorkerSnapshot,
): SamplePlan {
  if (!options) return blocked('Loading the suites and configurations.');
  const suite = options.suites.find((s) => s.name === SAMPLE_EXPERIMENT.suite);
  if (!suite) {
    return blocked(
      `The sample suite ${SAMPLE_EXPERIMENT.suite} is not loaded. It is read from ./suites; Reload on Suites reads it again.`,
      'suites',
    );
  }
  const taskKeys = suite.tasks.filter((t) => t.valid).map((t) => t.key);
  if (taskKeys.length === 0) {
    return blocked(
      `${SAMPLE_EXPERIMENT.suite} has no valid task: every task fails its self-check.`,
      'suites',
    );
  }
  const names = [SAMPLE_EXPERIMENT.baseline, SAMPLE_EXPERIMENT.candidate];
  const [baseline, candidate] = names.map((n) => options.configurations.find((c) => c.name === n));
  const missing = names.filter((n) => !options.configurations.some((c) => c.name === n));
  if (!baseline || !candidate) {
    const one = missing.length === 1;
    return blocked(
      `The sample ${one ? 'configuration' : 'configurations'} ${listed(missing)} ${one ? 'does' : 'do'} not exist. The API creates them when it starts, unless SEED_SAMPLES is off; System shows what it did.`,
      'system',
    );
  }
  const chosen = [baseline, candidate].map((c) => ({
    name: c.name,
    provider: c.provider,
    missingSecrets: c.missingSecrets,
  }));
  const blocker = launchBlockers(providers, workers, chosen)[0];
  if (blocker) return blocked(blocker.reason, 'system');
  const max = Math.max(1, Math.min(MAX_CONCURRENCY, options.maxConcurrency));
  const input: LaunchExperimentInput = {
    name: SAMPLE_EXPERIMENT.name,
    description: SAMPLE_DESCRIPTION,
    suiteId: suite.suiteId,
    taskKeys,
    baselineVersionId: baseline.versionId,
    candidateVersionIds: [candidate.versionId],
    repetitions: SAMPLE_EXPERIMENT.repetitions,
    concurrency: Math.min(options.defaults.concurrency, max),
    spendCeilingUsd: null,
    timeBudgetOverrideS: null,
    expectedConfigHashes: {
      [baseline.versionId]: baseline.configHash,
      [candidate.versionId]: candidate.configHash,
    },
  };
  // The same rules the launch parses with: a body it would refuse is never sent.
  const parsed = LaunchExperimentInputSchema.safeParse(input);
  if (!parsed.success) return blocked(parsed.error.issues[0]?.message ?? 'invalid launch');
  return { input: parsed.data, reason: null, fix: null };
}
