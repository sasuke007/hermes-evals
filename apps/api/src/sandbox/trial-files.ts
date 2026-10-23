/**
 * Reads what a trial left behind without trusting it.
 *
 * A trial's home and workspace sit on the trials volume, which the worker also
 * mounts, so anything the agent created there is read by the worker in the
 * worker's own view of the filesystem. The agent controls every name, link and
 * file type in that tree. The rules here:
 *
 * - Never follow a symbolic link. A link to `/data` or `/trials` resolves to
 *   suites, blobs and other attempts on the worker side. Links are listed with
 *   their target text and nothing more.
 * - Never open anything but a regular file, and open it without following a
 *   final link and without blocking, so a FIFO cannot hang the worker.
 * - Bound the walk by depth and entry count, and reads by size.
 * - Names are bytes. A name that is not valid UTF-8 is listed but not read,
 *   because no string names it exactly.
 *
 * Content is read only after the container is removed, so nothing changes
 * under the walk. The disk watchdog walks while the trial runs; it reads
 * metadata only.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';

export interface WalkLimits {
  /** Directories deeper than this are listed but not entered. */
  maxDepth: number;
  /** The walk stops after this many entries. */
  maxEntries: number;
}

export const COLLECT_LIMITS: WalkLimits = { maxDepth: 32, maxEntries: 5000 };

/** Files larger than this are listed without content. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export type SpecialType = 'fifo' | 'socket' | 'device' | 'unknown';

export type TrialEntry =
  | { path: string; kind: 'file'; size: number }
  | { path: string; kind: 'dir'; entered: boolean }
  | { path: string; kind: 'symlink'; target: string }
  | { path: string; kind: 'special'; type: SpecialType }
  | { path: string; kind: 'unreadable'; reason: string };

export interface TrialTree {
  entries: TrialEntry[];
  /** Set when the entry cap ended the walk early. */
  truncated: boolean;
  /** Apparent size of the regular files listed. */
  bytes: number;
  /** Space allocated on disk for everything listed. */
  diskBytes: number;
}

function decodeName(name: Buffer): { text: string; exact: boolean } {
  const text = name.toString('utf8');
  return { text, exact: Buffer.from(text, 'utf8').equals(name) };
}

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

const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'error';

/** Lists a trial directory with lstat only. Paths in the result are relative to `root`. */
export async function walkTrialTree(
  root: string,
  limits: WalkLimits = COLLECT_LIMITS,
): Promise<TrialTree> {
  const entries: TrialEntry[] = [];
  const tree: TrialTree = { entries, truncated: false, bytes: 0, diskBytes: 0 };
  // Byte paths throughout: a name that is not UTF-8 still has to be stat-ed and measured.
  const stack: { abs: Buffer; rel: string; depth: number }[] = [
    { abs: Buffer.from(root), rel: '', depth: 0 },
  ];

  walk: while (stack.length > 0) {
    const dir = stack.pop()!;
    let handle;
    try {
      handle = await opendir(dir.abs, { encoding: 'buffer' as BufferEncoding });
    } catch (err) {
      if (dir.rel) entries.push({ path: dir.rel, kind: 'unreadable', reason: errorCode(err) });
      continue;
    }
    try {
      for await (const dirent of handle) {
        if (entries.length >= limits.maxEntries) {
          tree.truncated = true;
          break walk;
        }
        const raw = dirent.name as unknown as Buffer;
        const name = decodeName(raw);
        const rel = dir.rel ? `${dir.rel}/${name.text}` : name.text;
        const abs = Buffer.concat([dir.abs, Buffer.from('/'), raw]);
        let stat;
        try {
          stat = await lstat(abs);
        } catch (err) {
          if (errorCode(err) !== 'ENOENT')
            entries.push({ path: rel, kind: 'unreadable', reason: errorCode(err) });
          continue;
        }
        tree.diskBytes += stat.blocks * 512;
        if (!name.exact) {
          entries.push({ path: rel, kind: 'unreadable', reason: 'name is not valid UTF-8' });
        } else if (stat.isSymbolicLink()) {
          let target = '';
          try {
            target = decodeName(await readlink(abs, { encoding: 'buffer' })).text;
          } catch {
            // Listed with an empty target; never followed either way.
          }
          entries.push({ path: rel, kind: 'symlink', target });
        } else if (stat.isDirectory()) {
          const entered = dir.depth + 1 < limits.maxDepth;
          entries.push({ path: rel, kind: 'dir', entered });
          if (entered) stack.push({ abs, rel, depth: dir.depth + 1 });
        } else if (stat.isFile()) {
          entries.push({ path: rel, kind: 'file', size: stat.size });
          tree.bytes += stat.size;
        } else {
          entries.push({ path: rel, kind: 'special', type: specialType(stat) });
        }
      }
    } catch (err) {
      // The directory changed or vanished mid-read (only possible while the trial runs).
      entries.push({ path: dir.rel || '.', kind: 'unreadable', reason: errorCode(err) });
    } finally {
      await handle.close().catch(() => {});
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return tree;
}

export type TrialFileRead =
  | { ok: true; content: Buffer; sha256: string }
  | {
      ok: false;
      reason: 'too_large' | 'not_regular' | 'outside_root' | 'unreadable';
      detail: string;
    };

/**
 * Reads one regular file of a walked tree. Refuses links (O_NOFOLLOW), FIFOs
 * and devices (opened non-blocking, then checked with fstat), files over
 * `maxBytes`, and, on Linux, any file whose real path is not under `root`.
 */
export async function readTrialFile(
  root: string,
  relPath: string,
  maxBytes: number = MAX_ARTIFACT_BYTES,
): Promise<TrialFileRead> {
  if (relPath === '' || relPath.startsWith('/') || relPath.split('/').includes('..')) {
    return { ok: false, reason: 'outside_root', detail: relPath };
  }
  const rootReal = await realpath(root);
  const full = `${rootReal}/${relPath}`;
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errorCode(err);
    // ELOOP is how O_NOFOLLOW reports a final-component link.
    return code === 'ELOOP'
      ? { ok: false, reason: 'not_regular', detail: 'symbolic link' }
      : { ok: false, reason: 'unreadable', detail: code };
  }
  try {
    // A link in a parent component would have been followed by open. On Linux the
    // descriptor's own path shows where it landed.
    const landed = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (landed !== null && !landed.startsWith(`${rootReal}/`)) {
      return { ok: false, reason: 'outside_root', detail: landed };
    }
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not_regular', detail: specialType(stat) };
    if (stat.size > maxBytes) {
      return { ok: false, reason: 'too_large', detail: `${stat.size} bytes` };
    }
    // Read one byte past the limit, so a file that grew since fstat is still caught.
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length === buffer.length) break;
    }
    if (length > maxBytes) return { ok: false, reason: 'too_large', detail: 'grew while read' };
    const content = buffer.subarray(0, length);
    return { ok: true, content, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    await handle.close();
  }
}

export interface DiskLimit {
  /** Directories to measure: the attempt's home and workspace. */
  roots: string[];
  maxBytes: number;
  maxEntries: number;
  intervalMs?: number;
}

export const DEFAULT_DISK_LIMIT: Omit<DiskLimit, 'roots'> = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 50_000,
  intervalMs: 1000,
};

/** Measures the directories a trial writes to; `exceeded` explains which cap was passed. */
export async function measureTrialDisk(
  limit: DiskLimit,
): Promise<{ diskBytes: number; entries: number; exceeded: string | null }> {
  let diskBytes = 0;
  let entries = 0;
  for (const root of limit.roots) {
    const tree = await walkTrialTree(root, {
      maxDepth: 256,
      maxEntries: limit.maxEntries - entries + 1,
    });
    diskBytes += tree.diskBytes;
    entries += tree.entries.length;
    if (tree.truncated || entries > limit.maxEntries) {
      return { diskBytes, entries, exceeded: `more than ${limit.maxEntries} files` };
    }
  }
  if (diskBytes > limit.maxBytes) {
    return { diskBytes, entries, exceeded: `${diskBytes} bytes on disk, limit ${limit.maxBytes}` };
  }
  return { diskBytes, entries, exceeded: null };
}
