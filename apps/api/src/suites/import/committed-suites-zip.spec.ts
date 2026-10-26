/**
 * A zip of each committed suite, built here from ./suites (read, never
 * written), reads back as a draft whose files equal the originals byte for
 * byte: texts verbatim, every other file in the blob store, each task's
 * loader content hash unchanged (so saving it would report `unchanged`),
 * and exactly its verify/ files listed as scripts. Read as drafts, no
 * committed task warns of a reference leak: the seven whose answer is
 * picked from their data say so (`self_check.answers_from_fixtures`).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { isVerifyPath, TaskYamlSchema } from '@hermes-evals/shared';
import { readTrialFile } from '../../sandbox/trial-files.js';
import { BlobStore } from '../../storage/blob-store.js';
import { MAX_SUITE_FILE_BYTES, SUITE_WALK_LIMITS } from '../loader/limits.js';
import { analyseTask } from '../loader/task.js';
import { walkSuiteDir, type SuiteEntry } from '../loader/walk.js';
import type { DraftTaskFolder } from '../drafts/materialise.js';
import { ANSWERS_FROM_FIXTURES } from '../drafts/readiness-cross.js';
import { evaluateReadiness } from '../drafts/readiness.js';
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

/** The tasks whose answer is picked from their own data (Phase 5b question 1). */
const ANSWERS_FROM_DATA = [
  'invoices-v1/dup_invoices',
  'invoices-v1/overdue_list',
  'invoices-v1/per_vendor',
  'memory-v1/standing_exclusion',
  'memory-v1/vendor_alias',
  'tools-v1/extract_ibans',
  'tools-v1/small_lookup',
];

describe('the committed suites as drafts', () => {
  it('warn of no reference leak: the seven tasks answered from their data say so', async () => {
    const leaks: string[] = [];
    const flagged: string[] = [];
    for (const suite of SUITES) {
      const zipPath = join(work, `${suite}-readiness.zip`);
      const items = await zipItemsOfFolder(join(SUITES_DIR, suite), `${suite}/`);
      await writeFile(zipPath, await buildZip(items));
      const result = await readSuiteZip(zipPath, blobs);
      if (!result.ok) throw new Error(JSON.stringify(result.problems));
      for (const task of result.contents.tasks) {
        const outcome = await evaluateReadiness(task, {
          folder: suite,
          otherKeys: [],
          renamedFrom: null,
          readBlob: (sha256) => blobs.read(sha256),
          lastSelfCheck: null,
        });
        const where = `${suite}/${task.key}`;
        for (const issue of outcome.readiness.issues) {
          if (issue.rule === 'reference_leak') leaks.push(`${where}: ${issue.message}`);
        }
        const yaml = TaskYamlSchema.parse(parseYaml(task.taskYaml ?? ''));
        if (yaml.self_check?.answers_from_fixtures === true) {
          flagged.push(where);
          const leak = outcome.readiness.rules.find((r) => r.rule === 'reference_leak');
          expect(leak, where).toMatchObject({ status: 'passed', message: ANSWERS_FROM_FIXTURES });
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(flagged.sort()).toEqual(ANSWERS_FROM_DATA);
  });
});
