/**
 * The database rows the suite views are built from. The views are pure
 * functions over these, so they can be tested without a database.
 */
import type { TaskLimits } from '@hermes-evals/shared';
import { parse } from 'yaml';
import type {
  suiteSources,
  suites,
  taskFiles,
  taskRootFiles,
  tasks,
} from '../../database/schema/index.js';

export type SuiteRow = typeof suites.$inferSelect;
export type SourceRow = typeof suiteSources.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskFileRow = typeof taskFiles.$inferSelect;
export type TaskRootFileRow = typeof taskRootFiles.$inferSelect;

/**
 * A task's limits as the views show them: the stored limits, else whatever
 * positive integers task.yaml states. Only an invalid task is stored without
 * limits (the database requires them of a valid one); when its task.yaml
 * states no usable value the field is null, never a made-up number, and the
 * UI shows "—".
 */
export function limitsOf(task: Pick<TaskRow, 'limits' | 'taskYaml'>): {
  maxTurns: number | null;
  budgetS: number | null;
  toolsetsNeeded: string[];
} {
  const limits: Partial<TaskLimits> = task.limits ?? yamlLimits(task.taskYaml);
  const positive = (n: unknown): number | null =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  return {
    maxTurns: positive(limits.max_turns),
    budgetS: positive(limits.run_budget_seconds),
    toolsetsNeeded: Array.isArray(limits.toolsets_needed)
      ? limits.toolsets_needed.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

function yamlLimits(taskYaml: string | null): Partial<TaskLimits> {
  if (taskYaml === null) return {};
  try {
    const doc: unknown = parse(taskYaml);
    const limits = (doc as { limits?: unknown } | null)?.limits;
    return limits !== null && typeof limits === 'object' ? (limits as Partial<TaskLimits>) : {};
  } catch {
    return {};
  }
}
