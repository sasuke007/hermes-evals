/**
 * What an experiment froze at launch, as the snapshot strip shows it: the
 * suite version and its tasks, the configuration versions and how each
 * candidate differs from the baseline, and the Hermes build. Also whether
 * the suite directory has moved on since (plan 4.5): the newer-version
 * notice on an older experiment.
 */
import { inArray } from 'drizzle-orm';
import type {
  ConfigDifference,
  ConfigRole,
  ExperimentConfigRef,
  ExperimentSuiteSnapshot,
  HermesRevision,
  NewerSuiteVersion,
} from '@hermes-evals/shared';
import { loadResources, pickResources } from '../../configurations/references.js';
import { configDiff, type ResolvedSettings } from '../../configurations/settings.js';
import { loadVersionPairs, settingsOf, versionRef } from '../../configurations/views.js';
import { tasks } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { sourceOf, suiteById, taskStatesOf } from '../../suites/suites.queries.js';
import { suiteChanges, type TaskState } from '../../suites/views/changes.js';
import { suiteDisplayPath } from '../../suites/views/format.js';
import { suiteRef } from '../../suites/views/suite-views.js';
import type { ConfigFacts } from './facts.js';
import type { SuiteRow, VersionFacts } from './queries.js';

/** The Hermes package every trial image runs. */
export const HERMES_PACKAGE = 'hermes-agent';

/** "v0.22.4", whether the worker reported the version with its `v` or not. */
export const hermesView = (version: string, revision: string): HermesRevision => ({
  package: HERMES_PACKAGE,
  version: version.startsWith('v') ? version : `v${version}`,
  revision,
});

export function configFacts(version: VersionFacts, role: ConfigRole): ConfigFacts {
  const ref: ExperimentConfigRef = {
    configurationId: version.configurationId,
    versionId: version.versionId,
    name: version.name,
    version: version.version,
    role,
    model: version.model,
    provider: version.provider,
  };
  return { ref, timeBudgetS: version.timeBudgetS };
}

/**
 * The baseline then the candidates, in launch order. A version missing from
 * the map is corruption (the launch trigger checked every id) and throws.
 */
export function experimentConfigs(
  e: { baselineVersionId: string; candidateVersionIds: readonly string[] },
  versions: ReadonlyMap<string, VersionFacts>,
): ConfigFacts[] {
  const pick = (id: string): VersionFacts => {
    const found = versions.get(id);
    if (!found) throw new Error(`configuration version ${id} of an experiment does not exist`);
    return found;
  };
  return [
    configFacts(pick(e.baselineVersionId), 'baseline'),
    ...e.candidateVersionIds.map((id) => configFacts(pick(id), 'candidate')),
  ];
}

/** One task of the experiment's suite version, as far as the snapshot needs it. */
type TaskFacts = TaskState & { id: string; versionNumber: number };

/**
 * Whether the directory now serves a newer version than the experiment's,
 * and what that means for the experiment's tasks: changed (content hash
 * differs), removed, or invalid there. Null when the directory serves this
 * version (or an older one, after a revert) or no longer serves any.
 */
export function newerVersionOf(
  suite: SuiteRow,
  included: readonly TaskState[],
  current: SuiteRow | null,
  currentTasks: readonly TaskState[],
): NewerSuiteVersion | null {
  if (current === null || current.versionNumber <= suite.versionNumber) return null;
  const keys = new Set(included.map((t) => t.key));
  const changes = suiteChanges(
    included,
    currentTasks.filter((t) => keys.has(t.key)),
  );
  return {
    suiteId: current.id,
    versionNumber: current.versionNumber,
    changedTasks: changes.changed,
    removedTasks: changes.removed,
    invalidTasks: changes.nowInvalid,
  };
}

/** The experiment's suite version with its selected tasks, in the experiment's order. */
export async function suiteSnapshot(
  db: AppDb,
  suite: SuiteRow,
  taskIds: readonly string[],
): Promise<ExperimentSuiteSnapshot> {
  const rows: TaskFacts[] =
    taskIds.length === 0
      ? []
      : await db
          .select({
            id: tasks.id,
            key: tasks.key,
            versionNumber: tasks.versionNumber,
            contentHash: tasks.contentHash,
            valid: tasks.valid,
          })
          .from(tasks)
          .where(inArray(tasks.id, [...taskIds]));
  const byId = new Map(rows.map((t) => [t.id, t]));
  const included = taskIds.flatMap((id) => byId.get(id) ?? []);
  const source = await sourceOf(db, suite.sourcePath);
  const current =
    source?.currentSuiteId && source.currentSuiteId !== suite.id
      ? await suiteById(db, source.currentSuiteId)
      : null;
  const currentTasks = current ? await taskStatesOf(db, [current.id]) : [];
  return {
    ...suiteRef(suite),
    path: suiteDisplayPath(suite.sourcePath),
    taskCount: suite.taskCount,
    tasks: included.map((t) => ({ key: t.key, version: t.versionNumber })),
    newerVersion: newerVersionOf(suite, included, current, currentTasks),
  };
}

/** The content hash behind a candidate's value of a resource field: its first resource the baseline lacks. */
function differenceHash(
  field: ConfigDifference['field'],
  baseline: ResolvedSettings,
  candidate: ResolvedSettings,
): string | null {
  switch (field) {
    case 'skills': {
      const ids = new Set(baseline.skills.map((s) => s.skillId));
      return candidate.skills.find((s) => !ids.has(s.skillId))?.contentHash ?? null;
    }
    case 'documents': {
      const ids = new Set(baseline.documents.map((d) => d.documentId));
      return candidate.documents.find((d) => !ids.has(d.documentId))?.sha256 ?? null;
    }
    case 'mcp_servers': {
      const ids = new Set(baseline.mcpServers.map((m) => m.versionId));
      return candidate.mcpServers.find((m) => !ids.has(m.versionId))?.definitionHash ?? null;
    }
    default:
      return null;
  }
}

/**
 * Every field where a candidate differs from the baseline, candidate by
 * candidate, in CONFIG_FIELDS order: the configurations diff (plan 6), the
 * same table New experiment and Compare show, read pairwise.
 */
export async function configDifferences(
  db: AppDb,
  baselineVersionId: string,
  candidateVersionIds: readonly string[],
): Promise<ConfigDifference[]> {
  const pairs = await loadVersionPairs(db, [baselineVersionId, ...candidateVersionIds]);
  const index = await loadResources(
    db,
    pairs.map((p) => p.row),
  );
  const columns = new Map(
    pairs.map((p) => [
      p.row.id,
      {
        ref: versionRef(p.configuration, p.row),
        settings: settingsOf(p.row, pickResources(index, p.row)),
      },
    ]),
  );
  const baseline = columns.get(baselineVersionId);
  if (!baseline) throw new Error(`configuration version ${baselineVersionId} does not exist`);
  return candidateVersionIds.flatMap((id) => {
    const candidate = columns.get(id);
    if (!candidate) throw new Error(`configuration version ${id} does not exist`);
    return configDiff([baseline, candidate])
      .rows.filter((row) => row.differs)
      .map((row) => ({
        field: row.field,
        candidate: candidate.ref.name,
        baselineValue: row.values[0] ?? '',
        candidateValue: row.values[1] ?? '',
        hash: differenceHash(row.field, baseline.settings, candidate.settings),
      }));
  });
}
