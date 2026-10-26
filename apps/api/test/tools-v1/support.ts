/**
 * Shared by the tools-v1 specs: where the suite, the generator and the mock
 * scripts are; running the generator into a scratch directory and reading
 * the trap answers it writes there (scripts/fixtures/tools-v1.ts); loading
 * the suite with the real loader into PGlite; and grading one key of a task
 * with the real scorer on a recorded reply, against the task's fixtures with
 * the run's files on top or against a workspace a test prepared.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { REPO, SUITES_DIR } from '../invoices-v1/support.js';

export { listFiles, MockScriptsSchema, readText, replyWith, REPO } from '../invoices-v1/support.js';
export type { MockScript } from '../invoices-v1/support.js';

export const SUITE = 'tools-v1';
export const SUITE_DIR = join(SUITES_DIR, SUITE);
export const GENERATOR = join(REPO, 'scripts/fixtures/tools-v1.ts');
export const MOCK_SCRIPTS = 'scripts/phase6b-tools-v1-mock-scripts.json';

/** The task keys in suite.yaml order (plan 18.3). */
export const TASK_KEYS = [
  'big_csv',
  'extract_ibans',
  'reshape_json',
  'checksum',
  'join_three',
  'small_lookup',
] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

/** The control: every arm should pass it. */
export const CONTROL: TaskKey = 'small_lookup';

const ObjectSchema = z.record(z.string(), JsonValueSchema);

/** One task's entry in the generator's --traps file. */
export const TrapSchema = z.strictObject({
  answer: ObjectSchema,
  files: z.record(z.string(), z.string()).optional(),
  note: z.string().min(1),
});
export type Trap = z.infer<typeof TrapSchema>;
const TrapsSchema = z.record(z.enum(TASK_KEYS), TrapSchema);

/** Runs the generator with plain Node and these arguments; its exit status and output. */
export function generator(args: readonly string[]): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr };
}

/** Runs the generator into `out`; returns its trap answers. */
export async function runGenerator(out: string): Promise<Record<TaskKey, Trap>> {
  const traps = join(out, 'traps.json');
  const run = generator(['--out', out, '--traps', traps]);
  if (run.status !== 0) throw new Error(`the generator failed: ${run.stderr}`);
  return TrapsSchema.parse(JSON.parse(await readFile(traps, 'utf8'))) as Record<TaskKey, Trap>;
}

export type TaskRow = typeof tasks.$inferSelect;

export interface LoadedSuite {
  entry: SuiteReloadEntry;
  /** The suite's task rows in suite.yaml order. */
  rows: TaskRow[];
  byKey: Map<string, TaskRow>;
  db: TestDatabase;
  close(): Promise<void>;
}

const silent = { info: () => {}, warn: () => {}, error: () => {} } as unknown as LoaderLogger;

/** suites/tools-v1 loaded by the real loader (self-checks run python3) into a fresh PGlite. */
export async function loadToolsSuite(): Promise<LoadedSuite> {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'tools-v1-load-'));
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: SUITES_DIR,
    logger: silent,
  });
  const result = SuiteReloadResultSchema.parse(await loader.loadOne(SUITE));
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
    close: async () => {
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** What one recorded run left: its final text, its workspace, its tool calls. */
export interface RecordedRun {
  text: string;
  /** Workspace files the agent wrote, by path, on top of the task's fixtures. */
  files?: Record<string, string>;
  /** A workspace a test already prepared (the mock runs' own); `files` is then not used. */
  workspace?: string;
  calls?: { name: string; input: Record<string, unknown> }[];
}

/** The task's fixtures with the run's files on top: the workspace the worker would rebuild. */
async function withWorkspace<T>(
  key: string,
  run: RecordedRun,
  use: (workspace: string, scratch: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `tools-v1-${key}-`));
  try {
    await mkdir(join(root, 'scratch'));
    if (run.workspace !== undefined) return await use(run.workspace, join(root, 'scratch'));
    const workspace = join(root, 'workspace');
    await cp(join(SUITE_DIR, key, 'fixtures'), workspace, { recursive: true });
    for (const [path, content] of Object.entries(run.files ?? {})) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content);
    }
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
 * file_check or verifier on the workspace, a trajectory_match on the tool
 * calls.
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
      throw new Error(`${row.key}.${key}: tools-v1 has no llm_judge key`);
  }
}

/** The key marked primary in a loaded task. */
export const primaryKey = (row: TaskRow): string => row.verification.find((v) => v.primary)!.key;
