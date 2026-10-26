/**
 * Shared by the invoices-v1 specs: where the suite, the skill, the generator
 * and the mock scripts are; running the generator into a scratch directory
 * and reading the trap answers it writes there (scripts/fixtures/invoices-v1.ts);
 * loading the suite with the real loader into PGlite; and grading one key
 * of a task with the real scorer on a recorded reply.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  JsonValueSchema,
  SuiteReloadResultSchema,
  type RunEventPayload,
  type SuiteReloadEntry,
} from '@hermes-evals/shared';
import { tasks } from '../../src/database/schema/index.js';
import { scoreAnswer } from '../../src/scoring/answer.js';
import { extractAnswer } from '../../src/scoring/extraction.js';
import { checkFile } from '../../src/scoring/file-check.js';
import { parseVerificationEntry } from '../../src/scoring/registry.js';
import type { ScorerResult } from '../../src/scoring/result.js';
import { scoreTrajectory, type TrajectoryEvent } from '../../src/scoring/trajectory.js';
import { scoreVerifierScript } from '../../src/scoring/verifier.js';
import { BlobStore } from '../../src/storage/blob-store.js';
import { SuiteLoader, type LoaderLogger } from '../../src/suites/loader/suite-loader.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

export const REPO = join(import.meta.dirname, '../../../..');
export const SUITES_DIR = join(REPO, 'suites');
export const SUITE_DIR = join(SUITES_DIR, 'invoices-v1');
export const SKILL_DIR = join(REPO, 'samples/skills/invoice-method');
export const GENERATOR = join(REPO, 'scripts/fixtures/invoices-v1.ts');
export const MOCK_SCRIPTS = 'scripts/phase6-mock-scripts.json';

/** The task keys in suite.yaml order (plan 18.1). */
export const TASK_KEYS = [
  'total_due',
  'overdue_list',
  'dup_invoices',
  'vat_split',
  'credit_notes',
  'currency_mix',
  'missing_po',
  'late_fees',
  'per_vendor',
  'disputed',
  'partial_pay',
  'summary_file',
] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

/** The sentence of SKILL.md the with-skill mock script matches. */
export const SKILL_PHRASE = 'Reconcile the whole ledger before you report any figure.';

const ObjectSchema = z.record(z.string(), JsonValueSchema);

/** One task's entry in the generator's --traps file. */
export const TrapSchema = z.strictObject({
  answer: ObjectSchema,
  files: z.record(z.string(), z.string()).optional(),
  note: z.string().min(1),
  phrase: z.string().min(1),
  baseline_trapped: z.boolean(),
});
export type Trap = z.infer<typeof TrapSchema>;
const TrapsSchema = z.record(z.enum(TASK_KEYS), TrapSchema);

/** A mock-model script as apps/egress/src/mock-model.ts reads MOCK_SCRIPTS. */
export const MockScriptsSchema = z.array(
  z.strictObject({
    match: z.string().min(1),
    steps: z
      .array(
        z.union([
          z.strictObject({ tool: z.string().min(1), arguments: ObjectSchema }),
          z.strictObject({ content: z.string() }),
        ]),
      )
      .min(1),
  }),
);
export type MockScript = z.infer<typeof MockScriptsSchema>[number];

/** Runs the generator with plain Node into `out`; returns its trap answers. */
export async function runGenerator(out: string): Promise<Record<TaskKey, Trap>> {
  const traps = join(out, 'traps.json');
  const run = spawnSync(process.execPath, [GENERATOR, '--out', out, '--traps', traps], {
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`the generator failed: ${run.stderr}`);
  return TrapsSchema.parse(JSON.parse(await readFile(traps, 'utf8'))) as Record<TaskKey, Trap>;
}

/** Every regular file under `dir`, relative to it, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

export const readText = (...path: string[]): Promise<string> => readFile(join(...path), 'utf8');

export type TaskRow = typeof tasks.$inferSelect;

export interface LoadedSuite {
  entry: SuiteReloadEntry;
  /** The suite's task rows in suite.yaml order. */
  rows: TaskRow[];
  byKey: Map<string, TaskRow>;
  db: TestDatabase;
  /** The scratch root of the blob store. */
  root: string;
  close(): Promise<void>;
}

const silent = { info: () => {}, warn: () => {}, error: () => {} } as unknown as LoaderLogger;

/** suites/invoices-v1 loaded by the real loader (self-checks run python3) into a fresh PGlite. */
export async function loadInvoicesSuite(): Promise<LoadedSuite> {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'invoices-v1-load-'));
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: SUITES_DIR,
    logger: silent,
  });
  const result = SuiteReloadResultSchema.parse(await loader.loadOne('invoices-v1'));
  const entry = result.suites[0]!;
  const rows =
    entry.suiteId === null
      ? []
      : await db.db
          .select()
          .from(tasks)
          .where(eq(tasks.suiteId, entry.suiteId))
          .orderBy(asc(tasks.position));
  return {
    entry,
    rows,
    byKey: new Map(rows.map((r) => [r.key, r])),
    db,
    root,
    close: async () => {
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** What one recorded run left: its final text, the files it wrote, its tool calls. */
export interface RecordedRun {
  text: string;
  /** Workspace files the agent wrote, by path, on top of the task's fixtures. */
  files?: Record<string, string>;
  calls?: { name: string; input: Record<string, unknown> }[];
}

/** The final text of a reply that ends with `answer` as its fenced JSON block. */
export const replyWith = (answer: unknown): string =>
  `Here is the result.\n\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;

/** The task's fixtures with the run's files on top: the workspace the worker would rebuild. */
async function withWorkspace<T>(
  key: string,
  run: RecordedRun,
  use: (workspace: string, scratch: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `invoices-v1-${key}-`));
  try {
    const workspace = join(root, 'workspace');
    await cp(join(SUITE_DIR, key, 'fixtures'), workspace, { recursive: true });
    for (const [path, content] of Object.entries(run.files ?? {})) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content);
    }
    await mkdir(join(root, 'scratch'));
    return await use(workspace, join(root, 'scratch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Tool events as Hermes writes them: each tool_use answered by its tool_result. */
function toolEvents(calls: RecordedRun['calls']): TrajectoryEvent[] {
  const payloads = (calls ?? []).flatMap((call, i) => [
    { type: 'tool_use', name: call.name, tool_call_id: `call_${i}`, input: call.input },
    {
      type: 'tool_result',
      name: call.name,
      tool_call_id: `call_${i}`,
      output: 'ok',
      is_error: false,
    },
  ]) as RunEventPayload[];
  return payloads.map((payload, i) => ({ seq: i + 1, type: payload.type, payload }));
}

/**
 * Grades the key `key` of a loaded task on a recorded run with the real
 * scorer, as the evaluation would: answer checks on the extracted block, a
 * file_check or verifier on the rebuilt workspace, a trajectory_match on the
 * tool calls. llm_judge is never called here.
 */
export async function scoreKey(row: TaskRow, key: string, run: RecordedRun): Promise<ScorerResult> {
  const entry = row.verification.find((v) => v.key === key);
  if (!entry) throw new Error(`${row.key} has no key ${key}`);
  const parsed = parseVerificationEntry(entry);
  if (!parsed.success) throw parsed.error;
  const check = parsed.data;
  const answer = extractAnswer(run.text);
  switch (check.type) {
    case 'numeric_tolerance':
    case 'json_match':
    case 'exact_match':
    case 'text_match':
      return scoreAnswer(check, answer, row.reference ?? null);
    case 'file_check':
      return withWorkspace(row.key, run, (workspace) => checkFile(check.params, workspace));
    case 'verifier_script':
      return withWorkspace(row.key, run, (workspace, scratch) =>
        scoreVerifierScript(check.params, {
          verifyDir: join(SUITE_DIR, row.key, 'verify'),
          answer: answer.status === 'found' ? answer.value : null,
          workspaceDir: workspace,
          scratchDir: scratch,
        }),
      );
    case 'trajectory_match':
      return scoreTrajectory(toolEvents(run.calls), check.params);
    case 'llm_judge':
      throw new Error(`${row.key}.${key}: llm_judge is not run in tests`);
  }
}

/** The key marked primary in a loaded task. */
export const primaryKey = (row: TaskRow): string => row.verification.find((v) => v.primary)!.key;
