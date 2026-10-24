/**
 * Reading a stored skill tree at DATA_DIR/skills/<content_hash>/.
 *
 * The tree was written by unpackSkillZip from a checked zip, so it holds only
 * folders and regular files. It is still read the way trial output is
 * (sandbox/trial-files.ts): an lstat walk that never follows a link, and
 * files opened with O_NOFOLLOW and checked with fstat, so a tree changed on
 * disk behind the API's back cannot make it read something else.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import pLimit from 'p-limit';
import type { ResourceFileKind } from '@hermes-evals/shared';
import { walkTrialTree } from '../../sandbox/trial-files.js';

/** Files larger than this are listed with size and hash only, no text. */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** How much of a file decides whether it is text. */
const SNIFF_BYTES = 8192;

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const CSV = new Set(['.csv', '.tsv']);
const CODE = new Set([
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.pl',
  '.lua',
  '.r',
  '.sql',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.xml',
  '.html',
  '.css',
]);

/** True when `bytes` has no NUL and is valid UTF-8 (a sequence cut off at the end is fine). */
export function looksLikeText(bytes: Uint8Array, complete: boolean): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

/**
 * The kind the skill viewer renders a file as. Content decides text or
 * binary; the extension then picks markdown, csv, code or plain text.
 */
export function fileKind(path: string, head: Uint8Array, complete: boolean): ResourceFileKind {
  if (!looksLikeText(head, complete)) return 'binary';
  const ext = extname(path).toLowerCase();
  if (MARKDOWN.has(ext)) return 'markdown';
  if (CSV.has(ext)) return 'csv';
  if (CODE.has(ext)) return 'code';
  return 'text';
}

/**
 * The content hash of a skill: sha256 of the JSON array of [path, sha256]
 * pairs, sorted by path. JSON keeps any file name unambiguous, and the hash
 * depends on names and contents only, never on zip order, times or modes.
 */
export function skillContentHash(files: readonly { path: string; sha256: string }[]): string {
  const pairs = files
    .map((f) => [f.path, f.sha256] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

export interface SkillFile {
  path: string;
  size: number;
  kind: ResourceFileKind;
}

/** Opens a regular file under `root` without following a final link. */
async function openRegular(root: string, path: string) {
  const handle = await open(
    join(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new Error(`${path} is not a regular file`);
  }
  return { handle, size: stat.size };
}

/** Every regular file of the tree, sorted by path, with its kind. Links and special files are left out. */
export async function listSkillFiles(root: string): Promise<SkillFile[]> {
  const tree = await walkTrialTree(root, { maxDepth: 64, maxEntries: 10_000 });
  const limit = pLimit(16);
  const files = tree.entries.flatMap((e) => (e.kind === 'file' ? [e] : []));
  return Promise.all(
    files.map((entry) =>
      limit(async () => {
        const { handle, size } = await openRegular(root, entry.path);
        try {
          const head = Buffer.alloc(Math.min(size, SNIFF_BYTES));
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          const sniffed = head.subarray(0, bytesRead);
          return {
            path: entry.path,
            size,
            kind: fileKind(entry.path, sniffed, size <= SNIFF_BYTES),
          };
        } finally {
          await handle.close();
        }
      }),
    ),
  );
}

export interface SkillFileRead {
  size: number;
  sha256: string;
  kind: ResourceFileKind;
  /** UTF-8 text up to MAX_TEXT_BYTES; null for binary or larger files. */
  content: string | null;
}

/** Reads one file of the tree: its hash always, its text when it is small UTF-8 text. */
export async function readSkillFile(root: string, path: string): Promise<SkillFileRead> {
  const { handle, size } = await openRegular(root, path);
  try {
    if (size <= MAX_TEXT_BYTES) {
      const content = await handle.readFile();
      const sha256 = createHash('sha256').update(content).digest('hex');
      const kind = fileKind(path, content, true);
      return {
        size: content.length,
        sha256,
        kind,
        content: kind === 'binary' ? null : content.toString('utf8'),
      };
    }
    const hash = createHash('sha256');
    let head: Buffer | null = null;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer;
      head ??= bytes.subarray(0, SNIFF_BYTES);
      hash.update(bytes);
    }
    return {
      size,
      sha256: hash.digest('hex'),
      kind: fileKind(path, head ?? Buffer.alloc(0), false),
      content: null,
    };
  } finally {
    await handle.close();
  }
}

/** A read stream of one regular file of the tree, opened without following links. */
export async function openSkillFileStream(root: string, path: string): Promise<Readable> {
  const { handle } = await openRegular(root, path);
  return handle.createReadStream();
}

/**
 * fsyncs every file and folder of a tree, so a tree renamed into
 * DATA_DIR/skills survives a crash complete. Unpacking writes without
 * syncing, because most validations are never confirmed.
 */
export async function syncTree(root: string): Promise<void> {
  const tree = await walkTrialTree(root, { maxDepth: 64, maxEntries: 10_000 });
  const limit = pLimit(16);
  const paths = [
    '',
    ...tree.entries.flatMap((e) => (e.kind === 'file' || e.kind === 'dir' ? [e.path] : [])),
  ];
  await Promise.all(
    paths.map((path) =>
      limit(async () => {
        const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }),
    ),
  );
}
