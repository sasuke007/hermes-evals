/**
 * The scoring step of an evaluation (plan 9.2-9.4): every verification key
 * of the task, graded over stored evidence. Pure with respect to the
 * database: it reads, and writes nothing, so it can run outside any
 * transaction and be thrown away when this delivery loses its claim.
 *
 * Per type:
 * - numeric_tolerance, json_match, exact_match, text_match: the extracted
 *   answer, against the reference or (text_match) on its own
 *   (scoring/answer.ts). A missing or invalid answer block makes each of
 *   them `ungradable`, never a zero (plan 9.1);
 * - file_check: the end-state workspace rebuilt from artifact blobs, or with
 *   `root: home` the collected home files (Phase 6 P2);
 * - verifier_script: the task's script with the answer (or JSON null) and its
 *   own fresh copy of that workspace and of the home files (`--home`), under
 *   the Phase 1 runner's minimal environment;
 * - trajectory_match: the attempt's tool_use and tool_result events
 *   (scoring/trajectory.ts); events that cannot be read give `error`;
 * - llm_judge: the judge (scoring/llm-judge.ts) on the final text, with the
 *   rubric read from the task's rubric blob, the context's judge client and
 *   settings, and the experiment's frozen price table.
 *
 * Every key yields exactly one result: a scorer that throws, invalid stored
 * params, or a workspace that cannot be rebuilt all give `error` with the
 * reason (plan 9.2), never a zero and never a missing key, because the
 * database publishes only a complete key set.
 *
 * Between keys the caller may renew its claim (Phase 3 S8): `keepClaim`
 * answers false once a newer delivery owns the evaluation, and the pass
 * stops there, dropping its work. It stops the same way once `signal` is
 * aborted: pg-boss gave up on this delivery and will deliver the job again.
 */
import { z } from 'zod';
import type {
  ExtractedAnswer,
  FileCheckParams,
  LlmJudgeParams,
  ScorerType,
  TrajectoryMatchParams,
  VerificationEntry,
} from '@hermes-evals/shared';
import { scoreAnswer } from '../scoring/answer.js';
import { extractAnswer } from '../scoring/extraction.js';
import { checkFile, MAX_CHECKED_FILE_BYTES } from '../scoring/file-check.js';
import { scoreLlmJudge } from '../scoring/llm-judge.js';
import { parseVerificationEntry, SCORER_VERSIONS } from '../scoring/registry.js';
import {
  binary,
  describeThrown,
  guardedAsync,
  scorerError,
  type ScorerResult,
} from '../scoring/result.js';
import { scoreTrajectory } from '../scoring/trajectory.js';
import { scoreVerifierScript } from '../scoring/verifier.js';
import { openScorerContext, type ScorerContext, type ScorerContextDeps } from './context.js';
import type { EvaluationEvidence } from './evidence.js';
import { normaliseRelativePath } from './workspace.js';

/** One key's result, ready to be written as a score row. */
export interface ScoreDraft {
  key: string;
  type: ScorerType;
  isPrimary: boolean;
  /** SCORER_VERSIONS[type] when the key was graded. */
  scorerVersion: number;
  result: ScorerResult;
}

/** What one scoring pass produced: the answer it extracted and one result per declared key. */
export interface ScoredEvaluation {
  answer: ExtractedAnswer;
  scores: ScoreDraft[];
}

/** The artifact stored at a path of `root`, matched the way collection stores paths. */
function artifactAt(ctx: ScorerContext, root: FileCheckParams['root'], path: string) {
  const wanted = normaliseRelativePath(path);
  return wanted === null
    ? undefined
    : ctx.artifacts.find((a) => a.root === root && a.path === wanted);
}

async function scoreFileCheck(ctx: ScorerContext, params: FileCheckParams): Promise<ScorerResult> {
  const artifact = artifactAt(ctx, params.root, params.path);
  const evidence = artifact ? { artifact_ids: [artifact.id] } : {};
  if (artifact && artifact.sha256 === null) {
    // Collection recorded the file without content; the rebuilt workspace lacks
    // it, which must not read as "does not exist". checkFile fails an
    // oversized file the same way when it finds one on disk.
    const why =
      artifact.skippedReason === 'over_budget'
        ? `the attempt's ${params.root === 'home' ? 'files' : 'workspace'} passed the collection budget`
        : `it is larger than ${MAX_CHECKED_FILE_BYTES} bytes`;
    return binary(
      false,
      `${params.path} was not stored because ${why}, so its content cannot be checked`,
      {
        observed: { path: params.path, exists: true, size: artifact.size },
        evidence,
      },
    );
  }
  const what = params.root === 'home' ? 'the home files' : 'the workspace';
  let rootDir: string;
  try {
    rootDir = params.root === 'home' ? await ctx.home() : await ctx.workspace();
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`could not rebuild ${what} from stored files: ${message}`, detail);
  }
  const result = await checkFile(params, rootDir);
  return { ...result, evidence: { ...result.evidence, ...evidence } };
}

async function scoreVerifier(
  ctx: ScorerContext,
  params: Parameters<typeof scoreVerifierScript>[0],
): Promise<ScorerResult> {
  let dirs;
  try {
    dirs = await ctx.verifierDirs();
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(
      `could not rebuild the workspace, home files and verify/ folder from stored files: ${message}`,
      detail,
    );
  }
  try {
    return await scoreVerifierScript(params, {
      verifyDir: dirs.verifyDir,
      // A verifier may judge the workspace alone, so it runs without an answer too.
      answer: ctx.answer.status === 'found' ? ctx.answer.value : null,
      workspaceDir: dirs.workspaceDir,
      homeDir: dirs.homeDir,
      scratchDir: dirs.scratchDir,
      python: ctx.python,
    });
  } finally {
    await dirs.dispose().catch(() => {});
  }
}

async function scoreTrajectoryKey(
  ctx: ScorerContext,
  params: TrajectoryMatchParams,
): Promise<ScorerResult> {
  let events;
  try {
    events = await ctx.events();
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`could not read the attempt's events: ${message}`, detail);
  }
  return scoreTrajectory(events, params);
}

async function scoreJudgeKey(ctx: ScorerContext, params: LlmJudgeParams): Promise<ScorerResult> {
  let rubric: string | null;
  try {
    rubric = await ctx.rubric(params.rubric);
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`could not read the rubric ${params.rubric}: ${message}`, detail);
  }
  // The loader stores every rubric a valid task names, so only a hand-edited row gets here.
  if (rubric === null) return scorerError(`the task stores no rubric at ${params.rubric}`);
  return scoreLlmJudge(
    {
      task: { key: ctx.task.key, prompt: ctx.task.prompt ?? '', reference: ctx.task.reference },
      attempt: { finalText: ctx.attempt.finalText },
    },
    params,
    { judge: ctx.judge, rubric, priceTable: ctx.priceTable, settings: ctx.judgeSettings },
  );
}

/** Grades one verification entry. Never throws. */
export function scoreEntry(ctx: ScorerContext, entry: VerificationEntry): Promise<ScorerResult> {
  const parsed = parseVerificationEntry(entry);
  if (!parsed.success) {
    // The loader refuses such a task, so only a hand-edited row gets here.
    return Promise.resolve(
      scorerError(
        `the stored params of ${entry.key} are invalid: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const key = parsed.data;
  return guardedAsync(async () => {
    switch (key.type) {
      case 'numeric_tolerance':
      case 'json_match':
      case 'exact_match':
      case 'text_match':
        return scoreAnswer(key, ctx.answer, ctx.task.reference);
      case 'file_check':
        return scoreFileCheck(ctx, key.params);
      case 'verifier_script':
        return scoreVerifier(ctx, key.params);
      case 'trajectory_match':
        return scoreTrajectoryKey(ctx, key.params);
      case 'llm_judge':
        return scoreJudgeKey(ctx, key.params);
    }
  });
}

export interface ScoreOptions {
  /**
   * Called after each key but the last: renews the claim and answers whether
   * this delivery still owns it (claim.ts renewClaim). False stops the pass.
   */
  keepClaim?: () => Promise<boolean>;
  /**
   * The pg-boss job's signal, aborted when pg-boss fails the job under this
   * delivery (its expiry, a lost heartbeat, a cancel). Checked between keys:
   * the retry it schedules takes the claim and grades from the first key, so
   * going on would only spend verifier and judge time on dropped work.
   */
  signal?: AbortSignal;
}

/**
 * Extracts the answer and grades every declared key, in declaration order.
 * Null when `keepClaim` reported the claim lost or `signal` was aborted:
 * nothing more is graded and nothing may be published. Removes every directory it made before
 * returning.
 */
export async function scoreEvidence(
  evidence: EvaluationEvidence,
  deps: ScorerContextDeps,
  options: ScoreOptions = {},
): Promise<ScoredEvaluation | null> {
  const answer = extractAnswer(evidence.attempt.finalText);
  const ctx = openScorerContext(evidence, answer, deps);
  try {
    const scores: ScoreDraft[] = [];
    const entries = evidence.task.verification;
    for (const [index, entry] of entries.entries()) {
      scores.push({
        key: entry.key,
        type: entry.type,
        isPrimary: entry.primary,
        scorerVersion: SCORER_VERSIONS[entry.type],
        result: await scoreEntry(ctx, entry),
      });
      if (index === entries.length - 1) break;
      if (options.signal?.aborted) return null;
      if (options.keepClaim && !(await options.keepClaim())) return null;
    }
    return { answer, scores };
  } finally {
    await ctx.close();
  }
}
