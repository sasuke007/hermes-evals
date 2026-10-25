/**
 * What the experiment views are computed from, as plain records. queries.ts
 * reads them from Postgres; the builders in this folder (counts, money,
 * progress, failure) are pure functions over them, so every number the
 * Overview shows is tested without a database.
 */
import type {
  ExecutionErrorCategory,
  ExperimentConfigRef,
  RunStatus,
  ScoreStatus,
  Tokens,
} from '@hermes-evals/shared';

/** One run of the matrix with its current attempt and its current primary score. */
export interface RunFacts {
  id: string;
  taskKey: string;
  /** The task's version number (plan 4.5). */
  taskVersion: number;
  configurationVersionId: string;
  repetition: number;
  status: RunStatus;
  attemptCount: number;
  finishedAt: Date | null;
  /** Null until the first attempt starts. */
  attempt: AttemptFacts | null;
  /**
   * The primary key of the run's current evaluation (completed, not
   * superseded); null unless the run is scored.
   */
  primary: PrimaryFacts | null;
}

export interface AttemptFacts {
  status: RunStatus;
  errorCategory: ExecutionErrorCategory | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  tokens: Tokens | null;
}

export interface PrimaryFacts {
  key: string;
  status: ScoreStatus;
  score: number | null;
}

/** Attempt money of one configuration version of one experiment, over every attempt. */
export interface ArmMoney {
  configurationVersionId: string;
  /** Attempts that have ended (any status but running). */
  finishedAttempts: number;
  /** Attempts with a cost; their sum is costUsd. */
  pricedAttempts: number;
  costUsd: number;
  /**
   * Finished attempts with no cost although their trial ran (a container was
   * recorded): usage nobody measured, because the worker or egress lost it.
   * For a priced model their cost is unknown, never zero.
   */
  unmeasuredAttempts: number;
}

/** A configuration version as an experiment shows it. */
export interface ConfigFacts {
  ref: ExperimentConfigRef;
  /** The version's time budget per run, in seconds: the estimate's fallback basis (plan 7.2). */
  timeBudgetS: number;
}
