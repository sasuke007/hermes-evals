/**
 * Resolves a claimed attempt into the AttemptPlan the runner works from
 * (execution/contracts.ts, plan 5.4): the task's prompt and fixtures, the
 * frozen configuration version with its skills, documents and MCP
 * definitions, the run budget after the experiment's override, and the
 * Hermes revision the experiment froze. Everything read here is immutable
 * once the experiment launched (suites, tasks, task files, skills,
 * documents, frozen versions), so it is read after the claim commits,
 * without locks.
 *
 * The MCP refusal check (refusedEnvNames, plan 5.3) runs on the result
 * before any value could enter a trial: see refusalOf.
 */
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  configurations,
  configurationVersions,
  documents,
  experiments,
  mcpServers,
  mcpServerVersions,
  skills,
  taskFiles,
  tasks,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { effectiveBudgetS } from '../budget.js';
import { definitionOf } from '../../resources/mcp/definition.js';
import { refusedEnvNames } from '../../worker/handlers/test-mcp-server.js';
import type { AttemptPlan, PlannedMcpServer } from '../contracts.js';
import type { ClaimedAttempt } from './types.js';

/** The plan cannot be built: the attempt ends as execution_error `setup` with this message. */
export class PlanError extends Error {
  override readonly name = 'PlanError';
}

export interface PlanInput {
  slot: string;
  /** TRIALS_DIR as the worker mounts it. */
  trialsDir: string;
  /** A fresh newAttemptToken(); it lives only in memory, egress and the container. */
  token: string;
  /**
   * The Hermes revision this worker's trials run. It must be the one the
   * experiment froze; the claim already deferred any other, so a mismatch
   * here is a fault, and the launch record must state what really ran.
   */
  hermesRevision: string;
}

const FIXTURES_PREFIX = 'fixtures/';

/** Keeps the order of `ids` (the order the configuration lists them). */
const inOrderOf = <T extends { id: string }>(ids: readonly string[], rows: T[]): T[] => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
};

export async function buildAttemptPlan(
  db: AppDb,
  claimed: ClaimedAttempt,
  input: PlanInput,
): Promise<AttemptPlan> {
  const [task] = await db
    .select({ id: tasks.id, key: tasks.key, prompt: tasks.prompt })
    .from(tasks)
    .where(eq(tasks.id, claimed.taskId));
  if (!task) throw new PlanError(`task ${claimed.taskId} does not exist`);
  if (!task.prompt) throw new PlanError(`task ${task.key} has no prompt`);

  const fixtures = await db
    .select({ path: taskFiles.path, sha256: taskFiles.sha256, size: taskFiles.size })
    .from(taskFiles)
    .where(and(eq(taskFiles.taskId, task.id), eq(taskFiles.kind, 'fixture')))
    .orderBy(taskFiles.path);

  const [version] = await db
    .select({ version: configurationVersions, name: configurations.name })
    .from(configurationVersions)
    .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
    .where(eq(configurationVersions.id, claimed.configurationVersionId));
  if (!version)
    throw new PlanError(`configuration version ${claimed.configurationVersionId} does not exist`);
  const cv = version.version;

  const [experiment] = await db
    .select({
      hermesVersion: experiments.hermesVersion,
      hermesRevision: experiments.hermesRevision,
      timeBudgetOverrideS: experiments.timeBudgetOverrideS,
    })
    .from(experiments)
    .where(eq(experiments.id, claimed.experimentId));
  if (!experiment) throw new PlanError(`experiment ${claimed.experimentId} does not exist`);
  if (experiment.hermesRevision !== input.hermesRevision) {
    throw new PlanError(
      `the experiment was launched on Hermes ${experiment.hermesRevision.slice(0, 7)}, but this ` +
        `worker runs ${input.hermesRevision.slice(0, 7)}`,
    );
  }

  const skillRows =
    cv.skillIds.length === 0
      ? []
      : await db
          .select({
            id: skills.id,
            name: skills.name,
            version: skills.version,
            contentHash: skills.contentHash,
          })
          .from(skills)
          .where(inArray(skills.id, cv.skillIds));
  const documentRows =
    cv.documentIds.length === 0
      ? []
      : await db
          .select({ id: documents.id, filename: documents.filename, sha256: documents.sha256 })
          .from(documents)
          .where(inArray(documents.id, cv.documentIds));
  const mcpRows =
    cv.mcpServerVersionIds.length === 0
      ? []
      : await db
          .select({ name: mcpServers.name, row: mcpServerVersions })
          .from(mcpServerVersions)
          .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
          .where(inArray(mcpServerVersions.id, cv.mcpServerVersionIds));
  const mcpServersPlanned: PlannedMcpServer[] = inOrderOf(
    cv.mcpServerVersionIds,
    mcpRows.map(({ name, row }) => ({ id: row.id, name, row })),
  ).map(({ name, row }) => ({
    versionId: row.id,
    name,
    version: row.version,
    transport: row.transport,
    definition: definitionOf(name, row),
    definitionHash: row.definitionHash,
  }));
  // The refs trigger checked every id when the version was saved, so a gap
  // here means a row went missing since: never start a trial without it.
  if (
    skillRows.length !== new Set(cv.skillIds).size ||
    documentRows.length !== new Set(cv.documentIds).size ||
    mcpRows.length !== new Set(cv.mcpServerVersionIds).size
  ) {
    throw new PlanError(
      `configuration ${version.name} v${cv.version} references a skill, document or MCP server that no longer exists`,
    );
  }

  const root = join(input.trialsDir, claimed.attemptId);
  return {
    experimentId: claimed.experimentId,
    runId: claimed.runId,
    attemptId: claimed.attemptId,
    attemptNumber: claimed.attemptNumber,
    token: input.token,
    slot: input.slot,
    paths: { root, home: join(root, 'home'), workspace: join(root, 'workspace') },
    task: {
      id: task.id,
      key: task.key,
      prompt: task.prompt,
      fixtures: fixtures.map((file) => ({
        path: file.path.startsWith(FIXTURES_PREFIX)
          ? file.path.slice(FIXTURES_PREFIX.length)
          : file.path,
        sha256: file.sha256,
        size: file.size,
      })),
    },
    limits: {
      maxTurns: cv.maxTurns,
      runBudgetS: effectiveBudgetS(cv.timeBudgetS, experiment.timeBudgetOverrideS),
    },
    configuration: {
      versionId: cv.id,
      name: version.name,
      version: cv.version,
      model: cv.model,
      provider: cv.provider,
      baseUrl: cv.baseUrl,
      toolsets: [...new Set(cv.toolsets)].sort(),
      memoryEnabled: cv.memoryEnabled,
      skills: inOrderOf(cv.skillIds, skillRows),
      documents: inOrderOf(cv.documentIds, documentRows),
      mcpServers: mcpServersPlanned,
    },
    hermes: { version: experiment.hermesVersion, revision: input.hermesRevision },
  };
}

/**
 * Why the plan may not start, or null: an MCP definition names a reserved
 * variable, or a stdio env name an http server uses as a header variable
 * (refusedEnvNames). Checked again here for definitions stored before the
 * API refused such names, before any value can enter a trial.
 */
export async function refusalOf(db: AppDb, plan: AttemptPlan): Promise<string | null> {
  for (const server of plan.configuration.mcpServers) {
    const refusal = await refusedEnvNames(db, server.definition);
    if (refusal) return `MCP server ${server.name}: ${refusal}`;
  }
  return null;
}
