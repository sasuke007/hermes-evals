/**
 * A zip of each committed suite, built here from ./suites (read, never
 * written), reads back as a draft whose files equal the originals byte for
 * byte: texts verbatim, every other file in the blob store, each task's
 * loader content hash unchanged (so saving it would report `unchanged`),
 * and exactly its verify/ files listed as scripts.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isVerifyPath } from '@hermes-evals/shared';
import { readTrialFile } from '../../sandbox/trial-files.js';
import { BlobStore } from '../../storage/blob-store.js';
import { MAX_SUITE_FILE_BYTES, SUITE_WALK_LIMITS } from '../loader/limits.js';
import { analyseTask } from '../loader/task.js';
import { walkSuiteDir, type SuiteEntry } from '../loader/walk.js';
import type { DraftTaskFolder } from '../drafts/materialise.js';
import { readSuiteZip } from './parsers.js';
import { buildZip, zipItemsOfFolder } from './zip-testing.helper-spec.js';

const SUITES_DIR = resolve(import.meta.dirname, '../../../../../suites');
const SUITES = ['invoices-v1', 'mcp-v1', 'memory-v1', 'knowledge-v1', 'tools-v1'];

let work: string;
let blobs: BlobStore;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'committed-zip-'));
  blobs = new BlobStore(join(work, 'data'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** The draft task's folder as files: its texts as UTF-8 and its blobs' bytes. */
async function filesOf(task: DraftTaskFolder): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const texts = {
    'task.yaml': task.taskYaml,
    'prompt.md': task.prompt,
    'reference.json': task.reference,
  };
  for (const [path, text] of Object.entries({ ...texts, ...task.rubrics })) {
    if (text !== null) files.set(path, Buffer.from(text, 'utf8'));
  }
  for (const file of task.files) {
    expect(files.has(file.path)).toBe(false);
    const bytes = await blobs.read(file.sha256);
    expect(bytes.length).toBe(file.size);
    files.set(file.path, bytes);
  }
  return files;
}

/** The loader's content hash of a task folder given as entries and a reader. */
async function hashOf(
  key: string,
  entries: SuiteEntry[],
  read: (p: string) => Promise<Buffer | null>,
) {
  const analysed = await analyseTask(key, entries, async (path) => {
    const content = await read(path);
    if (content === null) return { ok: false, reason: 'missing' };
    return { ok: true, content, sha256: createHash('sha256').update(content).digest('hex') };
  });
  return analysed.contentHash;
}

describe.each(SUITES)('%s as a zip', (suite) => {
  it('reads back as the same files, each task with its loader content hash', async () => {
    const root = join(SUITES_DIR, suite);
    const zipPath = join(work, `${suite}.zip`);
    await writeFile(zipPath, await buildZip(await zipItemsOfFolder(root, `${suite}/`)));
    const result = await readSuiteZip(zipPath, blobs);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    const { contents } = result;

    expect(contents.suiteYaml).toBe(await readFile(join(root, 'suite.yaml'), 'utf8'));
    expect(contents.suite.name).toBe(suite);

    const tree = await walkSuiteDir(root, SUITE_WALK_LIMITS);
    const keys = tree.entries
      .filter((e) => e.kind === 'dir' && !e.path.includes('/'))
      .map((e) => e.path);
    expect(contents.tasks.map((t) => t.key).sort()).toEqual([...keys].sort());

    const scripts: string[] = [];
    for (const task of contents.tasks) {
      const prefix = `${task.key}/`;
      const entries = tree.entries
        .filter((e) => e.path.startsWith(prefix))
        .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
      const onDisk = new Map<string, Buffer>();
      for (const entry of entries) {
        if (entry.kind === 'file')
          onDisk.set(entry.path, await readFile(join(root, task.key, entry.path)));
      }
      const draft = await filesOf(task);
      expect([...draft.keys()].sort()).toEqual([...onDisk.keys()].sort());
      for (const [path, bytes] of onDisk) expect(draft.get(path)!.equals(bytes), path).toBe(true);
      for (const file of task.files) {
        if (file.path.startsWith('verify/')) expect(file.kind).toBe('verifier');
        if (file.path.startsWith('fixtures/')) expect(file.kind).toBe('fixture');
      }
      scripts.push(...[...onDisk.keys()].filter(isVerifyPath).map((p) => `${prefix}${p}`));

      const fromDisk = await hashOf(task.key, entries, async (path) => {
        const read = await readTrialFile(join(root, task.key), path, MAX_SUITE_FILE_BYTES);
        return read.ok ? read.content : null;
      });
      const fromDraft = await hashOf(task.key, entries, async (path) => draft.get(path) ?? null);
      expect(fromDraft).toBe(fromDisk);
    }
    expect(contents.scripts.map((s) => s.path).sort()).toEqual(scripts.sort());
  });
});
