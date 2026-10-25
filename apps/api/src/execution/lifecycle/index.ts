/**
 * The execution lifecycle (plan 7.3, 7.4, 8.1, 8.4, 8.6): claim, admission,
 * guards, leases, the fenced sink, finish, retries, the circuit breaker,
 * recovery and slots. WorkerService needs only startExecutionLifecycle and
 * the handle's stop(); the rest is exported for tests and tools.
 */
export {
  lifecycleSettingsFromEnv,
  startExecutionLifecycle,
  trialConcurrency,
  type ExecutionLifecycle,
  type ExecutionLifecycleDeps,
} from './lifecycle.js';
export {
  ExecuteRunJobSchema,
  handleExecuteRunJob,
  type DeferReason,
  type ExecuteRunDeps,
  type ExecuteRunResult,
  type HandBackReason,
} from './execute-run.js';
export { claimRun, readClaimTarget, staleReason, trialPathOf, type ClaimOutcome } from './claim.js';
export { autoRetries, finishAttempt, type FinishInput, type FinishResult } from './finish.js';
export {
  finaliseLostAttempt,
  RECOVERY_MAX_ATTEMPTS,
  type FinalisedAttempt,
} from './finalise-lost.js';
export { LeaseKeeper } from './leases.js';
export { buildAttemptPlan, PlanError, refusalOf } from './plan.js';
export { pgBossLifecycleQueue } from './queue.js';
export { recoveryPass, revokeLeases, type RecoveryDeps, type RecoveryReport } from './recovery.js';
export {
  drizzlePoolRecoveryLock,
  poolRecoveryLock,
  RECOVERY_LOCK_KEY,
  sessionRecoveryLock,
  type RecoveryLock,
} from './recovery-lock.js';
export { FencedAttemptSink } from './sink.js';
export {
  CancelRequestedError,
  DEFAULT_LIFECYCLE_SETTINGS,
  type ClaimedAttempt,
  type LifecycleLogger,
  type LifecycleQueue,
  type LifecycleSettings,
} from './types.js';
