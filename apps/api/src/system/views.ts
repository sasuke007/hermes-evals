/**
 * Maps `workers` rows to the System view models in @hermes-evals/shared
 * (contracts/system.ts). Pure, so the rules the System page shows are tested
 * without a database.
 */
import type { SandboxCheck, SandboxStatus, Worker } from '@hermes-evals/shared';
import type { WorkerSandbox } from '../database/schema/worker-sandbox.js';
import { trialConcurrency } from '../execution/slots.js';

/** Re-runs the self-test by hand, from the repository root (UI_FLOWS 5.1). */
export const SELFTEST_COMMAND =
  'docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest';

/** Shown in place of the image digest when the worker could not read one. */
export const UNKNOWN_DIGEST = 'unknown';

/** What the workers query selects; `online` is computed on the database clock. */
export interface WorkerViewRow {
  id: string;
  lastHeartbeatAt: Date;
  concurrency: number;
  /** The worker's trial slot networks (TRIAL_SLOTS); null on rows from before it was reported. */
  slots: number | null;
  /** Trials the worker is running, each on one slot. */
  inFlight: number;
  sandbox: WorkerSandbox | null;
  online: boolean;
}

/**
 * A worker as the System page and the shell show it: "concurrency 3, trial
 * slots 2 of 4" (UI_FLOWS 5.2). The slot total is the worker's own slot
 * count, not its concurrency; an offline worker has no slots to show.
 * `effectiveConcurrency` is what the worker really runs at once, the rule
 * its lifecycle uses (trialConcurrency, Phase 3 question 15): 6 with 4 slots
 * runs 4. A row from before slots were reported runs its concurrency.
 */
export function workerView(row: WorkerViewRow): Worker {
  return {
    id: row.id,
    status: row.online ? 'online' : 'offline',
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    concurrency: row.concurrency,
    effectiveConcurrency: trialConcurrency(row.concurrency, row.slots ?? row.concurrency),
    slotsInUse: row.online ? row.inFlight : null,
    slotsTotal: row.online ? row.slots : null,
    sandboxProven: row.sandbox?.state === 'isolated',
  };
}

/** "hermes-agent v0.22.4 @ 4d04303": the version and the short git sha. */
export function hermesRevisionLabel(version: string, revision: string): string {
  return `hermes-agent v${version} @ ${revision.slice(0, 7)}`;
}

/**
 * The checks to show. A report without checks (the sandbox was unreachable,
 * or the self-test threw) becomes one failed check carrying the reason, so
 * the page says why isolation is not proven instead of "0 of 0".
 */
function sandboxChecks(sandbox: WorkerSandbox): SandboxCheck[] {
  if (sandbox.checks.length > 0) return sandbox.checks.map((check) => ({ ...check }));
  if (sandbox.state === 'isolated') return [];
  const unavailable = sandbox.state === 'unavailable';
  return [
    {
      id: unavailable ? 'sandbox-reachable' : 'self-test-ran',
      name: unavailable ? 'docker-guard and egress are reachable' : 'the isolation self-test ran',
      passed: false,
      detail: sandbox.error ?? (unavailable ? 'not reachable' : 'did not run'),
    },
  ];
}

/** A worker's isolation report as the System page's Sandbox section shows it. */
export function sandboxView(hermesVersion: string, sandbox: WorkerSandbox): SandboxStatus {
  return {
    proven: sandbox.state === 'isolated',
    checks: sandboxChecks(sandbox),
    checkedAt: sandbox.checked_at,
    trigger: sandbox.trigger ?? 'worker start',
    revision: hermesRevisionLabel(hermesVersion, sandbox.revision),
    image: sandbox.image,
    digest: sandbox.image_digest ?? UNKNOWN_DIGEST,
    selftestCommand: SELFTEST_COMMAND,
  };
}
