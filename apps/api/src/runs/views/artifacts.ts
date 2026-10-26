/**
 * The inspector's Artifacts section (UI_FLOWS 18, plan 8.5): the files the
 * worker collected from the workspace after the container was removed, and
 * from the home's memories/ before the home was deleted (Phase 6 P2: root
 * `home`, which the Files tab shows as a Memory group), labelled by origin,
 * with the first rows of each small CSV or TSV.
 *
 * Every name and byte here was written by the agent. The views only describe
 * them; downloads go out as attachments that a browser saves rather than
 * renders (runs-read.controller.ts).
 */
import type { ArtifactsView, ArtifactView, TablePreview } from '@hermes-evals/shared';
import { MAX_ARTIFACT_BYTES } from '../../sandbox/trial-files.js';
import { INLINE_PREVIEW_LIMIT } from '../../suites/suite-tasks.service.js';
import { tabularFormatOf } from '../../suites/views/table.js';
import type { ArtifactRecord, AttemptRecord } from './rows.js';

/** CSV and TSV artifacts up to this size carry their preview inside the run detail. */
export const ARTIFACT_INLINE_PREVIEW_LIMIT = INLINE_PREVIEW_LIMIT;

/** Whether an artifact's preview is sent inline: stored, tabular and small. */
export const hasInlinePreview = (a: Pick<ArtifactRecord, 'path' | 'sha256' | 'size'>): boolean =>
  a.sha256 !== null && tabularFormatOf(a.path) !== null && a.size <= ARTIFACT_INLINE_PREVIEW_LIMIT;

/**
 * Artifact paths are stored relative to their root; the view names them from
 * the trial root: `workspace/summary.csv`, `home/memories/MEMORY.md`.
 */
export const artifactDisplayPath = (a: Pick<ArtifactRecord, 'root' | 'path'>): string =>
  `${a.root}/${a.path}`;

export function artifactView(a: ArtifactRecord, preview: TablePreview | null): ArtifactView {
  return {
    id: a.id,
    root: a.root,
    path: artifactDisplayPath(a),
    origin: a.origin,
    sizeBytes: a.size,
    sha256: a.sha256,
    skippedReason: a.skippedReason,
    preview,
  };
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The files of the shown attempt, by path. Nothing is collected until the
 * attempt ends; a cancelled or failed attempt's workspace is collected as
 * it was left, so the note says it is partial. Recovery ends a lost
 * attempt without a worker to collect it, so an empty list there says
 * nothing about what the agent wrote.
 */
export function artifactsView(
  attempt: Pick<AttemptRecord, 'status' | 'errorCategory'> | null,
  items: readonly ArtifactRecord[],
  previews: ReadonlyMap<string, TablePreview | null>,
): ArtifactsView {
  if (!attempt || attempt.status === 'running') {
    return { items: [], note: 'collected when the run ends', agentWroteNothing: false };
  }
  if (items.length === 0 && attempt.errorCategory === 'worker_lost') {
    return {
      items: [],
      note: 'not collected · the worker was lost before it could collect the workspace',
      agentWroteNothing: false,
    };
  }
  const notes: string[] = [];
  if (attempt.status === 'cancelled') notes.push('partial · written before the cancel');
  if (attempt.status === 'execution_error') notes.push('partial · collected after the run stopped');
  const skipped = items.filter((a) => a.skippedReason !== null).length;
  if (skipped > 0) {
    notes.push(
      `${plural(skipped, 'file')} over ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB listed without content`,
    );
  }
  // By displayed path: the workspace's files, then the home's (`home/` sorts first, so by root first).
  const shown = (a: ArtifactRecord) => [a.root === 'workspace' ? 0 : 1, a.path] as const;
  const sorted = [...items].sort((a, b) => {
    const [ra, pa] = shown(a);
    const [rb, pb] = shown(b);
    return ra - rb || (pa < pb ? -1 : pa > pb ? 1 : 0);
  });
  return {
    items: sorted.map((a) => artifactView(a, previews.get(a.id) ?? null)),
    note: notes.length ? notes.join(' · ') : null,
    // About the workspace only: the inspector's note reads "The agent wrote no files in its workspace".
    agentWroteNothing: !items.some((a) => a.root === 'workspace' && a.origin === 'agent'),
  };
}
