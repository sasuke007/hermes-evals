/**
 * Runs one suite task folder in a trial with a real model and checks the
 * primary answer key. A development harness ahead of the suite loader and the
 * scorers (Phases 1 and 3): it reads the folder directly instead of blobs, and
 * checks only `numeric_tolerance` and `exact_match` primaries.
 *
 * The reference answer is read here, in the worker, and is never written into
 * the trial: only `fixtures/` reaches the workspace.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TaskLimitsSchema, VerificationEntrySchema, type ScoreStatus } from '@hermes-evals/shared';
import { parse } from 'yaml';
import { z } from 'zod';
import { runHermesTrial, type SmokeDeps, type SmokeReport } from './hermes-smoke.js';

const TaskYamlSchema = z.object({
  summary: z.string(),
  limits: TaskLimitsSchema,
  answer: z.object({ format: z.literal('fenced_json'), path: z.string().optional() }),
  verification: z
    .array(VerificationEntrySchema.extend({ primary: z.boolean().default(false) }))
    .min(1),
});

const NumericParamsSchema = z.object({
  path: z.string().optional(),
  abs: z.number().nonnegative().optional(),
  rel: z.number().nonnegative().optional(),
});
const ExactParamsSchema = z.object({
  path: z.string().optional(),
  trim: z.boolean().default(true),
  case_sensitive: z.boolean().default(true),
});
const PARAM_SCHEMAS: Partial<Record<string, z.ZodType>> = {
  numeric_tolerance: NumericParamsSchema.strict(),
  exact_match: ExactParamsSchema.strict(),
};

export interface TaskFolder {
  dir: string;
  summary: string;
  prompt: string;
  fixtures: Array<{ path: string; content: Buffer }>;
  reference: unknown;
  limits: z.infer<typeof TaskLimitsSchema>;
  primary: z.infer<typeof TaskYamlSchema>['verification'][number];
}

export async function loadTaskFolder(dir: string): Promise<TaskFolder> {
  const task = TaskYamlSchema.parse(parse(await readFile(join(dir, 'task.yaml'), 'utf8')));
  const primaries = task.verification.filter((v) => v.primary);
  if (primaries.length !== 1) throw new Error(`${dir}: exactly one primary key is required`);
  // The answer's `path` applies when the key does not name its own (section 4.2).
  const primary = {
    ...primaries[0]!,
    params: { ...primaries[0]!.params, path: primaries[0]!.params.path ?? task.answer.path },
  };
  const paramSchema = PARAM_SCHEMAS[primary.type];
  if (!paramSchema) throw new Error(`${dir}: the task harness does not check ${primary.type} yet`);
  const params = paramSchema.safeParse(primary.params);
  if (!params.success) {
    throw new Error(`${dir}: invalid params for ${primary.key}: ${params.error.message}`);
  }
  const fixturesDir = join(dir, 'fixtures');
  const fixtures: TaskFolder['fixtures'] = [];
  for (const entry of await readdir(fixturesDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    fixtures.push({ path: relative(fixturesDir, full), content: await readFile(full) });
  }
  const reference = JSON.parse(await readFile(join(dir, 'reference.json'), 'utf8')) as unknown;
  // Self-check (section 4.3): the reference, graded as if it were the answer, must pass.
  const self = checkPrimary(primary, { ok: true, value: reference, start: 0, end: 0 }, reference);
  if (self.status !== 'passed') {
    throw new Error(`${dir}: self-check failed for ${primary.key}: ${self.comment}`);
  }
  return {
    dir,
    summary: task.summary,
    prompt: await readFile(join(dir, 'prompt.md'), 'utf8'),
    fixtures,
    reference,
    limits: task.limits,
    primary,
  };
}

export type Extraction =
  { ok: true; value: unknown; start: number; end: number } | { ok: false; reason: string };

/**
 * Section 9.1: the last fenced block tagged `json` in the final text, parsed.
 * Fences are read line by line as CommonMark does, so a ```json block quoted
 * inside a longer fence is content, not an answer. An unclosed ```json block
 * after the last complete one makes the answer ungradable, rather than
 * grading an earlier block (often the echoed template).
 */
export function extractAnswer(text: string | null): Extraction {
  if (!text) return { ok: false, reason: 'no final response' };
  const blocks: Array<{ body: string; start: number; end: number }> = [];
  let open: {
    char: string;
    length: number;
    json: boolean;
    start: number;
    bodyStart: number;
  } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    const bare = line.replace(/\r$/, '');
    if (!open) {
      // Any indentation: answers often sit inside a list item.
      const opener = /^\s*(`{3,}|~{3,})(.*)$/.exec(bare);
      if (opener && !(opener[1]![0] === '`' && opener[2]!.includes('`'))) {
        const info = opener[2]!.trim().split(/\s+/)[0]!.toLowerCase();
        open = {
          char: opener[1]![0]!,
          length: opener[1]!.length,
          json: info === 'json',
          start: offset,
          bodyStart: Math.min(lineEnd + 1, text.length),
        };
      }
    } else {
      const closer = /^\s*(`{3,}|~{3,})[ \t]*$/.exec(bare);
      if (closer && closer[1]![0] === open.char && closer[1]!.length >= open.length) {
        if (open.json) {
          blocks.push({
            body: text.slice(open.bodyStart, offset),
            start: open.start,
            end: lineEnd,
          });
        }
        open = null;
      }
    }
    offset = lineEnd + 1;
  }
  if (open?.json) {
    return { ok: false, reason: 'the last ```json block is not closed' };
  }
  const last = blocks.at(-1);
  if (!last) return { ok: false, reason: 'no fenced JSON block found in final response' };
  try {
    return { ok: true, value: JSON.parse(last.body) as unknown, start: last.start, end: last.end };
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }
}

function atPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let node = value;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** The statuses a score can have (shared vocabulary): passed, failed, error, ungradable. */
export interface PrimaryCheck {
  status: ScoreStatus;
  observed?: unknown;
  expected?: unknown;
  comment: string;
}

/**
 * Floating-point slack: a few units in the last place of the numbers compared, so a
 * tolerance of 0.01 accepts exactly one cent either way without loosening it.
 */
const ULPS = 64 * Number.EPSILON;

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function checkPrimary(
  primary: TaskFolder['primary'],
  answer: Extraction,
  reference: unknown,
): PrimaryCheck {
  if (!answer.ok) return { status: 'ungradable', comment: answer.reason };
  const params = primary.params as { path?: string } & Record<string, unknown>;
  const observed = atPath(answer.value, params.path);
  const expected = atPath(reference, params.path);
  if (expected === undefined) {
    return {
      status: 'error',
      comment: `the reference has no value at ${params.path ?? 'the root'}`,
    };
  }
  if (observed === undefined) {
    return {
      status: 'failed',
      expected,
      comment: `the answer has no value at ${params.path ?? 'the root'}`,
    };
  }

  if (primary.type === 'numeric_tolerance') {
    const { abs, rel } = NumericParamsSchema.parse(params);
    const want = asNumber(expected);
    if (want === undefined)
      return { status: 'error', expected, comment: 'the reference is not a number' };
    const got = asNumber(observed);
    if (got === undefined)
      return { status: 'failed', observed, expected, comment: 'the answer is not a number' };
    const diff = Math.abs(got - want);
    const slack = ULPS * Math.max(1, Math.abs(want), Math.abs(got));
    const within =
      (abs !== undefined && diff <= abs + slack) ||
      (rel !== undefined && diff <= rel * Math.abs(want) + slack) ||
      (abs === undefined && rel === undefined && diff <= slack);
    return {
      status: within ? 'passed' : 'failed',
      observed,
      expected,
      comment: `|observed − expected| = ${diff.toPrecision(6)}`,
    };
  }

  if (primary.type === 'exact_match') {
    const { trim, case_sensitive } = ExactParamsSchema.parse(params);
    const norm = (value: unknown) => {
      let text = typeof value === 'string' ? value : JSON.stringify(value);
      if (trim) text = text.trim();
      return case_sensitive ? text : text.toLowerCase();
    };
    const same = norm(observed) === norm(expected);
    return {
      status: same ? 'passed' : 'failed',
      observed,
      expected,
      comment: same ? 'equal' : 'differs',
    };
  }
  return { status: 'error', comment: `the task harness does not check ${primary.type} yet` };
}

export interface TaskReport {
  task: string;
  summary: string;
  model: string;
  check: PrimaryCheck;
  answer: Extraction;
  trial: SmokeReport;
}

export async function runTask(
  deps: SmokeDeps,
  dir: string,
  maxTokens = 300_000,
): Promise<TaskReport> {
  const task = await loadTaskFolder(dir);
  const trial = await runHermesTrial(deps, {
    prompt: task.prompt,
    fixtures: task.fixtures,
    toolsets: task.limits.toolsets_needed,
    maxTurns: task.limits.max_turns,
    budgetSeconds: task.limits.run_budget_seconds,
    // The run budget ends the turn; the container deadline is the backstop.
    deadlineMs: (task.limits.run_budget_seconds + 120) * 1000,
    maxTokens,
  });
  const answer = extractAnswer(trial.finalText);
  return {
    task: dir,
    summary: task.summary,
    model: deps.model,
    check: checkPrimary(task.primary, answer, task.reference),
    answer,
    trial,
  };
}
