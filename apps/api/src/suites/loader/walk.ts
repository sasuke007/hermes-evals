/**
 * Lists suite directories without trusting them. Suites are authored by the
 * user, but a suite folder can still hold a link to /data or a FIFO, and the
 * loader runs in the worker, which mounts blobs and trials. So, as for trial
 * workspaces (sandbox/trial-files.ts): lstat only, never follow a link, never
 * open anything but a regular file, bound depth and entry count.
 *
 * Names starting with '.' are skipped at every level without being entered:
 * editors and Finder leave .DS_Store, .git and swap files in suite folders,
 * and none of them is part of a task.
 */
import { lstat, opendir } from 'node:fs/promises';
import type { SpecialType } from '../../sandbox/trial-files.js';

export type SuiteEntry =
  | { path: string; kind: 'file'; size: number }
  | { path: string; kind: 'dir'; entered: boolean }
  | { path: string; kind: 'symlink' }
  | { path: string; kind: 'special'; type: SpecialType }
  | { path: string; kind: 'unreadable'; reason: string };

export interface SuiteTree {
  /** Sorted by path; paths are relative to the walked root, '/'-separated. */
  entries: SuiteEntry[];
  /** Set when the entry cap ended the walk early. */
  truncated: boolean;
}

export interface SuiteWalkLimits {
  maxDepth: number;
  maxEntries: number;
}

export const isHiddenName = (name: string): boolean => name.startsWith('.');

const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'error';

function specialType(stat: {
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): SpecialType {
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return 'device';
  return 'unknown';
}

/** A name read as bytes, and whether those bytes are exactly its UTF-8 text. */
function decodeName(raw: Buffer): { text: string; exact: boolean } {
  const text = raw.toString('utf8');
  return { text, exact: Buffer.from(text, 'utf8').equals(raw) };
}

/**
 * Walks `root` with lstat. Throws only when `root` itself cannot be listed;
 * anything below it that cannot be read is an `unreadable` entry.
 */
export async function walkSuiteDir(root: string, limits: SuiteWalkLimits): Promise<SuiteTree> {
  const entries: SuiteEntry[] = [];
  const tree: SuiteTree = { entries, truncated: false };
  // Byte paths, so a name that is not UTF-8 is still found and reported.
  const stack: { abs: Buffer; rel: string; depth: number }[] = [
    { abs: Buffer.from(root), rel: '', depth: 0 },
  ];

  walk: while (stack.length > 0) {
    const dir = stack.pop()!;
    let handle;
    try {
      handle = await opendir(dir.abs, { encoding: 'buffer' as BufferEncoding });
    } catch (err) {
      if (!dir.rel) throw err;
      entries.push({ path: dir.rel, kind: 'unreadable', reason: errorCode(err) });
      continue;
    }
    try {
      for await (const dirent of handle) {
        const raw = dirent.name as unknown as Buffer;
        const name = decodeName(raw);
        if (isHiddenName(name.text)) continue;
        if (entries.length >= limits.maxEntries) {
          tree.truncated = true;
          break walk;
        }
        const rel = dir.rel ? `${dir.rel}/${name.text}` : name.text;
        const abs = Buffer.concat([dir.abs, Buffer.from('/'), raw]);
        if (!name.exact) {
          entries.push({ path: rel, kind: 'unreadable', reason: 'name is not valid UTF-8' });
          continue;
        }
        let stat;
        try {
          stat = await lstat(abs);
        } catch (err) {
          if (errorCode(err) !== 'ENOENT') {
            entries.push({ path: rel, kind: 'unreadable', reason: errorCode(err) });
          }
          continue;
        }
        if (stat.isSymbolicLink()) {
          entries.push({ path: rel, kind: 'symlink' });
        } else if (stat.isDirectory()) {
          const entered = dir.depth + 1 < limits.maxDepth;
          entries.push({ path: rel, kind: 'dir', entered });
          if (entered) stack.push({ abs, rel, depth: dir.depth + 1 });
        } else if (stat.isFile()) {
          entries.push({ path: rel, kind: 'file', size: stat.size });
        } else {
          entries.push({ path: rel, kind: 'special', type: specialType(stat) });
        }
      }
    } catch (err) {
      // The directory changed or vanished while it was listed.
      entries.push({ path: dir.rel || '.', kind: 'unreadable', reason: errorCode(err) });
    } finally {
      await handle.close().catch(() => {});
    }
  }
  entries.sort((a, b) => comparePaths(a.path, b.path));
  return tree;
}

/** Byte order of the UTF-8 paths, the order hashes are computed in. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** One non-hidden entry directly under SUITES_DIR. */
export interface SuitesDirEntry {
  name: string;
  kind: 'dir' | 'symlink';
}

/**
 * The candidate suite directories: every non-hidden directory, and every
 * non-hidden link (reported, never followed), directly under `suitesDir`.
 * Plain files there (a README) are ignored. Throws when `suitesDir` is not a
 * readable directory, so a missing mount never marks every suite missing.
 */
export async function listSuitesDir(suitesDir: string): Promise<SuitesDirEntry[]> {
  const stat = await lstat(suitesDir);
  if (!stat.isDirectory()) throw new Error(`SUITES_DIR ${suitesDir} is not a directory`);
  const out: SuitesDirEntry[] = [];
  const handle = await opendir(suitesDir);
  try {
    for await (const dirent of handle) {
      if (isHiddenName(dirent.name)) continue;
      const entry = await lstat(`${suitesDir}/${dirent.name}`).catch(() => null);
      if (!entry) continue;
      if (entry.isDirectory()) out.push({ name: dirent.name, kind: 'dir' });
      else if (entry.isSymbolicLink()) out.push({ name: dirent.name, kind: 'symlink' });
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return out.sort((a, b) => comparePaths(a.name, b.name));
}
