/**
 * POST /experiments/:id/duplicate (plan 4.5 and 7.3, UI_FLOWS 11.3): the New
 * experiment form prefilled from an experiment, on its suite directory's
 * CURRENT version. Experiments never change, so running on edited tasks
 * means duplicating. The draft says what moved since the original: tasks
 * whose content changed, tasks the current version no longer has, and tasks
 * now invalid; the last two are left out of the selection with their reason.
 * Nothing is stored.
 *
 * Configurations are proposed at their latest versions, the ones the form
 * offers and launch accepts (a launch on a version with a newer one is a
 * 409). The one exception keeps the original versions: an experiment that
 * compared two versions of the same configuration, which would otherwise
 * collapse into one.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NewExperimentDraft } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import {
  configurations,
  configurationVersions,
  experiments,
  suiteSources,
  suites,
  tasks,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { notFound } from './command-support.js';

type TaskRow = typeof tasks.$inferSelect;

/** The latest version of a configuration, joined beside the version an experiment used. */
const latest = alias(configurationVersions, 'latest');

/** What differs between the original's tasks and the current version's. */
export interface TaskChanges {
  /** Original keys still valid now, in the original's order. */
  kept: string[];
  changed: string[];
  removed: string[];
  invalid: { key: string; reason: string }[];
}

/** Compares by key: same content hash is unchanged, another hash changed. */
export function taskChanges(
  original: readonly Pick<TaskRow, 'key' | 'contentHash'>[],
  current: readonly Pick<TaskRow, 'key' | 'contentHash' | 'valid' | 'invalidReason'>[],
): TaskChanges {
  const now = new Map(current.map((t) => [t.key, t]));
  const out: TaskChanges = { kept: [], changed: [], removed: [], invalid: [] };
  for (const task of original) {
    const next = now.get(task.key);
    if (!next) out.removed.push(task.key);
    else if (!next.valid) {
      out.invalid.push({ key: task.key, reason: next.invalidReason ?? 'invalid' });
    } else {
      out.kept.push(task.key);
      if (next.contentHash !== task.contentHash) out.changed.push(task.key);
    }
  }
  return out;
}

@Injectable()
export class DuplicateService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  async duplicate(id: string): Promise<NewExperimentDraft> {
    const [e] = await this.db.select().from(experiments).where(eq(experiments.id, id));
    if (!e) throw notFound(`experiment ${id}`);
    const [original] = await this.db.select().from(suites).where(eq(suites.id, e.suiteId));
    if (!original) throw new Error(`experiment ${id} points at a missing suite ${e.suiteId}`);
    const [source] = await this.db
      .select({ currentSuiteId: suiteSources.currentSuiteId })
      .from(suiteSources)
      .where(eq(suiteSources.path, original.sourcePath));
    const currentId = source?.currentSuiteId ?? original.id;
    const [current] =
      currentId === original.id
        ? [original]
        : await this.db.select().from(suites).where(eq(suites.id, currentId));
    if (!current)
      throw new Error(`suite directory ${original.sourcePath} points at a missing version`);

    const originalTasks = await this.db.select().from(tasks).where(inArray(tasks.id, e.taskIds));
    const byId = new Map(originalTasks.map((t) => [t.id, t]));
    const ordered = e.taskIds.flatMap((taskId) => byId.get(taskId) ?? []);
    const currentTasks = await this.db.select().from(tasks).where(eq(tasks.suiteId, current.id));
    const changes = taskChanges(ordered, currentTasks);

    const versionIds = await this.latestVersionIds([e.baselineVersionId, ...e.candidateVersionIds]);
    return {
      sourceExperimentId: e.id,
      values: {
        name: e.name,
        description: e.description ?? '',
        suiteId: current.id,
        taskKeys: changes.kept,
        baselineVersionId: versionIds[0]!,
        candidateVersionIds: versionIds.slice(1),
        repetitions: e.repetitions,
        concurrency: e.concurrency,
        spendCeilingUsd: e.spendCeilingUsd,
        timeBudgetOverrideS: e.timeBudgetOverrideS,
      },
      changes: {
        suiteVersionFrom: original.versionNumber,
        suiteVersionTo: current.versionNumber,
        changedTasks: changes.changed,
        removedTasks: changes.removed,
        invalidTasks: changes.invalid,
      },
    };
  }

  /** Each version's configuration at its latest version, in order; the originals if two would coincide. */
  private async latestVersionIds(ids: readonly string[]): Promise<string[]> {
    const rows = await this.db
      .select({ id: configurationVersions.id, latestId: latest.id })
      .from(configurationVersions)
      .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
      .innerJoin(
        latest,
        and(
          eq(latest.configurationId, configurations.id),
          eq(latest.version, configurations.latestVersion),
        ),
      )
      .where(inArray(configurationVersions.id, [...ids]));
    const map = new Map(rows.map((r) => [r.id, r.latestId]));
    const mapped = ids.map((id) => map.get(id) ?? id);
    return new Set(mapped).size === mapped.length ? mapped : [...ids];
  }
}
