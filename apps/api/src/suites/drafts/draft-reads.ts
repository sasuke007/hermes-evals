/**
 * Reads shared by the draft services: the draft of a folder (or 404), the
 * rows its view is built from, and the view itself.
 */
import type { SuiteDraftView } from '@hermes-evals/shared';
import type { AppDb } from '../../database/types.js';
import { notFound } from '../http-errors.js';
import { sourceOf, suiteById, tasksOf } from '../suites.queries.js';
import {
  draftByFolder,
  folderHoldingName,
  highestVersion,
  loadDraft,
  tasksById,
  type DraftRow,
} from './draft-store.js';
import { draftView, type DraftViewInput } from './draft-views.js';
import { draftBase } from './draft-writer.js';

export async function requireDraft(db: AppDb, folder: string): Promise<DraftRow> {
  const draft = await draftByFolder(db, folder);
  if (!draft) throw notFound(`draft of ${folder}`);
  return draft;
}

/** Everything a view of `draft` reads. */
export async function viewInput(db: AppDb, draft: DraftRow, now: Date): Promise<DraftViewInput> {
  const [stored, base, highest, source] = await Promise.all([
    loadDraft(db, draft),
    draftBase(db, draft),
    highestVersion(db, draft.sourcePath),
    sourceOf(db, draft.sourcePath),
  ]);
  let current: DraftViewInput['current'] = null;
  if (
    draft.origin === 'edit' &&
    source?.currentSuiteId &&
    source.currentSuiteId !== draft.baseSuiteId
  ) {
    const suite = await suiteById(db, source.currentSuiteId);
    if (suite) current = { suite, tasks: await tasksOf(db, [suite.id]) };
  }
  const restored = await tasksById(
    db,
    stored.tasks.flatMap((t) => (t.restoredFromTaskId ? [t.restoredFromTaskId] : [])),
  );
  return {
    stored,
    base,
    current,
    restored,
    nextVersion: highest + 1,
    nameHolder: draft.origin === 'edit' ? null : await folderHoldingName(db, draft.name),
    now,
  };
}

export async function draftViewOf(db: AppDb, draft: DraftRow, now: Date): Promise<SuiteDraftView> {
  return draftView(await viewInput(db, draft, now));
}
