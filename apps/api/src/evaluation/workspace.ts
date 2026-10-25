/**
 * Rebuilds what file-based scorers read from blobs (plan 8.5, 9.3): the
 * attempt's workspace as it was when the container stopped, and the task's
 * `verify/` folder. Re-scoring therefore never depends on a trial directory
 * surviving its retention period, and grades exactly the stored bytes.
 *
 * Everything is written into a fresh scratch directory under DATA_DIR/tmp
 * that the caller disposes. Files are copied, never linked: a verifier may
 * write to the workspace it is given, and a hard link would let it change a
 * blob every other evaluation reads. COPYFILE_FICLONE makes the copy a
 * reflink where the filesystem supports one (APFS, btrfs, XFS) and a plain
 * copy elsewhere.
 *
 * Paths come from the database, where artifacts_path_ck and task_files_path_ck
 * already refuse absolute paths and `..`; they are checked again here, since
 * an agent chose every artifact name and a write must never leave the root.
 */
import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BlobStore } from '../storage/blob-store.js';
import type { ArtifactRecord, VerifierFileRecord } from './evidence.js';

/** The task folder that holds verifier scripts; params.script is relative to it. */
export const VERIFY_PREFIX = 'verify/';

/** A relative path cut into safe segments, or null when it would leave its root. */
export function safeSegments(path: string): string[] | null {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments;
}

/** `./out//a.csv` → `out/a.csv`: the form artifact paths are stored in. Null when unsafe. */
export function normaliseRelativePath(path: string): string | null {
  return safeSegments(path)?.join('/') ?? null;
}

/** Copies one blob to `root/<relPath>`, creating parents. Refuses to replace anything. */
async function placeBlob(
  store: BlobStore,
  sha256: string,
  root: string,
  relPath: string,
): Promise<void> {
  const segments = safeSegments(relPath);
  if (segments === null) throw new Error(`refusing to write ${JSON.stringify(relPath)}`);
  const target = join(root, ...segments);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(store.path(sha256), target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

/**
 * Writes every artifact that has content into `dir` at its workspace path:
 * fixtures and documents as the agent left them, and the files it made. An
 * artifact skipped for size has no content and is absent, which file_check
 * reports on its own (score.ts). Returns how many files were written.
 */
export async function materialiseWorkspace(
  store: BlobStore,
  artifacts: readonly ArtifactRecord[],
  dir: string,
): Promise<number> {
  await mkdir(dir, { recursive: true });
  let written = 0;
  for (const artifact of artifacts) {
    if (artifact.sha256 === null) continue;
    await placeBlob(store, artifact.sha256, dir, artifact.path);
    written++;
  }
  return written;
}

/** Writes the task's `verify/` files into `dir`, without the `verify/` prefix. */
export async function materialiseVerifyDir(
  store: BlobStore,
  files: readonly VerifierFileRecord[],
  dir: string,
): Promise<number> {
  await mkdir(dir, { recursive: true });
  let written = 0;
  for (const file of files) {
    if (!file.path.startsWith(VERIFY_PREFIX)) continue;
    await placeBlob(store, file.sha256, dir, file.path.slice(VERIFY_PREFIX.length));
    written++;
  }
  return written;
}
