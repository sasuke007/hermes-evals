/**
 * Unpacks an uploaded skill zip without trusting it (plan 5.1).
 *
 * The zip comes from the browser, so every name, size and file type in it is
 * hostile until checked. The central directory is read first and checked as
 * a whole, and nothing is written unless every entry passes:
 *
 * - Paths: no absolute path or drive letter, no `..`, `.` or empty segment, no
 *   backslash, no control character, no segment over 255 bytes, depth capped.
 * - Types: only files and folders. A symbolic link, device, FIFO or socket in
 *   the unix mode bits refuses the zip; links are never created, so nothing
 *   unpacked can point outside the destination.
 * - Sizes: at most `maxEntries` entries and `maxUnpackedBytes` declared in
 *   total, and no large entry that expands more than `maxRatio` times. While
 *   unpacking, the bytes actually inflated are counted against the same cap,
 *   and yauzl fails an entry that inflates past its declared size, so a zip
 *   that lies in its headers is stopped too.
 *
 * SKILL.md may sit at the zip root, or inside one top-level folder that holds
 * everything (what "Compress" on a folder produces); that folder is stripped.
 * macOS metadata (`__MACOSX/`, `.DS_Store`) is skipped. Folders are not kept
 * as such: the tree is the files, and a folder exists when a file is in it.
 *
 * Refusals come back as UploadProblems worded for the upload dialog; only
 * failures of the platform itself (disk full, permissions) throw.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UploadProblem } from '@hermes-evals/shared';
import { getFileNameLowLevel, openPromise, type Entry, type ZipFile } from 'yauzl';
import { formatBytes } from './format.js';

const MiB = 1024 * 1024;

export interface ZipLimits {
  /** Entries in the central directory, folders and skipped metadata included. */
  maxEntries: number;
  /** Sum of the unpacked file sizes, declared and actual. */
  maxUnpackedBytes: number;
  /** How many times an entry of at least `ratioFloorBytes` may expand. */
  maxRatio: number;
  ratioFloorBytes: number;
  /** Folders a path may be nested in. */
  maxDepth: number;
}

export const SKILL_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxUnpackedBytes: 100 * MiB,
  maxRatio: 200,
  ratioFloorBytes: 1 * MiB,
  maxDepth: 32,
};

/** A file written to the destination; `path` is relative to it. */
export interface UnpackedFile {
  path: string;
  size: number;
  sha256: string;
}

/** A file as the zip lists it, for the dialog's file tree. */
export interface ListedFile {
  path: string;
  sizeBytes: number;
}

export type UnpackResult =
  | {
      ok: true;
      /** The folder that was stripped, with its trailing '/', or '' when SKILL.md is at the root. */
      root: string;
      /** Sorted by path. */
      files: UnpackedFile[];
      unpackedBytes: number;
    }
  | {
      ok: false;
      problems: UploadProblem[];
      /** The zip's own listing (declared sizes, full paths). */
      listing: ListedFile[];
      unpackedBytes: number;
    };

/** At most this many problems are listed; the rest are summed up in one line. */
const MAX_PROBLEMS = 10;

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
function shown(name: string): string {
  const visible = name.replace(
    CONTROL_ALL,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return visible.length > 160 ? `${visible.slice(0, 157)}...` : visible;
}

const unsafePath = (detail: string): UploadProblem => ({
  title: 'Unsafe path in the zip.',
  detail,
});

/** Why a path is refused, or null. `path` has no trailing '/'. */
function pathProblem(path: string, limits: ZipLimits): UploadProblem | null {
  const name = shown(path);
  if (path.includes('\\')) {
    return unsafePath(
      `${name} uses a backslash. Zip the folder with a tool that writes "/" separators.`,
    );
  }
  if (CONTROL.test(path)) {
    return { title: 'Unsafe name in the zip.', detail: `${name} contains a control character.` };
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return unsafePath(`${name} is an absolute path. Zip the skill with relative paths.`);
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    return unsafePath(`${name} climbs out of the skill folder with "..".`);
  }
  if (segments.some((s) => s === '' || s === '.')) {
    return unsafePath(`${name} has an empty or "." path segment.`);
  }
  if (segments.some((s) => Buffer.byteLength(s) > 255)) {
    return { title: 'Name too long.', detail: `${name} has a name over 255 bytes.` };
  }
  if (segments.length - 1 > limits.maxDepth) {
    return {
      title: 'Folders nested too deep.',
      detail: `${name} is more than ${limits.maxDepth} folders deep.`,
    };
  }
  return null;
}

/** macOS adds these when it zips a folder; they are not part of the skill. */
const isMacMetadata = (path: string): boolean =>
  path === '__MACOSX' || path.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(path);

interface ScannedFile {
  path: string;
  size: number;
  entry: Entry;
}

interface Scan {
  files: ScannedFile[];
  problems: UploadProblem[];
  declaredBytes: number;
}

/** Reads and checks the central directory. Writes nothing. */
async function scan(zip: ZipFile, limits: ZipLimits): Promise<Scan> {
  const files: ScannedFile[] = [];
  const problems: UploadProblem[] = [];
  const seen = new Set<string>();
  const folders = new Set<string>();
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
        title: 'Symbolic link in the zip.',
        detail: `${label} is a link. Put the file it points to in the zip instead.`,
      });
      continue;
    }
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
      problems.push({
        title: 'Special file in the zip.',
        detail: `${label} is a device, FIFO or socket. Only files and folders are allowed.`,
      });
      continue;
    }
    if (isMacMetadata(path)) continue;
    if (seen.has(path)) {
      problems.push({ title: 'Duplicate path in the zip.', detail: `${label} is listed twice.` });
      continue;
    }
    seen.add(path);
    if (isFolder) {
      folders.add(path);
      continue;
    }
    if (entry.isEncrypted()) {
      problems.push({
        title: 'Encrypted file in the zip.',
        detail: `${label} is password-protected. Zip it without a password.`,
      });
      continue;
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      problems.push({
        title: 'Unsupported compression.',
        detail: `${label} uses compression method ${entry.compressionMethod}. Use deflate or store.`,
      });
      continue;
    }
    const size = entry.uncompressedSize;
    if (
      size >= limits.ratioFloorBytes &&
      size > limits.maxRatio * Math.max(entry.compressedSize, 1)
    ) {
      problems.push({
        title: 'Suspicious compression ratio.',
        detail: `${label} expands from ${formatBytes(entry.compressedSize)} to ${formatBytes(size)}, more than ${limits.maxRatio} times.`,
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
        problems.push({
          title: 'Duplicate path in the zip.',
          detail: `${shown(parent)} is both a file and a folder.`,
        });
      }
    }
    if (folders.has(file.path)) {
      problems.push({
        title: 'Duplicate path in the zip.',
        detail: `${shown(file.path)} is both a file and a folder.`,
      });
    }
  }
  if (declaredBytes > limits.maxUnpackedBytes) problems.push(tooLarge(declaredBytes, limits));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, problems, declaredBytes };
}

/** `bytes` is the declared total, or null when inflating passed the cap (the true total is unknown). */
const tooLarge = (bytes: number | null, limits: ZipLimits): UploadProblem => ({
  title: 'Too large unpacked.',
  detail: `The files add up to ${bytes === null ? 'more than ' : ''}${formatBytes(bytes ?? limits.maxUnpackedBytes)}; the limit is ${formatBytes(limits.maxUnpackedBytes)}.`,
});

const ORDINAL_DEPTH = ['', 'one folder', 'two folders', 'three folders'];

/** The folder to strip, or the problem explaining where SKILL.md should be. */
function findRoot(paths: string[]): { root: string } | UploadProblem {
  if (paths.length === 0) {
    return {
      title: 'The zip is empty.',
      detail: "Zip the skill folder's contents: SKILL.md and the files it uses.",
    };
  }
  if (paths.includes('SKILL.md')) return { root: '' };
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  const [top] = tops;
  if (tops.size === 1 && paths.every((p) => p.includes('/')) && paths.includes(`${top}/SKILL.md`)) {
    return { root: `${top}/` };
  }
  const title = 'No SKILL.md at the zip root.';
  const misnamed = paths.find((p) => p.toLowerCase() === 'skill.md');
  if (misnamed) return { title, detail: `Found ${shown(misnamed)}; name it SKILL.md in capitals.` };
  const deeper = paths
    .filter((p) => p.endsWith('/SKILL.md'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!deeper) {
    return {
      title,
      detail:
        'Add a SKILL.md with name, version and description front matter at the top of the zip.',
    };
  }
  const depth = deeper.split('/').length - 1;
  const where = ORDINAL_DEPTH[depth] ?? `${depth} folders`;
  const beside = depth === 1 ? ', beside other files' : '';
  return {
    title,
    detail: `Found ${shown(deeper)} ${where} down${beside}. Zip the folder's contents rather than the folder.`,
  };
}

/** The unpacked total passed the cap while inflating: the headers understated the sizes. */
class UnpackedTooLarge extends Error {}

/** Writes every file under `dest`, hashing each and counting the bytes actually inflated. */
async function extract(
  zip: ZipFile,
  files: ScannedFile[],
  root: string,
  dest: string,
  limits: ZipLimits,
): Promise<UnpackedFile[] | UploadProblem> {
  const written: UnpackedFile[] = [];
  let total = 0;
  for (const file of files) {
    const rel = file.path.slice(root.length);
    const target = join(dest, rel);
    // Checked paths and no links ever created, so every parent is a real folder under dest.
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        total += chunk.length;
        if (total > limits.maxUnpackedBytes) return callback(new UnpackedTooLarge());
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    let handle;
    try {
      handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
    } catch (err) {
      // Two names that differ only in case, on a case-insensitive disk (a Mac in development).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return {
          title: 'Duplicate path in the zip.',
          detail: `${shown(rel)} collides with another file of the same name.`,
        };
      }
      throw err;
    }
    try {
      const source = await zip.openReadStreamPromise(file.entry);
      await pipeline(source, meter, handle.createWriteStream());
    } catch (err) {
      await handle.close().catch(() => {});
      if (err instanceof UnpackedTooLarge) return tooLarge(null, limits);
      if (isFsError(err)) throw err;
      return {
        title: 'Corrupt zip.',
        detail: `${shown(file.path)} could not be unpacked (${(err as Error).message}).`,
      };
    }
    written.push({ path: rel, size, sha256: hash.digest('hex') });
  }
  return written;
}

/** Errors of the platform's own disk, as opposed to errors reading the zip. */
const isFsError = (err: unknown): boolean => {
  const { code, syscall } = err as NodeJS.ErrnoException;
  return typeof code === 'string' && typeof syscall === 'string';
};

const listing = (files: ScannedFile[]): ListedFile[] =>
  files.map((f) => ({ path: f.path, sizeBytes: f.size }));

/** Keeps the first problems and sums up the rest in one line. */
function capped(problems: UploadProblem[]): UploadProblem[] {
  if (problems.length <= MAX_PROBLEMS) return problems;
  const rest = problems.length - (MAX_PROBLEMS - 1);
  return [
    ...problems.slice(0, MAX_PROBLEMS - 1),
    { title: `${rest} more problems.`, detail: 'Fix the ones above and upload again.' },
  ];
}

/**
 * Checks the zip at `zipPath` and, when it passes, unpacks it into `dest`,
 * an empty directory the caller owns (and removes on failure).
 */
export async function unpackSkillZip(
  zipPath: string,
  dest: string,
  limits: ZipLimits = SKILL_ZIP_LIMITS,
): Promise<UnpackResult> {
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
      listing: [],
      unpackedBytes: 0,
    };
  }
  try {
    if (zip.entryCount > limits.maxEntries) {
      return {
        ok: false,
        problems: [
          {
            title: 'Too many files.',
            detail: `The zip lists ${zip.entryCount.toLocaleString('en-US')} entries; the limit is ${limits.maxEntries.toLocaleString('en-US')}.`,
          },
        ],
        listing: [],
        unpackedBytes: 0,
      };
    }
    let scanned: Scan;
    try {
      scanned = await scan(zip, limits);
    } catch (err) {
      return {
        ok: false,
        problems: [{ title: 'Corrupt zip.', detail: (err as Error).message }],
        listing: [],
        unpackedBytes: 0,
      };
    }
    const failed = (problems: UploadProblem[]): UnpackResult => ({
      ok: false,
      problems: capped(problems),
      listing: listing(scanned.files),
      unpackedBytes: scanned.declaredBytes,
    });
    if (scanned.problems.length > 0) return failed(scanned.problems);
    const found = findRoot(scanned.files.map((f) => f.path));
    if (!('root' in found)) return failed([found]);
    const written = await extract(zip, scanned.files, found.root, dest, limits);
    if (!Array.isArray(written)) return failed([written]);
    return {
      ok: true,
      root: found.root,
      files: written,
      unpackedBytes: written.reduce((sum, f) => sum + f.size, 0),
    };
  } finally {
    zip.close();
  }
}
