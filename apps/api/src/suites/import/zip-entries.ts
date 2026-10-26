/**
 * The entries of an uploaded suite .zip, checked without trusting them
 * (plan 4.6, R7), by the rules of the skill zip reader
 * (resources/skills/zip-reader.ts) with a suite's bounds and wording:
 *
 * - the central directory is read and checked as a whole before any entry
 *   is read: no absolute path, drive letter, `..`, `.` or empty segment,
 *   backslash or control character, no name over 255 bytes, at most
 *   AUTHORING_LIMITS.suiteMaxEntries entries and suiteMaxDepth folders, no
 *   file over suiteMaxFileBytes, no large entry that expands more than
 *   MAX_RATIO times, no link, device, FIFO or socket, no encryption, and no
 *   two paths that differ only in case (they would be one file on a Mac);
 * - names the loader skips (a segment starting with `.`) and macOS metadata
 *   (`__MACOSX/`) are left out, as a reload would leave them;
 * - reading (./zip-entry-reader.ts) counts the bytes actually inflated
 *   against the same caps, and yauzl fails an entry that inflates past its
 *   declared size.
 *
 * Nothing is unpacked to disk: each file streams into the blob store, which
 * hashes it on the way. Refusals are UploadProblems worded for the import
 * dialog (SA.10); only failures of the platform itself (disk full) throw.
 */
import { AUTHORING_LIMITS, type UploadProblem } from '@hermes-evals/shared';
import { getFileNameLowLevel, openPromise, type Entry, type ZipFile } from 'yauzl';
import { formatBytes } from '../../resources/skills/format.js';
import { cappedProblems } from './task-table.js';

const MiB = 1024 * 1024;

export interface SuiteZipLimits {
  /** Entries in the central directory, folders and skipped names included. */
  maxEntries: number;
  /** One file, declared and actual. */
  maxFileBytes: number;
  /** Folders a path may be nested in. */
  maxDepth: number;
  /** Sum of the unpacked file sizes, declared and actual. */
  maxUnpackedBytes: number;
  /** How many times an entry of at least `ratioFloorBytes` may expand. */
  maxRatio: number;
  ratioFloorBytes: number;
}

export const SUITE_ZIP_LIMITS: SuiteZipLimits = {
  maxEntries: AUTHORING_LIMITS.suiteMaxEntries,
  maxFileBytes: AUTHORING_LIMITS.suiteMaxFileBytes,
  maxDepth: AUTHORING_LIMITS.suiteMaxDepth,
  // The tasks' files are analysed in the API's memory, one task at a time.
  maxUnpackedBytes: 512 * MiB,
  maxRatio: 200,
  ratioFloorBytes: 1 * MiB,
};

/** A file of the zip that passed the checks; `path` is the full path in the zip. */
export interface ZipFileEntry {
  path: string;
  size: number;
  entry: Entry;
}

export interface ZipListing {
  files: ZipFileEntry[];
  /** Folders listed as entries of their own, without the trailing '/'. */
  folders: Set<string>;
  declaredBytes: number;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
/** MS-DOS attribute bit for a folder, in the low byte of the external attributes. */
const DOS_DIRECTORY = 0x10;

// oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;
// oxlint-disable-next-line no-control-regex -- see CONTROL
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/** A name as the dialog shows it: control characters escaped, long names cut. */
export function shown(name: string): string {
  const visible = name.replace(
    CONTROL_ALL,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return visible.length > 160 ? `${visible.slice(0, 157)}...` : visible;
}

export const limitsDetail = (limits: SuiteZipLimits): string =>
  `A suite holds at most ${limits.maxEntries.toLocaleString('en-US')} files, ` +
  `${formatBytes(limits.maxFileBytes)} each, in folders at most ${limits.maxDepth} levels deep.`;

const outside = (name: string): UploadProblem => ({
  title: `${name} points outside the suite.`,
  detail: 'Paths in the zip must be relative and stay inside the suite folder.',
});

const zipAgain = 'Zip the suite folder again.';

/** Why a path is refused, or null. `path` has no trailing '/'. */
function pathProblem(path: string, limits: SuiteZipLimits): UploadProblem | null {
  const name = shown(path);
  if (path.includes('\\')) {
    return {
      title: `${name} uses a backslash.`,
      detail: 'Zip the folder with a tool that writes "/" separators.',
    };
  }
  if (CONTROL.test(path)) {
    return { title: `${name} contains a control character.`, detail: 'Rename it, then zip again.' };
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return outside(name);
  const segments = path.split('/');
  if (segments.includes('..')) return outside(name);
  if (segments.some((s) => s === '' || s === '.')) {
    return {
      title: `${name} has an empty or "." path segment.`,
      detail: 'Paths in the zip must be relative and stay inside the suite folder.',
    };
  }
  if (segments.some((s) => Buffer.byteLength(s) > 255)) {
    return { title: `${name} has a name over 255 bytes.`, detail: 'Shorten it, then zip again.' };
  }
  if (segments.length - 1 > limits.maxDepth) {
    return {
      title: `${name} is more than ${limits.maxDepth} folders deep.`,
      detail: limitsDetail(limits),
    };
  }
  return null;
}

/** Names a reload never reads: hidden at any level (the loader skips them) and macOS metadata. */
export const isSkippedPath = (path: string): boolean =>
  path === '__MACOSX' ||
  path.startsWith('__MACOSX/') ||
  path.split('/').some((segment) => segment.startsWith('.'));

/**
 * The first path on `path` (itself or a folder above it) whose name was seen
 * before in another casing, or null; records the casings of the rest.
 */
function casingClash(
  path: string,
  casings: Map<string, string>,
): { lower: string; first: string; other: string } | null {
  const segments = path.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    const lower = prefix.toLowerCase();
    const first = casings.get(lower);
    if (first === undefined) casings.set(lower, prefix);
    else if (first !== prefix) return { lower, first, other: prefix };
  }
  return null;
}

/** Reads and checks the central directory. Reads no entry's content. */
async function scan(zip: ZipFile, limits: SuiteZipLimits) {
  const files: ZipFileEntry[] = [];
  const problems: UploadProblem[] = [];
  const folders = new Set<string>();
  const seen = new Set<string>();
  /** Lower-cased path → its casing as first seen, for every path and folder on it. */
  const casings = new Map<string, string>();
  const reported = new Set<string>();
  let declaredBytes = 0;

  for await (const entry of zip.eachEntry()) {
    // decodeStrings is off, so yauzl validated nothing; decode strictly (backslashes kept).
    const name = getFileNameLowLevel(
      entry.generalPurposeBitFlag,
      entry.fileNameRaw,
      entry.extraFields,
      true,
    );
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const type = mode & S_IFMT;
    const isFolder =
      name.endsWith('/') ||
      type === S_IFDIR ||
      (entry.externalFileAttributes & DOS_DIRECTORY) !== 0;
    const path = name.endsWith('/') ? name.slice(0, -1) : name;
    const label = shown(path);

    const refused = pathProblem(path, limits);
    if (refused) {
      problems.push(refused);
      continue;
    }
    if (type === S_IFLNK) {
      problems.push({
        title: `The zip has a symbolic link at ${label}.`,
        detail:
          'Links are not allowed. Replace the link with the file itself, then zip the folder again.',
      });
      continue;
    }
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
      problems.push({
        title: `The zip has a special file at ${label}.`,
        detail: 'Only files and folders are allowed: no device, FIFO or socket.',
      });
      continue;
    }
    if (isSkippedPath(path)) continue;
    if (seen.has(path)) {
      problems.push({ title: `${label} is in the zip twice.`, detail: zipAgain });
      continue;
    }
    seen.add(path);
    // The path and every folder on it, against the casing first seen for it.
    const clash = casingClash(path, casings);
    if (clash !== null) {
      if (!reported.has(clash.lower)) {
        reported.add(clash.lower);
        problems.push({
          title: `${shown(clash.first)} and ${shown(clash.other)} differ only in case.`,
          detail: `They would be one name on a Mac. ${zipAgain}`,
        });
      }
      continue;
    }
    if (isFolder) {
      folders.add(path);
      continue;
    }
    if (entry.isEncrypted()) {
      problems.push({
        title: `${label} is password-protected.`,
        detail: 'Zip it without a password.',
      });
      continue;
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      problems.push({
        title: `${label} uses compression method ${entry.compressionMethod}.`,
        detail: 'Use deflate or store.',
      });
      continue;
    }
    const size = entry.uncompressedSize;
    if (size > limits.maxFileBytes) {
      problems.push({
        title: `${label} is ${formatBytes(size)}, over ${formatBytes(limits.maxFileBytes)}.`,
        detail: limitsDetail(limits),
      });
      continue;
    }
    if (
      size >= limits.ratioFloorBytes &&
      size > limits.maxRatio * Math.max(entry.compressedSize, 1)
    ) {
      problems.push({
        title: `${label} expands from ${formatBytes(entry.compressedSize)} to ${formatBytes(size)}.`,
        detail: `That is more than ${limits.maxRatio} times; zip the folder without it.`,
      });
      continue;
    }
    declaredBytes += size;
    files.push({ path, size, entry });
  }

  // A path cannot be a file and also hold other paths.
  const filePaths = new Set(files.map((f) => f.path));
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/');
      if (filePaths.has(parent)) {
        problems.push({ title: `${shown(parent)} is both a file and a folder.`, detail: zipAgain });
      }
    }
  }
  if (declaredBytes > limits.maxUnpackedBytes) problems.push(tooLarge(declaredBytes, limits));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { listing: { files, folders, declaredBytes }, problems };
}

/** `bytes` is the declared total, or null when inflating passed the cap (the true total is unknown). */
export const tooLarge = (bytes: number | null, limits: SuiteZipLimits): UploadProblem => ({
  title: 'Too large unpacked.',
  detail: `The files add up to ${bytes === null ? 'more than ' : ''}${formatBytes(bytes ?? limits.maxUnpackedBytes)}; the limit is ${formatBytes(limits.maxUnpackedBytes)}.`,
});

export type ZipOpen =
  | { ok: true; zip: ZipFile; listing: ZipListing }
  | { ok: false; problems: UploadProblem[]; declaredBytes: number };

/**
 * Opens the zip at `zipPath` and checks its central directory. On success
 * the caller reads entries (readEntry, storeEntry) and must close the zip.
 */
export async function openSuiteZip(
  zipPath: string,
  limits: SuiteZipLimits = SUITE_ZIP_LIMITS,
): Promise<ZipOpen> {
  let zip: ZipFile;
  try {
    zip = await openPromise(zipPath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: false,
      validateEntrySizes: true,
    });
  } catch (err) {
    return {
      ok: false,
      problems: [
        {
          title: 'Not a zip file.',
          detail: `It could not be read as a zip archive (${(err as Error).message}).`,
        },
      ],
      declaredBytes: 0,
    };
  }
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    return {
      ok: false,
      problems: [
        {
          title: `Over ${limits.maxEntries.toLocaleString('en-US')} files.`,
          detail: limitsDetail(limits),
        },
      ],
      declaredBytes: 0,
    };
  }
  try {
    const { listing, problems } = await scan(zip, limits);
    if (problems.length === 0) return { ok: true, zip, listing };
    zip.close();
    return { ok: false, problems: cappedProblems(problems), declaredBytes: listing.declaredBytes };
  } catch (err) {
    zip.close();
    return {
      ok: false,
      problems: [{ title: 'Corrupt zip.', detail: (err as Error).message }],
      declaredBytes: 0,
    };
  }
}
