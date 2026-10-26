/**
 * Shared by the knowledge-v1 specs: where the suite, the skills, the
 * documents, the generator and the mock scripts are; running the generator
 * (scripts/fixtures/knowledge-v1.ts) into a scratch directory and reading
 * the trap answers it writes there; loading the suite with the real loader
 * into PGlite; grading one key of a task with the real scorer on a recorded
 * reply; and a judge that answers as the mock model would, from the
 * suite's mock scripts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  JsonValueSchema,
  LlmJudgeParamsSchema,
  SuiteReloadResultSchema,
  type JsonValue,
  type RunEventPayload,
  type SuiteReloadEntry,
} from '@hermes-evals/shared';
import { tasks } from '../../src/database/schema/index.js';
import { scoreAnswer } from '../../src/scoring/answer.js';
import { extractAnswer } from '../../src/scoring/extraction.js';
import type {
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
} from '../../src/scoring/judge/contracts.js';
import { scoreLlmJudge } from '../../src/scoring/llm-judge.js';
import { parseVerificationEntry } from '../../src/scoring/registry.js';
import type { ScorerResult } from '../../src/scoring/result.js';
import { scoreTrajectory, type TrajectoryEvent } from '../../src/scoring/trajectory.js';
import { BlobStore } from '../../src/storage/blob-store.js';
import { SuiteLoader, type LoaderLogger } from '../../src/suites/loader/suite-loader.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { MockScriptsSchema, type MockScript } from '../invoices-v1/support.js';

export { listFiles, MockScriptsSchema, readText, replyWith } from '../invoices-v1/support.js';
export type { MockScript } from '../invoices-v1/support.js';

export const REPO = join(import.meta.dirname, '../../../..');
export const SUITES_DIR = join(REPO, 'suites');
export const SUITE_DIR = join(SUITES_DIR, 'knowledge-v1');
export const SKILLS_DIR = join(REPO, 'samples/skills');
export const DOCUMENTS_DIR = join(REPO, 'samples/documents/knowledge-v1');
export const GENERATOR = join(REPO, 'scripts/fixtures/knowledge-v1.ts');
export const MOCK_SCRIPTS = 'scripts/phase6b-knowledge-v1-mock-scripts.json';
/** The shipped reader, and its copy among the documents. */
export const BX7_PY = join(SKILLS_DIR, 'bx7-format/scripts/bx7.py');
export const BX7_PY_DOCUMENT = join(DOCUMENTS_DIR, 'bx7.py');

/** The task keys in suite.yaml order (plan 18.3). */
export const TASK_KEYS = [
  'closing_balance',
  'record_counts',
  'large_file',
  'reason_codes',
  'pick_version',
  'house_summary',
  'prompt_override',
  'unrelated',
] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

/** The workspace file each task is about, and whether it is a BX statement. */
export const TASK_FILES: Record<TaskKey, { file: string; statement: boolean }> = {
  closing_balance: { file: 'statement_2026_03.bx7', statement: true },
  record_counts: { file: 'statement_2026_04.bx7', statement: true },
  large_file: { file: 'statement_2026_q2.bx7', statement: true },
  reason_codes: { file: 'statement_2026_05.bx7', statement: true },
  pick_version: { file: 'treasury_export.bx', statement: true },
  house_summary: { file: 'statement_2026_06.bx7', statement: true },
  prompt_override: { file: 'ledger_view_2026_07.bx7', statement: true },
  unrelated: { file: 'expenses.csv', statement: false },
};

/** The three skills of the knowledge arms, in the order a configuration lists them. */
export const SKILL_NAMES = ['bx7-format', 'house-style', 'bx6-format'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/**
 * The phrase each knowledge file holds and no other text does
 * (scripts/fixtures/knowledge-v1/knowledge.ts MARKERS).
 */
export const MARKERS = {
  bx7: 'kv1-bx7-format',
  codes: 'kv1-bx7-codes',
  house: 'kv1-house-style',
  template: 'kv1-summary-template',
  bx6: 'kv1-bx6-format',
} as const;

/** Each document and the skill file it is the text of (front matter dropped from a SKILL.md). */
export const DOCUMENTS: ReadonlyArray<{ doc: string; skill: string }> = [
  { doc: 'bx6-spec.md', skill: 'bx6-format/SKILL.md' },
  { doc: 'bx7-spec.md', skill: 'bx7-format/SKILL.md' },
  { doc: 'bx7.py', skill: 'bx7-format/scripts/bx7.py' },
  { doc: 'codes.md', skill: 'bx7-format/codes.md' },
  { doc: 'house-style.md', skill: 'house-style/SKILL.md' },
  { doc: 'summary-template.md', skill: 'house-style/templates/summary-template.md' },
];

/** SKILL.md without its front matter, as the skill reader splits it. */
export function skillBody(text: string): string {
  const match = /^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/.exec(text);
  if (!match) throw new Error('no front matter');
  return text.slice(match[0].length).replace(/^(?:[ \t]*\n)+/, '');
}

/** SKILL.md's front matter fields, which is all the skills index shows on demand. */
export function frontMatter(text: string): { name: string; description: string } {
  const block = /^---[ \t]*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const field = (key: string) => new RegExp(`^${key}: (.*)$`, 'm').exec(block)?.[1] ?? '';
  return { name: field('name'), description: field('description') };
}

const ObjectSchema = z.record(z.string(), JsonValueSchema);

/** One task's entry in the generator's --traps file. */
export const TrapSchema = z.strictObject({
  answer: ObjectSchema,
  note: z.string().min(1),
  phrase: z.string().min(1),
  file: z.string().min(1),
});
export type Trap = z.infer<typeof TrapSchema>;
const TrapsSchema = z.record(z.enum(TASK_KEYS), TrapSchema);

/** Runs the generator with plain Node; returns its exit status and output. */
export function runGeneratorArgs(args: readonly string[]): {
  status: number | null;
  stderr: string;
} {
  const run = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr };
}

/** Runs the generator into `out`; returns its trap answers. */
export async function runGenerator(out: string): Promise<Record<TaskKey, Trap>> {
  const traps = join(out, 'traps.json');
  const run = runGeneratorArgs(['--out', out, '--traps', traps]);
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

/** suites/knowledge-v1 loaded by the real loader into a fresh PGlite. */
export async function loadKnowledgeSuite(): Promise<LoadedSuite> {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'knowledge-v1-load-'));
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: SUITES_DIR,
    logger: silent,
  });
  const result = SuiteReloadResultSchema.parse(await loader.loadOne('knowledge-v1'));
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

/** What one recorded run left: its final text and its tool calls. */
export interface RecordedRun {
  text: string;
  calls?: { name: string; input: Record<string, unknown> }[];
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

/** The mock model's rule: the first script whose match occurs in the request's text. */
export const chosen = (scripts: readonly MockScript[], text: string): MockScript | null =>
  scripts.find((s) => text.includes(s.match)) ?? null;

/**
 * A JudgeClient that answers as the mock model does: from the first script
 * whose phrase occurs in the judge's two messages, its first step's text.
 */
export function mockJudge(
  scripts: readonly MockScript[],
): JudgeClient & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    complete: (request: JudgeRequest): Promise<JudgeResponse> => {
      requests.push(request);
      const script = chosen(scripts, `${request.messages.system}\n${request.messages.user}`);
      const step = script?.steps[0];
      const text = step && 'content' in step ? step.content : 'Done.';
      return Promise.resolve({
        text,
        tokens: { input: 1, output: 1, total: 2 },
        model: request.model,
        finishReason: 'stop',
        calls: 1,
        callLog: [{ status: 200, latencyMs: 1 }],
        latencyMs: 1,
      });
    },
  };
}

/** The mock judge's settings, as the smoke stack sets JUDGE_*. */
const JUDGE_SETTINGS = {
  provider: 'custom' as const,
  model: 'mock/scripted',
  baseUrl: 'http://mock-model:8090/v1',
};
const NO_PRICES = { sha256: 'a'.repeat(64), loaded_at: '2026-10-26T00:00:00.000Z', models: {} };

/**
 * Grades the key `key` of a loaded task on a recorded run with the real
 * scorer: answer checks on the extracted block, a trajectory_match on the
 * tool calls, an llm_judge through `judge` (the mock's scripts) with the
 * task's rubric.
 */
export async function scoreKey(
  row: TaskRow,
  key: string,
  run: RecordedRun,
  judge?: JudgeClient,
): Promise<ScorerResult> {
  const entry = row.verification.find((v) => v.key === key);
  if (!entry) throw new Error(`${row.key} has no key ${key}`);
  const parsed = parseVerificationEntry(entry);
  if (!parsed.success) throw parsed.error;
  const check = parsed.data;
  switch (check.type) {
    case 'numeric_tolerance':
    case 'json_match':
    case 'exact_match':
    case 'text_match':
      return scoreAnswer(check, extractAnswer(run.text), row.reference ?? null);
    case 'trajectory_match':
      return scoreTrajectory(toolEvents(run.calls), check.params);
    case 'llm_judge': {
      if (!judge) throw new Error(`${row.key}.${key}: an llm_judge key needs a judge`);
      const params = LlmJudgeParamsSchema.parse(check.params);
      return scoreLlmJudge(
        {
          task: {
            key: row.key,
            prompt: await readFile(join(SUITE_DIR, row.key, 'prompt.md'), 'utf8'),
            reference: (row.reference ?? null) as JsonValue | null,
          },
          attempt: { finalText: run.text },
        },
        params,
        {
          judge,
          rubric: await readFile(join(SUITE_DIR, row.key, params.rubric), 'utf8'),
          priceTable: NO_PRICES,
          settings: JUDGE_SETTINGS,
        },
      );
    }
    default:
      throw new Error(`${row.key}.${key}: ${check.type} is not used by knowledge-v1`);
  }
}

/** The key marked primary in a loaded task. */
export const primaryKey = (row: TaskRow): string => row.verification.find((v) => v.primary)!.key;

/** The suite's mock scripts, parsed as the mock model reads MOCK_SCRIPTS. */
export async function knowledgeScripts(): Promise<MockScript[]> {
  return MockScriptsSchema.parse(JSON.parse(await readFile(join(REPO, MOCK_SCRIPTS), 'utf8')));
}
