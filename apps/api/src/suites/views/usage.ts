/**
 * "In experiments" on Task detail: each experiment that ran a task version,
 * with the task's pass rate under each of its configurations.
 */
import type { ExperimentStatus, TaskExperimentUsage } from '@hermes-evals/shared';

/** Run counts of one task version under one configuration version of one experiment. */
export interface UsageCounts {
  experimentId: string;
  experimentName: string;
  status: ExperimentStatus;
  baselineVersionId: string;
  candidateVersionIds: readonly string[];
  configurationVersionId: string;
  configurationName: string;
  configurationVersion: number;
  total: number;
  /** Finished runs: scored, or execution_error, which counts as not passed. */
  counted: number;
  passed: number;
}

/**
 * Groups counts by experiment, keeping the order given (newest first). Rows
 * run baseline first, then candidates in the experiment's order. A
 * configuration is named alone unless two of its versions are in the same
 * experiment, then with its version (`baseline v2`).
 */
export function taskUsageView(rows: readonly UsageCounts[]): TaskExperimentUsage[] {
  const byExperiment = new Map<string, UsageCounts[]>();
  for (const row of rows) {
    const list = byExperiment.get(row.experimentId) ?? [];
    list.push(row);
    byExperiment.set(row.experimentId, list);
  }
  return [...byExperiment.values()].map((list) => {
    const first = list[0]!;
    const order = [first.baselineVersionId, ...first.candidateVersionIds];
    const rank = (r: UsageCounts) => {
      const i = order.indexOf(r.configurationVersionId);
      return i < 0 ? order.length : i;
    };
    const names = list.map((r) => r.configurationName);
    return {
      experimentId: first.experimentId,
      experimentName: first.experimentName,
      status: first.status,
      rows: [...list]
        .sort((a, b) => rank(a) - rank(b))
        .map((r) => ({
          configuration:
            names.filter((n) => n === r.configurationName).length > 1
              ? `${r.configurationName} v${r.configurationVersion}`
              : r.configurationName,
          role: r.configurationVersionId === first.baselineVersionId ? 'baseline' : 'candidate',
          passRate: r.counted > 0 ? r.passed / r.counted : null,
          scored: r.counted,
          total: r.total,
        })),
    };
  });
}
