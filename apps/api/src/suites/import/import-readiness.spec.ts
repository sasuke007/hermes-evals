/**
 * The imports with the drafts module's real readiness rules (SA.8): the
 * board's CSV previews ready rows and one row with a problem, and every task
 * of every committed suite, read from a zip, has no problem, as the same
 * files have none on disk.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskImportPreviewSchema, TaskImportSettingsSchema } from '@hermes-evals/shared';
import { BlobStore } from '../../storage/blob-store.js';
import { evaluateReadiness } from '../drafts/readiness.js';
import { buildImportedTasks, parseTaskTable, readSuiteZip } from './parsers.js';
import { buildZip, zipItemsOfFolder } from './zip-testing.helper-spec.js';

const SUITES_DIR = resolve(import.meta.dirname, '../../../../../suites');

let work: string;
let blobs: BlobStore;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'import-readiness-'));
  blobs = new BlobStore(join(work, 'data'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

const OVERDUE_CSV = `key,question,expected
overdue_fjord,How many overdue invoices does Fjord Software have?,3
overdue_granite,How many overdue invoices does Granite Office have?,2
overdue 90,How many invoices are more than 90 days overdue?,1
`;

it('previews the board rows with the readiness rules', async () => {
  const invoices = await blobs.putBuffer(Buffer.from('invoice,vendor,due\nA-1,Fjord,2026-09-01\n'));
  const table = parseTaskTable('overdue_questions.csv', Buffer.from(OVERDUE_CSV));
  if (!table.ok) throw new Error('not read');
  const settings = TaskImportSettingsSchema.parse({
    mapping: [
      { column: 'key', use: 'task_key' },
      { column: 'question', use: 'prompt' },
      { column: 'expected', use: 'reference_value' },
    ],
    keyPrefix: null,
    answerPath: 'answer',
    workspace: { from: 'upload' },
    checks: {
      from: 'new',
      checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
    },
    limits: { maxTurns: 20, runBudgetSeconds: 300, toolsetsNeeded: ['file', 'terminal'] },
    appendAnswerInstructions: true,
    keyFixes: [],
  });
  const { preview } = await buildImportedTasks(table.rows, settings, {
    folder: 'invoices-v1',
    existingKeys: new Set(['total_due']),
    workspaceSource: null,
    checksSource: null,
    uploads: [{ path: 'fixtures/invoices.csv', kind: 'fixture', ...invoices }],
    readBlob: (sha256) => blobs.read(sha256),
  });
  TaskImportPreviewSchema.parse(preview);
  expect(preview.rows.map((r) => r.readiness)).toEqual(['ready', 'ready', 'problems']);
});

describe.each(['invoices-v1', 'mcp-v1', 'memory-v1', 'knowledge-v1', 'tools-v1'])(
  '%s from a zip',
  (suite) => {
    it('has no task with a problem', async () => {
      const path = join(work, `${suite}.zip`);
      await writeFile(path, await buildZip(await zipItemsOfFolder(join(SUITES_DIR, suite))));
      const read = await readSuiteZip(path, blobs);
      if (!read.ok) throw new Error(JSON.stringify(read.problems));
      const keys = read.contents.tasks.map((t) => t.key);
      for (const task of read.contents.tasks) {
        const { readiness } = await evaluateReadiness(task, {
          folder: suite,
          otherKeys: keys.filter((k) => k !== task.key),
          renamedFrom: null,
          readBlob: (sha256) => blobs.read(sha256),
          lastSelfCheck: null,
        });
        const problems = readiness.rules.filter((r) => r.status === 'problem');
        expect(problems, `${suite}/${task.key}`).toEqual([]);
      }
    });
  },
);
