/**
 * The database rows the run views are built from. The views are pure
 * functions over these, so they are tested without a database; the
 * *.queries.ts files read them.
 */
import type { Provider } from '@hermes-evals/shared';
import type {
  artifacts,
  attempts,
  evaluations,
  experiments,
  runEvents,
  runs,
  scores,
  suites,
  tasks,
  workers,
} from '../../database/schema/index.js';

export type RunRecord = typeof runs.$inferSelect;
export type AttemptRecord = typeof attempts.$inferSelect;
export type EventRecord = Pick<typeof runEvents.$inferSelect, 'seq' | 'ts' | 'type' | 'payload'>;
export type ArtifactRecord = typeof artifacts.$inferSelect;
export type EvaluationRecord = typeof evaluations.$inferSelect;
export type ScoreRecord = typeof scores.$inferSelect;
export type SuiteRecord = typeof suites.$inferSelect;
export type WorkerRecord = Pick<
  typeof workers.$inferSelect,
  'id' | 'hostname' | 'lastHeartbeatAt' | 'sandbox'
>;

/** The experiment columns the run views read. */
export type ExperimentRecord = Pick<
  typeof experiments.$inferSelect,
  | 'id'
  | 'name'
  | 'status'
  | 'suiteId'
  | 'taskIds'
  | 'baselineVersionId'
  | 'candidateVersionIds'
  | 'timeBudgetOverrideS'
  | 'cancelledAt'
>;

/** The task columns the run views read. */
export type TaskRecord = Pick<
  typeof tasks.$inferSelect,
  | 'id'
  | 'key'
  | 'versionNumber'
  | 'position'
  | 'summary'
  | 'verification'
  | 'reference'
  | 'taskYaml'
>;

/** A configuration version as an experiment uses it, with its configuration's name. */
export interface ConfigVersionRecord {
  versionId: string;
  configurationId: string;
  name: string;
  version: number;
  model: string;
  provider: Provider;
  baseUrl: string | null;
  maxTurns: number;
  timeBudgetS: number;
}
