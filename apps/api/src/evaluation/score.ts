/**
 * The scoring step of an evaluation (plan 9.2-9.4): every verification key
 * of the task, graded over stored evidence. Pure with respect to the
 * database: it reads, and writes nothing, so it can run outside any
 * transaction and be thrown away when this delivery loses its claim.
 *
 * Per type:
 * - numeric_tolerance, json_match, exact_match: the extracted answer against
 *   the reference (scoring/answer.ts). A missing or invalid answer block makes
 *   each of them `ungradable`, never a zero (plan 9.1);
 * - file_check: the end-state workspace rebuilt from artifact blobs;
 * - verifier_script: the task's script with the answer (or JSON null) and its
 *   own fresh copy of that workspace, under the Phase 1 runner's minimal
 *   environment;
 * - trajectory_match, llm_judge: `error` until Phase 3 builds them, so the
 *   run still reaches scored and nothing counts as a fail.
 *
 * Every key yields exactly one result: a scorer that throws, invalid stored
 * params, or a workspace that cannot be rebuilt all give `error` with the
 * reason (plan 9.2), never a zero and never a missing key, because the
 * database publishes only a complete key set.
 */
import { z } from 'zod';
import type {
  ExtractedAnswer,
  FileCheckParams,
  ScorerType,
  VerificationEntry,
} from '@hermes-evals/shared';
import { scoreAnswer } from '../scoring/answer.js';
import { extractAnswer } from '../scoring/extraction.js';
import { checkFile, MAX_CHECKED_FILE_BYTES } from '../scoring/file-check.js';
import { parseVerificationEntry, SCORER_VERSIONS } from '../scoring/registry.js';
import {
  binary,
  describeThrown,
  guardedAsync,
  scorerError,
  type ScorerResult,
} from '../scoring/result.js';
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

/**
 * The result of trajectory_match and llm_judge until Phase 3 builds them: an
 * error, so the run still reaches scored and the key never counts as a fail.
 */
export const notScoredYet = (type: ScorerType): ScorerResult =>
  scorerError(`${type} is scored from Phase 3`);

/** The artifact stored at a workspace path, matched the way collection stores paths. */
function artifactAt(ctx: ScorerContext, path: string) {
  const wanted = normaliseRelativePath(path);
  return wanted === null ? undefined : ctx.artifacts.find((a) => a.path === wanted);
}

async function scoreFileCheck(ctx: ScorerContext, params: FileCheckParams): Promise<ScorerResult> {
  const artifact = artifactAt(ctx, params.path);
  const evidence = artifact ? { artifact_ids: [artifact.id] } : {};
  if (artifact && artifact.sha256 === null) {
    // Collection recorded the file without content; the rebuilt workspace lacks
    // it, which must not read as "does not exist". checkFile fails an
    // oversized file the same way when it finds one on disk.
    const why =
      artifact.skippedReason === 'over_budget'
        ? "the attempt's workspace passed the collection budget"
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
  let workspaceDir: string;
  try {
    workspaceDir = await ctx.workspace();
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`could not rebuild the workspace from stored files: ${message}`, detail);
  }
  const result = await checkFile(params, workspaceDir);
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
      `could not rebuild the workspace and verify/ folder from stored files: ${message}`,
      detail,
    );
  }
  try {
    return await scoreVerifierScript(params, {
      verifyDir: dirs.verifyDir,
      // A verifier may judge the workspace alone, so it runs without an answer too.
      answer: ctx.answer.status === 'found' ? ctx.answer.value : null,
      workspaceDir: dirs.workspaceDir,
      scratchDir: dirs.scratchDir,
      python: ctx.python,
    });
  } finally {
    await dirs.dispose().catch(() => {});
  }
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
        return scoreAnswer(key, ctx.answer, ctx.task.reference);
      case 'file_check':
        return scoreFileCheck(ctx, key.params);
      case 'verifier_script':
        return scoreVerifier(ctx, key.params);
      case 'trajectory_match':
      case 'llm_judge':
        return notScoredYet(key.type);
    }
  });
}

/**
 * Extracts the answer and grades every declared key, in declaration order.
 * Removes every directory it made before returning.
 */
export async function scoreEvidence(
  evidence: EvaluationEvidence,
  deps: ScorerContextDeps,
): Promise<ScoredEvaluation> {
  const answer = extractAnswer(evidence.attempt.finalText);
  const ctx = openScorerContext(evidence, answer, deps);
  try {
    const scores: ScoreDraft[] = [];
    for (const entry of evidence.task.verification) {
      scores.push({
        key: entry.key,
        type: entry.type,
        isPrimary: entry.primary,
        scorerVersion: SCORER_VERSIONS[entry.type],
        result: await scoreEntry(ctx, entry),
      });
    }
    return { answer, scores };
  } finally {
    await ctx.close();
  }
}
