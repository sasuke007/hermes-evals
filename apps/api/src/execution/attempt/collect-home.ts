/**
 * Collection of the agent's memory files (Phase 6 P2, plan 18.2): after the
 * container is removed and BEFORE the home is deleted, the runner collects
 * home/memories/ the way collect.ts collects the workspace, and nothing else
 * of the home. The agent controls every name, link and file type there too,
 * so it is read only through trial-files.ts (walkTrialTree, readTrialFile:
 * lstat, no link followed, regular files only, nothing outside the root),
 * with the workspace's limits (MAX_ARTIFACT_BYTES per file, and what is left
 * of the attempt's MAX_COLLECTED_BYTES after the workspace).
 *
 * Each regular file becomes an artifact with root `home` and a path relative
 * to the home (`memories/MEMORY.md`), except the memory tool's empty `*.lock`
 * files, which are skipped (collect-files.ts isMemoryLockFile, Phase 6 #2).
 * Each is labelled against the home seeds the way workspace files are
 * labelled against the fixtures: `home_seed_unchanged`, `home_seed_modified`,
 * or `agent` for a file no seed placed. A missing memories/ folder (memory
 * off, nothing written, no seed) is no artifact and no error.
 */
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME_MEMORIES_DIR } from '@hermes-evals/shared';
import { restoreOwnerAccess, walkTrialTree } from '../../sandbox/trial-files.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { AttemptArtifact } from '../contracts.js';
import { collectEntries, type NotCollected } from './collect-files.js';
import type { InputFile } from './materialise.js';

/** A home seed as materialised, keyed in the seed manifest by its home-relative path. */
export interface HomeSeedInput {
  sha256: string;
  size: number;
}

export interface HomeCollection {
  /** Each with root `home`, path relative to the home, sorted by path. */
  artifacts: AttemptArtifact[];
  /** Bytes new to the blob store, which the attempt's collection budget is charged with. */
  newBytes: number;
  /**
   * Entries under memories/ that are not artifacts (links with their target
   * text, special files, unreadable names), home-relative, for the
   * `collected` event beside the workspace's own.
   */
  notCollected: NotCollected[];
  /** Seeds the agent deleted, home-relative, sorted. */
  deletedSeeds: string[];
  /** The walk stopped at its entry cap (COLLECT_LIMITS), so later files were not listed. */
  truncated: boolean;
}

const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'error';

/** Only the home's own directory: restoreOwnerAccess on it alone, never inside it. */
const HOME_ROOT_ONLY = { maxDepth: 0, maxEntries: 0 };

/**
 * Walks `<home>/memories/` and stores what can be stored (plan 8.5's rules),
 * labelling every file against `seeds` (home-relative path → seed).
 * `budgetBytes` is what the workspace collection left of MAX_COLLECTED_BYTES.
 *
 * @param home the attempt's home directory on the worker (AttemptPlan.paths.home)
 * @param seeds the home seeds materialised before launch, by home-relative path
 * @param blobs the blob store the artifacts' content is written to
 * @param budgetBytes bytes this collection may add to the blob store
 */
export async function collectHomeMemories(
  home: string,
  seeds: ReadonlyMap<string, HomeSeedInput>,
  blobs: BlobStore,
  budgetBytes: number,
): Promise<HomeCollection> {
  const empty = (notCollected: NotCollected[]): HomeCollection => ({
    artifacts: [],
    newBytes: 0,
    notCollected,
    deletedSeeds: [...seeds.keys()].sort(),
    truncated: false,
  });
  // The agent shares the worker's uid, so it could have taken the owner's
  // permissions on /opt/data itself; give back the home's own, then look.
  await restoreOwnerAccess(home, HOME_ROOT_ONLY);
  const dir = join(home, HOME_MEMORIES_DIR);
  let stat;
  try {
    stat = await lstat(dir);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return empty([]);
    return empty([{ path: HOME_MEMORIES_DIR, kind: 'unreadable', detail: code }]);
  }
  // memories/ itself must be a real directory: a link there would be followed by every read below.
  if (stat.isSymbolicLink()) {
    const target = await readlink(dir).catch(() => '');
    return empty([{ path: HOME_MEMORIES_DIR, kind: 'symlink', detail: target }]);
  }
  if (!stat.isDirectory()) {
    return empty([{ path: HOME_MEMORIES_DIR, kind: 'not_directory' }]);
  }
  await restoreOwnerAccess(dir);
  const tree = await walkTrialTree(dir);
  const entries = tree.entries.map((e) => ({
    ...e,
    path: e.path === '.' ? HOME_MEMORIES_DIR : `${HOME_MEMORIES_DIR}/${e.path}`,
  }));
  const manifest = new Map<string, InputFile>(
    [...seeds].map(([path, seed]) => [
      path,
      { source: 'home_seed', sha256: seed.sha256, size: seed.size },
    ]),
  );
  // Read relative to the home, so each read's real path is checked against the home itself.
  const files = await collectEntries(home, entries, 'home', manifest, blobs, budgetBytes);
  return {
    artifacts: [...files.artifacts].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    newBytes: files.newBytes,
    notCollected: files.notCollected,
    deletedSeeds: [...seeds.keys()].filter((path) => !files.seen.has(path)).sort(),
    truncated: tree.truncated,
  };
}
