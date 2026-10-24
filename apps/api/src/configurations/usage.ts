/**
 * Where a configuration was used: one row per experiment and version of it
 * that the experiment tests, with that arm's progress and pass rate. Pass
 * rates are counted on each run's current published evaluation, by its
 * primary score; the verdict comes from the experiment's verdict history,
 * which the analysis appends to (plan section 10).
 */
import { and, arrayOverlaps, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ConfigurationUsage, ExperimentStatus, VerdictEntry } from '@hermes-evals/shared';
import { evaluations, experiments, runs, scores } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';

export type ExperimentRow = Pick<
  typeof experiments.$inferSelect,
  | 'id'
  | 'name'
  | 'status'
  | 'repetitions'
  | 'baselineVersionId'
  | 'candidateVersionIds'
  | 'verdictHistory'
  | 'createdAt'
>;

/** Experiments that test any of the versions, newest first. */
export async function experimentsUsing(
  db: AppDb,
  versionIds: readonly string[],
): Promise<ExperimentRow[]> {
  if (versionIds.length === 0) return [];
  const ids = [...versionIds];
  return db
    .select({
      id: experiments.id,
      name: experiments.name,
      status: experiments.status,
      repetitions: experiments.repetitions,
      baselineVersionId: experiments.baselineVersionId,
      candidateVersionIds: experiments.candidateVersionIds,
      verdictHistory: experiments.verdictHistory,
      createdAt: experiments.createdAt,
    })
    .from(experiments)
    .where(
      or(
        inArray(experiments.baselineVersionId, ids),
        arrayOverlaps(experiments.candidateVersionIds, ids),
      ),
    )
    .orderBy(desc(experiments.createdAt), desc(experiments.id));
}

/** Run counts of one arm (configuration version) of one experiment. */
export interface ArmCounts {
  total: number;
  scored: number;
  executionErrors: number;
  /** Scored runs whose current evaluation's primary score passed. */
  passed: number;
}

const EMPTY_ARM: ArmCounts = { total: 0, scored: 0, executionErrors: 0, passed: 0 };

/**
 * Counts per experiment and configuration version. Each run has at most one
 * current evaluation (completed, not superseded) and each evaluation at most
 * one primary score (both unique indexes), so the joins never multiply runs.
 */
export async function armCounts(
  db: AppDb,
  experimentIds: readonly string[],
): Promise<Map<string, ArmCounts>> {
  if (experimentIds.length === 0) return new Map();
  const rows = await db
    .select({
      experimentId: runs.experimentId,
      versionId: runs.configurationVersionId,
      total: sql<number>`count(*)`.mapWith(Number),
      scored: sql<number>`count(*) filter (where ${runs.status} = 'scored')`.mapWith(Number),
      executionErrors:
        sql<number>`count(*) filter (where ${runs.status} = 'execution_error')`.mapWith(Number),
      passed:
        sql<number>`count(*) filter (where ${runs.status} = 'scored' and ${scores.status} = 'passed')`.mapWith(
          Number,
        ),
    })
    .from(runs)
    .leftJoin(
      evaluations,
      and(
        eq(evaluations.runId, runs.id),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
      ),
    )
    .leftJoin(scores, and(eq(scores.evaluationId, evaluations.id), eq(scores.isPrimary, true)))
    .where(inArray(runs.experimentId, [...experimentIds]))
    .groupBy(runs.experimentId, runs.configurationVersionId);
  return new Map(rows.map((r) => [armKey(r.experimentId, r.versionId), r]));
}

const armKey = (experimentId: string, versionId: string) => `${experimentId}\u0000${versionId}`;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

const isLive = (status: ExperimentStatus) => status === 'running' || status === 'paused';

/**
 * Pass rate of one arm. While the experiment runs, of the runs scored so
 * far; once it has finished, execution errors count as not passed, the way
 * the comparison counts them. Null until something counts.
 */
export function armPassRate(status: ExperimentStatus, arm: ArmCounts): number | null {
  const counted = isLive(status) ? arm.scored : arm.scored + arm.executionErrors;
  return counted === 0 ? null : round3(arm.passed / counted);
}

/**
 * The candidate's verdict as the usage list shows it: not computable with a
 * single repetition or nothing scored, the last recorded verdict once the
 * experiment has completed, and provisional before that.
 */
export function armVerdict(
  experiment: Pick<ExperimentRow, 'status' | 'repetitions' | 'verdictHistory'>,
  candidateVersionId: string,
  scoredInExperiment: number,
): NonNullable<ConfigurationUsage['verdict']> {
  if (experiment.repetitions < 2 || scoredInExperiment === 0) return 'not_computable';
  if (experiment.status !== 'completed') return 'provisional';
  const last: VerdictEntry | undefined = experiment.verdictHistory.findLast(
    (entry) => entry.candidate_version_id === candidateVersionId,
  );
  return last?.verdict ?? 'provisional';
}

/**
 * Usage rows for the versions of one configuration, newest experiment first.
 * `versions` maps each version id of the configuration to its number. An
 * experiment that compares two versions of the same configuration gives two
 * rows, one per role.
 */
export async function configurationUsage(
  db: AppDb,
  versions: ReadonlyMap<string, number>,
): Promise<ConfigurationUsage[]> {
  const used = await experimentsUsing(db, [...versions.keys()]);
  const counts = await armCounts(
    db,
    used.map((e) => e.id),
  );
  const arm = (experimentId: string, versionId: string) =>
    counts.get(armKey(experimentId, versionId)) ?? EMPTY_ARM;
  return used.flatMap((e) => {
    const arms = [e.baselineVersionId, ...e.candidateVersionIds];
    const scoredInExperiment = arms.reduce((n, v) => n + arm(e.id, v).scored, 0);
    const baselineRate = armPassRate(e.status, arm(e.id, e.baselineVersionId));
    return arms.flatMap((versionId): ConfigurationUsage[] => {
      const version = versions.get(versionId);
      if (version === undefined) return [];
      const isBaseline = versionId === e.baselineVersionId;
      const mine = arm(e.id, versionId);
      return [
        {
          experimentId: e.id,
          experimentName: e.name,
          role: isBaseline ? 'baseline' : 'candidate',
          status: e.status,
          version,
          repetitions: e.repetitions,
          passRate: armPassRate(e.status, mine),
          scored: mine.scored,
          total: mine.total,
          verdict: isBaseline ? null : armVerdict(e, versionId, scoredInExperiment),
          baselinePassRate: isBaseline ? null : baselineRate,
        },
      ];
    });
  });
}
