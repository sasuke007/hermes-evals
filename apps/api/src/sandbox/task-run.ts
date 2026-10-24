/**
 * Runs one suite task folder in a trial with a real model and checks the
 * primary answer key. A development harness ahead of the suite loader and the
 * evaluator (Phases 1 and 3): it reads the folder directly instead of blobs,
 * and checks only answer-based primaries (numeric_tolerance, json_match,
 * exact_match), with the scoring core's extraction and scorers.
 *
 * The reference answer is read here, in the worker, and is never written into
 * the trial: only `fixtures/` reaches the workspace.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  JsonValueSchema,
  TaskLimitsSchema,
  VerificationEntrySchema,
  type ExtractedAnswer,
  type JsonValue,
} from '@hermes-evals/shared';
import { parse } from 'yaml';
import { z } from 'zod';
import { scoreAnswer, scoreReferenceAsAnswer, type AnswerKey } from '../scoring/answer.js';
import { extractAnswer, extractionComment } from '../scoring/extraction.js';
import { isAnswerScorerType, parseScorerParams } from '../scoring/registry.js';
import type { ScorerResult } from '../scoring/result.js';
import { runHermesTrial, type SmokeDeps, type SmokeReport } from './hermes-smoke.js';

const TaskYamlSchema = z.object({
  summary: z.string(),
  limits: TaskLimitsSchema,
  answer: z.object({ format: z.literal('fenced_json'), path: z.string().optional() }),
  verification: z
    .array(VerificationEntrySchema.extend({ primary: z.boolean().default(false) }))
    .min(1),
});

export interface TaskFolder {
  dir: string;
  summary: string;
  prompt: string;
  fixtures: Array<{ path: string; content: Buffer }>;
  reference: JsonValue;
  limits: z.infer<typeof TaskLimitsSchema>;
  /** The primary key, its params parsed and defaulted by the scorer registry. */
  primary: { key: string } & AnswerKey;
}

export async function loadTaskFolder(dir: string): Promise<TaskFolder> {
  const task = TaskYamlSchema.parse(parse(await readFile(join(dir, 'task.yaml'), 'utf8')));
  const primaries = task.verification.filter((v) => v.primary);
  if (primaries.length !== 1) throw new Error(`${dir}: exactly one primary key is required`);
  const entry = primaries[0]!;
  if (!isAnswerScorerType(entry.type)) {
    throw new Error(`${dir}: the task harness does not check ${entry.type} yet`);
  }
  // The answer's `path` applies when the key does not name its own (section 4.2).
  const params = parseScorerParams(entry.type, {
    ...entry.params,
    path: entry.params.path ?? task.answer.path,
  });
  if (!params.success) {
    throw new Error(`${dir}: invalid params for ${entry.key}: ${params.error.message}`);
  }
  const primary = {
    key: entry.key,
    type: entry.type,
    params: params.data,
  } as TaskFolder['primary'];
  const fixturesDir = join(dir, 'fixtures');
  const fixtures: TaskFolder['fixtures'] = [];
  for (const file of await readdir(fixturesDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const full = join(file.parentPath, file.name);
    fixtures.push({ path: relative(fixturesDir, full), content: await readFile(full) });
  }
  const reference = JsonValueSchema.parse(
    JSON.parse(await readFile(join(dir, 'reference.json'), 'utf8')),
  );
  // Self-check (section 4.3): the reference, graded as if it were the answer, must pass.
  const self = scoreReferenceAsAnswer(primary, reference);
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

/** The extracted answer as the sandbox CLI prints it. */
export type Extraction =
  { ok: true; value: JsonValue; start: number; end: number } | { ok: false; reason: string };

export function toExtraction(answer: ExtractedAnswer): Extraction {
  return answer.status === 'found'
    ? { ok: true, value: answer.value, start: answer.start, end: answer.end }
    : { ok: false, reason: extractionComment(answer) };
}

export interface TaskReport {
  task: string;
  summary: string;
  model: string;
  check: ScorerResult;
  answer: Extraction;
  /** The extraction as the evaluator stores it (plan 9.1). */
  extracted: ExtractedAnswer;
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
  const extracted = extractAnswer(trial.finalText);
  return {
    task: dir,
    summary: task.summary,
    model: deps.model,
    check: scoreAnswer(task.primary, extracted, task.reference),
    answer: toExtraction(extracted),
    extracted,
    trial,
  };
}
