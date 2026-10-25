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
 * - Fail closed on what cannot be measured. The trial and the worker share a
 *   uid, so the agent can chmod a directory it made (or /workspace itself)
 *   so the worker cannot list it while the agent still writes into it. The
 *   disk watchdog treats such a directory as over the cap.
 *
 * Content is read only after the container is removed, so nothing changes
 * under the walk. The disk watchdog walks while the trial runs; it reads
 * metadata only. restoreOwnerAccess gives the worker back the permissions
 * the agent took away, also only once the container is gone.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import { basename } from 'node:path';

export interface WalkLimits {
  /** Directories deeper than this are listed but not entered. */
  maxDepth: number;
  /** The walk stops after this many entries. */
  maxEntries: number;
}

export const COLLECT_LIMITS: WalkLimits = { maxDepth: 32, maxEntries: 5000 };

/** Files larger than this are listed without content. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

/**
 * Bytes one attempt's collection may store, counted by apparent size (what
 * the blob store writes). The disk cap counts allocated blocks, so sparse
 * files pass it cheaply: 5,000 files truncated to 25 MiB take almost no
 * disk in the trial and 122 GiB once stored. Past this budget files are
 * listed without content (`over_budget`). Well under the 2 GiB disk cap.
 */
export const MAX_COLLECTED_BYTES = 512 * 1024 * 1024;

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

/** The reason of an entry whose name no string names exactly; lstat-ed and measured all the same. */
const NOT_UTF8 = 'name is not valid UTF-8';

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
      // The root too: a workspace the agent made unlistable must not read as empty.
      entries.push({ path: dir.rel || '.', kind: 'unreadable', reason: errorCode(err) });
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
          entries.push({ path: rel, kind: 'unreadable', reason: NOT_UTF8 });
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

/** How deep the disk watchdog walks; a directory below this is not measured, so it fails closed. */
export const MEASURE_MAX_DEPTH = 256;

/**
 * The first part of a tree the watchdog cannot measure, or null: a
 * directory or entry the worker may not read (EACCES, EPERM, ELOOP,
 * ENOTDIR, ...), or a directory nested too deep to enter. ENOENT is not
 * one: a directory that vanishes mid-walk is the trial deleting it. A name
 * that is not UTF-8 was still lstat-ed and counted.
 */
function unmeasured(root: string, tree: TrialTree): string | null {
  // Named as the trial sees it from its mount, e.g. `workspace/hidden`.
  const shown = (path: string) => (path === '.' ? basename(root) : `${basename(root)}/${path}`);
  for (const entry of tree.entries) {
    if (entry.kind === 'unreadable' && entry.reason !== 'ENOENT' && entry.reason !== NOT_UTF8) {
      return `a directory the worker cannot read: ${shown(entry.path)} (${entry.reason})`;
    }
    if (entry.kind === 'dir' && !entry.entered) {
      return `a directory nested deeper than ${MEASURE_MAX_DEPTH} levels: ${shown(entry.path)}`;
    }
  }
  return null;
}

/** How far restoreOwnerAccess walks: twice the disk cap's files, and the watchdog's depth. */
export const RESTORE_LIMITS: WalkLimits = { maxDepth: MEASURE_MAX_DEPTH, maxEntries: 100_000 };

/**
 * Gives the owner (the worker, which shares the trial's uid) read, write and
 * search on every directory under `root`, `root` included, so the tree can
 * be collected and deleted: an agent can chmod 0300 or 0555 a directory it
 * owns, and rm then fails with EACCES. Files keep their modes; deleting a
 * file needs only its directory.
 *
 * Depth first with lstat, never following a link. chmod by path does follow
 * a final link, so this is safe only once no process of the trial can swap a
 * directory for a link between the lstat and the chmod: call it after the
 * container is removed (or confirmed gone), never while it runs. Bounded like
 * the other walks. Resolves how many directories it changed; entries it
 * cannot reach are left for rm to report.
 */
export async function restoreOwnerAccess(
  root: string,
  limits: WalkLimits = RESTORE_LIMITS,
): Promise<number> {
  const stack: { abs: Buffer; depth: number }[] = [{ abs: Buffer.from(root), depth: 0 }];
  let seen = 0;
  let changed = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let stat;
    try {
      stat = await lstat(dir.abs);
    } catch {
      continue;
    }
    // A link, file or device where a directory was listed: never followed or changed.
    if (!stat.isDirectory()) continue;
    if ((stat.mode & 0o700) !== 0o700) {
      try {
        await chmod(dir.abs, (stat.mode | 0o700) & 0o7777);
        changed += 1;
      } catch {
        continue;
      }
    }
    if (dir.depth >= limits.maxDepth) continue;
    let handle;
    try {
      handle = await opendir(dir.abs, { encoding: 'buffer' as BufferEncoding });
    } catch {
      continue;
    }
    try {
      for await (const dirent of handle) {
        seen += 1;
        if (seen > limits.maxEntries) return changed;
        // Only directories are entered; an unknown type is lstat-ed when it is popped.
        const known =
          dirent.isFile() ||
          dirent.isSymbolicLink() ||
          dirent.isFIFO() ||
          dirent.isSocket() ||
          dirent.isCharacterDevice() ||
          dirent.isBlockDevice();
        if (dirent.isDirectory() || !known) {
          const raw = dirent.name as unknown as Buffer;
          stack.push({
            abs: Buffer.concat([dir.abs, Buffer.from('/'), raw]),
            depth: dir.depth + 1,
          });
        }
      }
    } catch {
      // Changed while read: what was listed is restored, the rest is left to rm.
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return changed;
}

/** Measures the directories a trial writes to; `exceeded` explains which cap was passed. */
export async function measureTrialDisk(
  limit: DiskLimit,
): Promise<{ diskBytes: number; entries: number; exceeded: string | null }> {
  let diskBytes = 0;
  let entries = 0;
  for (const root of limit.roots) {
    const tree = await walkTrialTree(root, {
      maxDepth: MEASURE_MAX_DEPTH,
      maxEntries: limit.maxEntries - entries + 1,
    });
    diskBytes += tree.diskBytes;
    entries += tree.entries.length;
    if (tree.truncated || entries > limit.maxEntries) {
      return { diskBytes, entries, exceeded: `more than ${limit.maxEntries} files` };
    }
    const hidden = unmeasured(root, tree);
    if (hidden) return { diskBytes, entries, exceeded: hidden };
  }
  if (diskBytes > limit.maxBytes) {
    return { diskBytes, entries, exceeded: `${diskBytes} bytes on disk, limit ${limit.maxBytes}` };
  }
  return { diskBytes, entries, exceeded: null };
}
