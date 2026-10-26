/**
 * The part of artifact collection (plan 8.5) the workspace (collect.ts) and
 * the home's memories/ (collect-home.ts, Phase 6 P2) share: storing and
 * labelling the files of one walked tree, read only through trial-files.ts.
 *
 * Each regular file becomes an artifact: its content goes to the blob store
 * and its origin comes from comparing it with the input placed at the same
 * path before the run (a fixture, document or home seed, unchanged or
 * modified), or `agent` for anything else. Files over 25 MB are recorded
 * with `too_large` and no content. Links, special files and unreadable names
 * are not artifacts; they are returned for the `collected` event.
 *
 * The budget: each file's apparent size, which is what the store writes, is
 * charged before it is read, and a file past the budget is recorded with
 * `over_budget` and no content. Content the store already holds (an
 * unchanged input, a repeated file) is not charged.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readlink, realpath } from 'node:fs/promises';
import type { ArtifactOrigin, ArtifactRoot, ArtifactSkipReason } from '@hermes-evals/shared';
import { MAX_ARTIFACT_BYTES, readTrialFile, type TrialEntry } from '../../sandbox/trial-files.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { AttemptArtifact } from '../contracts.js';
import type { InputFile } from './materialise.js';

/** An entry of a walk that is not an artifact, as the `collected` event lists it. */
export interface NotCollected {
  path: string;
  kind: string;
  detail?: string;
}

export interface CollectedFiles {
  artifacts: AttemptArtifact[];
  notCollected: NotCollected[];
  /** Content stored for these files. */
  storedBytes: number;
  /** The part of it new to the store: what the budget counts. */
  newBytes: number;
  /** Every path the walk listed that is not a directory: what an input missing from it was deleted by. */
  seen: Set<string>;
}

export const originOf = (input: InputFile | undefined, sha256: string | null): ArtifactOrigin => {
  if (!input) return 'agent';
  return sha256 === input.sha256 ? `${input.source}_unchanged` : `${input.source}_modified`;
};

/**
 * The sha256 of a file too large to store, read in chunks with the same
 * refusals as readTrialFile (no final link, regular files only, and on Linux
 * nothing that resolved outside the root). Null when it cannot be read.
 * Used only to tell whether an oversized input is unchanged.
 */
async function hashLargeFile(root: string, relPath: string): Promise<string | null> {
  const rootReal = await realpath(root);
  let handle;
  try {
    handle = await open(
      `${rootReal}/${relPath}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const landed = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (landed !== null && !landed.startsWith(`${rootReal}/`)) return null;
    if (!(await handle.stat()).isFile()) return null;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Stores and labels the files of one walk.
 *
 * @param readRoot the directory every entry path is relative to, which reads go through
 * @param entries the walk's entries, paths relative to `readRoot`
 * @param root the artifacts' root: `workspace`, or `home` for the memory files
 * @param manifest the inputs placed before the run, by the same relative path
 * @param budgetBytes bytes these files may add to the blob store
 */
export async function collectEntries(
  readRoot: string,
  entries: readonly TrialEntry[],
  root: ArtifactRoot,
  manifest: ReadonlyMap<string, InputFile>,
  blobs: BlobStore,
  budgetBytes: number,
): Promise<CollectedFiles> {
  const out: CollectedFiles = {
    artifacts: [],
    notCollected: [],
    storedBytes: 0,
    newBytes: 0,
    seen: new Set(),
  };

  /** A file recorded without content; an input of the same size is hashed to tell if it changed. */
  const skipped = async (path: string, size: number, reason: ArtifactSkipReason) => {
    const input = manifest.get(path);
    // The size alone proves a change; only a same-sized input is worth reading in full.
    const sha = input && input.size === size ? await hashLargeFile(readRoot, path) : null;
    out.artifacts.push({
      root,
      path,
      origin: originOf(input, sha),
      size,
      sha256: null,
      skippedReason: reason,
    });
  };
  const overBudget = (size: number) => out.newBytes + size > budgetBytes;

  for (const entry of entries) {
    if (entry.kind === 'dir') continue;
    out.seen.add(entry.path);
    if (entry.kind === 'symlink') {
      out.notCollected.push({ path: entry.path, kind: 'symlink', detail: entry.target });
    } else if (entry.kind === 'special') {
      out.notCollected.push({ path: entry.path, kind: entry.type });
    } else if (entry.kind === 'unreadable') {
      out.notCollected.push({ path: entry.path, kind: 'unreadable', detail: entry.reason });
    } else if (entry.size > MAX_ARTIFACT_BYTES) {
      await skipped(entry.path, entry.size, 'too_large');
    } else if (overBudget(entry.size) && manifest.get(entry.path)?.size !== entry.size) {
      // Not read at all: only an input that may be unchanged is worth reading past the budget.
      await skipped(entry.path, entry.size, 'over_budget');
    } else {
      const read = await readTrialFile(readRoot, entry.path);
      if (read.ok) {
        const fresh = !(await blobs.exists(read.sha256));
        if (fresh && overBudget(read.content.length)) {
          await skipped(entry.path, entry.size, 'over_budget');
          continue;
        }
        const ref = await blobs.putBuffer(read.content);
        out.storedBytes += ref.size;
        if (fresh) out.newBytes += ref.size;
        out.artifacts.push({
          root,
          path: entry.path,
          origin: originOf(manifest.get(entry.path), ref.sha256),
          size: ref.size,
          sha256: ref.sha256,
          skippedReason: null,
        });
      } else if (read.reason === 'too_large') {
        await skipped(entry.path, entry.size, 'too_large');
      } else {
        out.notCollected.push({ path: entry.path, kind: read.reason, detail: read.detail });
      }
    }
  }
  return out;
}
