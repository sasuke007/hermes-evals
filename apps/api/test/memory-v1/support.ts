/**
 * Shared by the memory-v1 specs: where the suite, the generator and the mock
 * scripts are; running the generator (scripts/fixtures/memory-v1.ts) and
 * reading the trap answers it writes; loading the suite with the real loader
 * into PGlite; the memory blocks Hermes puts in the system prompt with memory
 * on; and grading one key of a task with the real scorer on a recorded run,
 * whose workspace and home are rebuilt as the evaluation would rebuild them.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  JsonValueSchema,
  MEMORY_ENTRY_DELIMITER,
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
import { memoryEntries } from '../../src/suites/loader/home-seeds.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { readText, REPO, type MockScript } from '../invoices-v1/support.js';

export { listFiles, MockScriptsSchema, readText, REPO, replyWith } from '../invoices-v1/support.js';
export type { MockScript } from '../invoices-v1/support.js';

export const SUITES_DIR = join(REPO, 'suites');
export const SUITE_DIR = join(SUITES_DIR, 'memory-v1');
export const GENERATOR = join(REPO, 'scripts/fixtures/memory-v1.ts');
export const MOCK_SCRIPTS = 'scripts/phase6b-memory-v1-mock-scripts.json';

/** The task keys in suite.yaml order (plan 18.3). */
export const TASK_KEYS = [
  'usual_currency',
  'vendor_alias',
  'standing_exclusion',
  'prompt_wins',
  'data_wins',
  'needle',
  'remember_this',
  'keep_private',
] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

/** The tasks where memory can only mislead: an agent without memory answers them right. */
export const MEMORY_CAN_ONLY_MISLEAD: readonly TaskKey[] = [
  'prompt_wins',
  'data_wins',
  'keep_private',
];

/** The two memory files a task seeds, as paths in the trial home. */
export const MEMORY_FILES = ['memories/USER.md', 'memories/MEMORY.md'] as const;

const ObjectSchema = z.record(z.string(), JsonValueSchema);

/** One task's entry in the generator's --traps file. */
export const TrapSchema = z.strictObject({
  answer: ObjectSchema,
  files: z.record(z.string(), z.string()).optional(),
  note: z.string().min(1),
  seed_marker: z.string().regex(/^ref mv1-s\d{2}$/),
  prompt_marker: z.string().regex(/^Ticket mv1-t\d{2}$/),
  off_passes: z.boolean(),
});
export type Trap = z.infer<typeof TrapSchema>;
const TrapsSchema = z.record(z.enum(TASK_KEYS), TrapSchema);

/** Runs the generator with plain Node; returns its exit status and output. */
export function generator(args: readonly string[]): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr };
}

/** Runs the generator into `out`; returns its trap answers. */
export async function runGenerator(out: string): Promise<Record<TaskKey, Trap>> {
  const traps = join(out, 'traps.json');
  const run = generator(['--out', out, '--traps', traps]);
  if (run.status !== 0) throw new Error(`the generator failed: ${run.stderr}`);
  return TrapsSchema.parse(JSON.parse(await readText(traps))) as Record<TaskKey, Trap>;
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

/** suites/memory-v1 loaded by the real loader (self-checks run python3) into a fresh PGlite. */
export async function loadMemorySuite(): Promise<LoadedSuite> {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'memory-v1-load-'));
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: SUITES_DIR,
    logger: silent,
  });
  const result = SuiteReloadResultSchema.parse(await loader.loadOne('memory-v1'));
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

/** A task's seeds, by path in the trial home (`memories/USER.md`). */
export async function seedsOf(key: TaskKey): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    MEMORY_FILES.map(async (path) => [path, await readText(SUITE_DIR, key, 'home', path)]),
  );
  return Object.fromEntries(pairs) as Record<string, string>;
}

/**
 * The memory blocks Hermes puts in the system prompt with memory on
 * (tools/memory_tool_store.py `_render_block`): a header, then the entries
 * joined by the delimiter, MEMORY.md first. With memory off there are none.
 */
export async function memoryBlocks(key: TaskKey): Promise<string> {
  const seeds = await seedsOf(key);
  const rule = '═'.repeat(46);
  const block = (title: string, text: string) =>
    `${rule}\n${title}\n${rule}\n${memoryEntries(text).join(MEMORY_ENTRY_DELIMITER)}`;
  return [
    block('MEMORY (your personal notes)', seeds['memories/MEMORY.md']!),
    block('USER PROFILE (who the user is)', seeds['memories/USER.md']!),
  ].join('\n\n');
}

/** What Hermes's memory tool leaves after `add`: the file's entries and the new one, joined, no newline. */
export const afterMemoryAdd = (text: string, entry: string): string =>
  [...memoryEntries(text), entry].join(MEMORY_ENTRY_DELIMITER);

/** The recommended arms: memory off (the baseline) and memory on, with the same seeds. */
export type Arm = 'off' | 'on';
export type ToolStep = Extract<MockScript['steps'][number], { tool: string }>;

/** What a tool call returns to the model in this task's trial. */
export async function toolResult(key: TaskKey, step: ToolStep): Promise<string> {
  const path = typeof step.arguments.path === 'string' ? step.arguments.path : '';
  if (step.tool === 'read_file') {
    return readText(SUITE_DIR, key, 'fixtures', path.replace(/^\/workspace\//, ''));
  }
  if (step.tool === 'memory') return JSON.stringify({ success: true, done: true, target: 'user' });
  return JSON.stringify({ success: true, path });
}

/** One played run: each request's text and the match of the script that answered it. */
export interface Played {
  requests: string[];
  picked: string[];
}

/**
 * Plays one run of `key` by apps/egress/src/mock-model.ts's rule: request n
 * (n tool results so far) gets step n of the first script whose match it
 * holds. With memory on the system prompt carries the seeds as Hermes
 * renders them; with memory off it carries none. Then the prompt, then each
 * call's arguments and result.
 */
export async function play(
  scripts: readonly MockScript[],
  key: TaskKey,
  arm: Arm,
  prompt: string,
): Promise<Played> {
  const sent = [arm === 'on' ? await memoryBlocks(key) : 'You are Hermes.', prompt];
  const run: Played = { requests: [], picked: [] };
  for (let n = 0; n < 10; n++) {
    const text = sent.join('\n');
    const script = scripts.find((s) => text.includes(s.match));
    if (!script) throw new Error(`${key}, memory ${arm}: no script answers request ${n + 1}`);
    run.requests.push(text);
    run.picked.push(script.match);
    const step = script.steps[Math.min(n, script.steps.length - 1)]!;
    if ('content' in step) return run;
    sent.push(JSON.stringify(step.arguments), await toolResult(key, step));
  }
  throw new Error(`${key}, memory ${arm}: no answer after 10 requests`);
}

/** What one recorded run left: its final text, the files it wrote, its memory files, its tool calls. */
export interface RecordedRun {
  text: string;
  /** Workspace files the agent wrote, by path, on top of the task's fixtures. */
  files?: Record<string, string>;
  /** Memory files the agent left (`memories/USER.md`), on top of the task's seeds. */
  home?: Record<string, string>;
  calls?: { name: string; input: Record<string, unknown> }[];
  /**
   * A run with memory off (Phase 8 G9): no seed was copied in and
   * home/memories was not collected, so its home is rebuilt empty.
   */
  memoryOff?: true;
}

async function writeAll(root: string, files: Record<string, string> | undefined): Promise<void> {
  for (const [path, content] of Object.entries(files ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

const exists = (dir: string) =>
  readdir(dir).then(
    () => true,
    () => false,
  );

/**
 * The task's fixtures and seeds with the run's files on top: the folders the
 * evaluation would rebuild. With memory off the home stays empty: the seeds
 * never entered the run, and nothing was collected from it (Phase 8 G9).
 */
async function withFolders<T>(
  key: string,
  run: RecordedRun,
  use: (dirs: { workspace: string; home: string; scratch: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `memory-v1-${key}-`));
  try {
    const dirs = {
      workspace: join(root, 'workspace'),
      home: join(root, 'home'),
      scratch: join(root, 'scratch'),
    };
    for (const dir of Object.values(dirs)) await mkdir(dir);
    const fixtures = join(SUITE_DIR, key, 'fixtures');
    if (await exists(fixtures)) await cp(fixtures, dirs.workspace, { recursive: true });
    await writeAll(dirs.workspace, run.files);
    if (!run.memoryOff) {
      await cp(join(SUITE_DIR, key, 'home'), dirs.home, { recursive: true });
      await writeAll(dirs.home, run.home);
    }
    return await use(dirs);
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
 * verifier with the rebuilt workspace and home, a trajectory_match on the
 * tool calls.
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
      return withFolders(row.key, run, (dirs) =>
        checkFile(check.params, check.params.root === 'home' ? dirs.home : dirs.workspace),
      );
    case 'verifier_script':
      return withFolders(row.key, run, (dirs) =>
        scoreVerifierScript(check.params, {
          verifyDir: join(SUITE_DIR, row.key, 'verify'),
          answer: answer.status === 'found' ? answer.value : null,
          workspaceDir: dirs.workspace,
          homeDir: dirs.home,
          scratchDir: dirs.scratch,
        }),
      );
    case 'trajectory_match':
      return scoreTrajectory(toolEvents(run.calls), check.params);
    case 'llm_judge':
      throw new Error(`${row.key}.${key}: memory-v1 has no llm_judge key`);
  }
}

/** The key marked primary in a loaded task. */
export const primaryKey = (row: TaskRow): string => row.verification.find((v) => v.primary)!.key;
