/**
 * Saving a suite draft as the folder's next version (plan 4.6), in the
 * worker, under the folder's advisory lock and in one transaction, the same
 * unit a load of the folder is (loader/suite-loader.ts):
 *
 * 1. Conflict check. A draft of a folder on disk needs the folder's current
 *    version to be its base (else `version_moved`), and the files on disk
 *    to hash to the base's content hash and hold the base's task folders
 *    (else they are loaded first, which creates a version, and the conflict
 *    is `disk_changed`). A new suite needs its folder and its name free.
 * 2. Staging: the folder built in SUITES_DIR/.draft-<id>/ (stage.ts), after
 *    listing the live folder (folderListing).
 * 3. Loading: the staging folder read with the loader, self-checks included
 *    (the steps `loading` and `self_checks`). A folder-level failure
 *    (suite.yaml or a task.yaml does not parse, an unsafe file, a name
 *    another folder holds) stops here: disk unchanged, draft kept.
 * 4. Moving: the conflict check again, and the live folder listed again, so
 *    an edit by hand made since staging (hand edits take no lock) stops the
 *    save instead of being lost; then the live folder renamed aside,
 *    staging renamed into place, and that read recorded under the folder's
 *    path, as the load of the folder would record it: the next version, or
 *    `unchanged`. When the staging folder hashes as the live one, nothing
 *    is moved at all. Any failure from here puts the live folder back.
 * 5. The draft deleted, with its tasks and files, in the same transaction;
 *    the old folder removed once it commits.
 *
 * The API claims the draft (save_started_at) before it sends the job, and
 * the job carries the claim: a save acts only on the claim it was sent for,
 * re-read under the lock, so two saves of one draft never both write.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DraftConflictSchema,
  DraftSaveResultSchema,
  SAVE_STEPS,
  SuiteLoadErrorViewSchema,
  type DraftSaveProgress,
  type SaveStep,
} from '@hermes-evals/shared';
import { suiteDrafts } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { VerifierUnavailable } from '../../scoring/verifier-runner.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { loadDraft, type DraftRow } from '../drafts/draft-store.js';
import { renderSuiteYaml } from '../drafts/suite-yaml.js';
import { changeSetView } from '../loader/changes.js';
import { LOADER_VERSION, SUITE_YAML } from '../loader/limits.js';
import {
  lockDirectory,
  nameHolder,
  nameTakenError,
  persistSuite,
  type PersistDeps,
} from '../loader/persist.js';
import {
  readSuiteDirectory,
  type DirectoryRead,
  type ReadSuiteDeps,
} from '../loader/read-suite.js';
import type { LoaderLogger } from '../loader/suite-loader.js';
import { locatedError, toErrorView, type LocatedError } from '../loader/yaml-source.js';
import { sourceOf, suiteById } from '../suites.queries.js';
import { suiteDisplayPath } from '../views/format.js';
import { suiteRef } from '../views/suite-views.js';
import { draftBase } from '../drafts/draft-writer.js';
import { baseFilesOf, baseKeysOf, conflictOf } from './conflict.js';
import { buildStaging, folderListing } from './stage.js';
import { asideName, stagingName, SuitesDir } from './suites-dir.js';

/** The job's output, which the API turns into 200, 409, 422 or 503. */
export const SaveDraftOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), result: DraftSaveResultSchema }),
  z.object({ kind: z.literal('conflict'), conflict: DraftConflictSchema }),
  z.object({
    kind: z.literal('not_saved'),
    step: z.enum(SAVE_STEPS),
    error: SuiteLoadErrorViewSchema,
  }),
  /** The draft is gone, or another save holds it: this job's claim is not the draft's. */
  z.object({ kind: z.literal('gone') }),
  /** A verifier could not be run at all (docker-guard down): nothing was saved. */
  z.object({ kind: z.literal('unavailable'), message: z.string() }),
]);
export type SaveDraftOutput = z.infer<typeof SaveDraftOutputSchema>;

export interface SaveDraftDeps {
  db: AppDb;
  blobs: BlobStore;
  /** SUITES_DIR, which the worker mounts read-write for this job alone. */
  suitesDir: string;
  logger: LoaderLogger;
  loaderVersion?: number;
  now?: () => Date;
  /** Records the save's step on the draft (SaveSteps); recordProgress by default. */
  progress?: (draftId: string, claim: Date, progress: DraftSaveProgress) => Promise<void>;
}

/** Writes the save's step where the draft view reads it, outside the save's transaction. */
export function recordProgress(db: AppDb) {
  return async (draftId: string, claim: Date, progress: DraftSaveProgress): Promise<void> => {
    await db
      .update(suiteDrafts)
      .set({ saveProgress: progress })
      .where(and(eq(suiteDrafts.id, draftId), eq(suiteDrafts.saveStartedAt, claim)));
  };
}

/** Releases the draft for edits again after a save that did not save. */
async function releaseClaim(db: AppDb, draftId: string, claim: Date): Promise<void> {
  await db
    .update(suiteDrafts)
    .set({ saveStartedAt: null, saveProgress: null })
    .where(and(eq(suiteDrafts.id, draftId), eq(suiteDrafts.saveStartedAt, claim)));
}

const notSaved = (step: SaveStep, error: LocatedError): SaveDraftOutput => ({
  kind: 'not_saved',
  step,
  error: toErrorView(error),
});

/** A failure of the folder itself, located at the folder. */
const folderError = (message: string): LocatedError => locatedError('.', '', null, message);

/** Runs one save; throws only for what no output describes (the job then fails). */
export async function saveSuiteDraft(
  job: { draftId: string; claim: string },
  deps: SaveDraftDeps,
): Promise<SaveDraftOutput> {
  const claim = new Date(job.claim);
  const dir = await SuitesDir.open(deps.suitesDir);
  const report = (step: SaveStep, selfChecks: DraftSaveProgress['selfChecks'] = null): void => {
    const progress = { startedAt: claim.toISOString(), step, selfChecks };
    void (deps.progress ?? recordProgress(deps.db))(job.draftId, claim, progress).catch(
      (err: unknown) =>
        deps.logger.warn({ err, draftId: job.draftId }, 'save progress not recorded'),
    );
  };
  const [first] = await deps.db.select().from(suiteDrafts).where(eq(suiteDrafts.id, job.draftId));
  if (!first || first.saveStartedAt?.getTime() !== claim.getTime()) return { kind: 'gone' };

  const staging = stagingName(first.id);
  const aside = asideName(first.id);
  let output: SaveDraftOutput | null = null;
  try {
    const run = await deps.db.transaction(async (tx) => {
      await lockDirectory(tx, first.sourcePath);
      // Re-read under the lock: a save that waited on another may find its draft gone.
      const [draft] = await tx.select().from(suiteDrafts).where(eq(suiteDrafts.id, first.id));
      if (!draft || draft.saveStartedAt?.getTime() !== claim.getTime()) {
        return { output: { kind: 'gone' } as const, moved: false };
      }
      return saveLocked(tx, draft, dir, deps, report);
    });
    output = run.output;
    if (run.moved) {
      await dir.remove(aside).catch((err: unknown) => {
        deps.logger.warn({ err, aside }, 'the old folder of a saved draft was not removed');
      });
    }
    return output;
  } catch (err) {
    if (err instanceof VerifierUnavailable) {
      output = { kind: 'unavailable', message: err.message };
      return output;
    }
    throw err;
  } finally {
    await dir.remove(staging).catch(() => {});
    if (output?.kind !== 'saved' && output?.kind !== 'gone') {
      await releaseClaim(deps.db, first.id, claim).catch((err: unknown) => {
        deps.logger.warn({ err, draftId: first.id }, 'save claim not released');
      });
    }
  }
}

interface LockedRun {
  output: SaveDraftOutput;
  /** The live folder was set aside and replaced; remove it once the transaction commits. */
  moved: boolean;
}

async function saveLocked(
  tx: AppTx,
  draft: DraftRow,
  dir: SuitesDir,
  deps: SaveDraftDeps,
  report: (step: SaveStep, selfChecks?: DraftSaveProgress['selfChecks']) => void,
): Promise<LockedRun> {
  const folder = draft.sourcePath;
  const now = deps.now ?? (() => new Date());
  const persist: PersistDeps = { db: deps.db, blobs: deps.blobs, now, suitesDir: deps.suitesDir };
  const readDeps: ReadSuiteDeps = {
    loaderVersion: deps.loaderVersion ?? LOADER_VERSION,
    scratch: (prefix) => deps.blobs.scratchDir(prefix),
    now,
  };
  const stopped = (output: SaveDraftOutput): LockedRun => ({ output, moved: false });
  const stored = await loadDraft(tx, draft);
  const based = await draftBase(tx, draft);
  const base = based.suite;
  const aside = asideName(draft.id);

  /**
   * The folder on disk against the base: null while its files hash to the
   * base's content hash and its task folders are the base's tasks (a folder
   * made by hand may hold no file the hash covers). Otherwise the files are
   * loaded as a reload would load them, creating a version, and the answer
   * is the `disk_changed` conflict with it.
   */
  const diskMoved = async (step: SaveStep): Promise<SaveDraftOutput | null> => {
    const disk = await readSuiteDirectory(deps.suitesDir, folder, {
      ...readDeps,
      selfChecks: false,
    });
    if (!disk.ok) return notSaved(step, diskFailure(disk, folder));
    const keys = (tasks: readonly { key: string }[]) =>
      JSON.stringify(tasks.map((t) => t.key).sort());
    if (
      disk.suite.contentHash === base!.contentHash &&
      keys(disk.suite.tasks) === keys(based.tasks)
    )
      return null;
    // Edits on disk that no reload has seen: load them as a reload would, then combine onto them.
    const loaded = await readSuiteDirectory(deps.suitesDir, folder, readDeps);
    if (!loaded.ok) return notSaved(step, diskFailure(loaded, folder));
    const outcome = await persistSuite(tx, persist, loaded.suite);
    if (outcome === null || outcome.outcome === 'missing')
      throw new Error('disk load not recorded');
    if (outcome.outcome === 'error') return notSaved(step, outcome.error);
    const moved = await suiteById(tx, outcome.suiteId);
    return { kind: 'conflict', conflict: await conflictOf(tx, stored, moved!, 'disk_changed') };
  };

  // 1. The conflict check.
  if (draft.origin === 'edit') {
    if (base === null) throw new Error(`draft ${draft.id} has no base version`);
    // A save that stopped between its two renames left the live folder aside: put it back.
    if (!(await dir.exists(folder)) && (await dir.exists(aside))) await dir.move(aside, folder);
    const source = await sourceOf(tx, folder);
    const current = source?.currentSuiteId ? await suiteById(tx, source.currentSuiteId) : null;
    if (current === null || !(await dir.exists(folder))) {
      return stopped(
        notSaved(
          'staging',
          folderError(`${suiteDisplayPath(folder)} is no longer on disk; reload it, then save`),
        ),
      );
    }
    if (current.id !== base.id) {
      const conflict = await conflictOf(tx, stored, current, 'version_moved');
      return stopped({ kind: 'conflict', conflict });
    }
    const moved = await diskMoved('staging');
    if (moved !== null) return stopped(moved);
  } else {
    const source = await sourceOf(tx, folder);
    if ((await dir.exists(folder)) || (source !== null && source.lastOutcome !== 'missing')) {
      return stopped(
        notSaved(
          'staging',
          folderError(
            `${suiteDisplayPath(folder)} already exists; give the new suite another name`,
          ),
        ),
      );
    }
  }

  // 2. Staging.
  report('staging');
  const live = draft.origin === 'edit' ? folder : null;
  const listed = live === null ? null : await folderListing(dir.folder(live));
  const liveYaml =
    live === null ? null : await readFile(join(dir.folder(live), SUITE_YAML), 'utf8');
  const kept = stored.tasks.filter((t) => t.state !== 'removed');
  const suiteYaml = renderSuiteYaml(liveYaml, {
    name: draft.name,
    versionLabel: draft.versionLabel,
    description: draft.description,
    tasks: kept.map((t) => t.key),
  });
  const staging = stagingName(draft.id);
  const baseKeys = baseKeysOf(based, stored);
  await buildStaging({
    dir,
    staging,
    live,
    stored,
    baseKeys,
    baseFiles: await baseFilesOf(tx, based.tasks, stored),
    suiteYaml,
    blobs: deps.blobs,
  });

  // 3. Loading and self-checks, on the staging folder.
  report('loading');
  const read = await readSuiteDirectory(deps.suitesDir, staging, {
    ...readDeps,
    onSelfCheck: (done, total) => report('self_checks', { done, total }),
  });
  if (!read.ok) {
    if ('error' in read) return stopped(notSaved('loading', read.error));
    throw new Error(`the staging folder ${staging} could not be read`);
  }
  const holder = await nameHolder(tx, read.suite.yaml.name, folder);
  if (holder !== null) return stopped(notSaved('loading', nameTakenError(read.suite, holder)));

  // 4. Moving, once the folder on disk is still the one staged from.
  report('moving');
  if (live !== null) {
    const moved = await diskMoved('moving');
    if (moved !== null) return stopped(moved);
    if ((await folderListing(dir.folder(live))).join('\n') !== listed!.join('\n')) {
      return stopped(
        notSaved(
          'moving',
          folderError(`${suiteDisplayPath(folder)} changed on disk during the save; save again`),
        ),
      );
    }
  }
  const suite = { ...read.suite, path: folder };
  const same = base !== null && read.suite.contentHash === base.contentHash;
  let setAside = false;
  let placed = false;
  try {
    if (!same) {
      if (live !== null) {
        await dir.remove(aside);
        await dir.move(live, aside);
        setAside = true;
      }
      await dir.move(staging, folder);
      placed = true;
    }
    const outcome = await persistSuite(tx, persist, suite);
    if (outcome === null || outcome.outcome === 'missing' || outcome.outcome === 'error') {
      throw new Error(
        `the saved folder did not load: ${outcome?.outcome === 'error' ? outcome.error.message : 'missing'}`,
      );
    }
    // 5. The draft is gone, with its tasks and files.
    await tx.delete(suiteDrafts).where(eq(suiteDrafts.id, draft.id));
    const version = await suiteById(tx, outcome.suiteId);
    const invalid = suite.tasks
      .filter((t) => !t.valid)
      .map((t) => ({ key: t.key, reason: t.invalidReason ?? 'invalid' }));
    return {
      moved: setAside,
      output: {
        kind: 'saved',
        result: {
          outcome: outcome.outcome,
          suite: suiteRef(version!),
          changes: changeSetView(outcome.changes),
          taskCount: suite.tasks.length,
          validCount: suite.tasks.length - invalid.length,
          invalid,
        },
      },
    };
  } catch (err) {
    // Put the live folder back; the transaction rolls back and the draft is kept.
    try {
      if (placed) await dir.move(folder, staging);
      if (setAside) await dir.move(aside, live!);
    } catch (undo) {
      deps.logger.error(
        { err: undo, folder, aside },
        'the live folder of a failed save was not put back',
      );
    }
    throw err;
  }
}

/** Why the folder on disk cannot be compared or loaded. */
function diskFailure(read: Exclude<DirectoryRead, { ok: true }>, folder: string): LocatedError {
  if ('missing' in read) {
    return folderError(`${suiteDisplayPath(folder)} is no longer on disk; reload it, then save`);
  }
  if ('error' in read) return read.error;
  return folderError(`${suiteDisplayPath(folder)} could not be read`);
}
