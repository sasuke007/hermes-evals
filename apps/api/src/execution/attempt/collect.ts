/**
 * Artifact collection (plan 8.5), run after the container is removed so
 * nothing changes under the walk. The agent controls every name, link and
 * file type in the workspace, and the worker reads it in its own view, where
 * the trials and data volumes hold every other attempt and the blob store.
 * So it is read only through trial-files.ts: an lstat walk that never follows
 * a link, and reads that refuse links, FIFOs, devices and anything that
 * resolves outside the workspace.
 *
 * Each regular file becomes an artifact: its content goes to the blob store
 * and its origin comes from comparing it with the inputs copied in before the
 * run (fixture or document, unchanged or modified), or `agent` for anything
 * else. Files over 25 MB are recorded with `too_large` and no content.
 * Links, special files and unreadable names are not artifacts; the
 * `collected` event lists them, with the inputs the agent deleted.
 *
 * What one attempt may add to the blob store is bounded too
 * (MAX_COLLECTED_BYTES): each file's apparent size, which is what the store
 * writes, is charged before it is read, and a file past the budget is
 * recorded with `over_budget` and no content. The disk cap the trial ran
 * under counts allocated blocks, so without this, sparse files would turn a
 * few megabytes on the trials volume into a hundred gigabytes of blobs on
 * the disk Postgres shares. Content the store already holds (an unchanged
 * input, a repeated file) is not charged.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readlink, realpath } from 'node:fs/promises';
import type { ArtifactOrigin, ArtifactSkipReason } from '@hermes-evals/shared';
import {
  MAX_ARTIFACT_BYTES,
  MAX_COLLECTED_BYTES,
  readTrialFile,
  walkTrialTree,
} from '../../sandbox/trial-files.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { AttemptArtifact, AttemptEventInput } from '../contracts.js';
import type { InputFile } from './materialise.js';

/** Entries the `collected` event lists by name; the rest are counted. */
const MAX_LISTED = 50;

export interface Collection {
  artifacts: AttemptArtifact[];
  /** The `collected` platform event. */
  event: AttemptEventInput;
}

const originOf = (input: InputFile | undefined, sha256: string | null): ArtifactOrigin => {
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

/** Walks the workspace, stores what can be stored, and labels every file. */
export async function collectWorkspace(
  workspace: string,
  manifest: ReadonlyMap<string, InputFile>,
  blobs: BlobStore,
  now = Date.now,
  budgetBytes = MAX_COLLECTED_BYTES,
): Promise<Collection> {
  const tree = await walkTrialTree(workspace);
  const artifacts: AttemptArtifact[] = [];
  const notCollected: Array<{ path: string; kind: string; detail?: string }> = [];
  /** Content stored for this attempt, and the part of it new to the store (what the budget counts). */
  let storedBytes = 0;
  let newBytes = 0;
  const seen = new Set<string>();

  /** A file recorded without content; an input of the same size is hashed to tell if it changed. */
  const skipped = async (path: string, size: number, reason: ArtifactSkipReason) => {
    const input = manifest.get(path);
    // The size alone proves a change; only a same-sized input is worth reading in full.
    const sha = input && input.size === size ? await hashLargeFile(workspace, path) : null;
    const origin: ArtifactOrigin = input
      ? sha === input.sha256
        ? `${input.source}_unchanged`
        : `${input.source}_modified`
      : 'agent';
    artifacts.push({ path, origin, size, sha256: null, skippedReason: reason });
  };
  const overBudget = (size: number) => newBytes + size > budgetBytes;

  for (const entry of tree.entries) {
    if (entry.kind === 'dir') continue;
    seen.add(entry.path);
    if (entry.kind === 'symlink') {
      notCollected.push({ path: entry.path, kind: 'symlink', detail: entry.target });
    } else if (entry.kind === 'special') {
      notCollected.push({ path: entry.path, kind: entry.type });
    } else if (entry.kind === 'unreadable') {
      notCollected.push({ path: entry.path, kind: 'unreadable', detail: entry.reason });
    } else if (entry.size > MAX_ARTIFACT_BYTES) {
      await skipped(entry.path, entry.size, 'too_large');
    } else if (overBudget(entry.size) && manifest.get(entry.path)?.size !== entry.size) {
      // Not read at all: only an input that may be unchanged is worth reading past the budget.
      await skipped(entry.path, entry.size, 'over_budget');
    } else {
      const read = await readTrialFile(workspace, entry.path);
      if (read.ok) {
        const fresh = !(await blobs.exists(read.sha256));
        if (fresh && overBudget(read.content.length)) {
          await skipped(entry.path, entry.size, 'over_budget');
          continue;
        }
        const ref = await blobs.putBuffer(read.content);
        storedBytes += ref.size;
        if (fresh) newBytes += ref.size;
        artifacts.push({
          path: entry.path,
          origin: originOf(manifest.get(entry.path), ref.sha256),
          size: ref.size,
          sha256: ref.sha256,
          skippedReason: null,
        });
      } else if (read.reason === 'too_large') {
        await skipped(entry.path, entry.size, 'too_large');
      } else {
        notCollected.push({ path: entry.path, kind: read.reason, detail: read.detail });
      }
    }
  }
  const overBudgetPaths = artifacts
    .filter((a) => a.skippedReason === 'over_budget')
    .map((a) => a.path);

  const deleted = [...manifest.keys()].filter((path) => !seen.has(path)).sort();
  const event: AttemptEventInput = {
    ts: now(),
    type: 'platform',
    payload: {
      type: 'platform',
      subtype: 'collected',
      files: artifacts.length,
      stored: artifacts.filter((a) => a.sha256 !== null).length,
      stored_bytes: storedBytes,
      new_bytes: newBytes,
      too_large: artifacts.filter((a) => a.skippedReason === 'too_large').map((a) => a.path),
      ...(overBudgetPaths.length > 0
        ? {
            budget_exceeded: true,
            budget_bytes: budgetBytes,
            over_budget: overBudgetPaths.slice(0, MAX_LISTED),
            over_budget_count: overBudgetPaths.length,
          }
        : {}),
      agent_files: artifacts.filter((a) => a.origin === 'agent').length,
      not_collected: notCollected.slice(0, MAX_LISTED),
      not_collected_count: notCollected.length,
      deleted_inputs: deleted.slice(0, MAX_LISTED),
      deleted_input_count: deleted.length,
      truncated: tree.truncated,
    },
  };
  return { artifacts, event };
}
