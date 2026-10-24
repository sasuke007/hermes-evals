/**
 * The scorer registry (plan 9.2, 9.3): for each of the seven types, its params
 * schema, its behaviour version and how the suite loader self-checks it
 * (plan 4.3). The runtimes live beside this file; trajectory_match and
 * llm_judge are registered for their schemas only until Phase 3.
 *
 * `version` is stored on every score row (scores.scorer_version, an integer)
 * and feeds the loader's check hash, so bumping it re-checks every suite on
 * the next reload. Bump it whenever a scorer could grade the same input
 * differently.
 */
import {
  SCORER_PARAM_SCHEMAS,
  SCORER_TYPES,
  type ScorerParams,
  type ScorerType,
} from '@hermes-evals/shared';
import type { z } from 'zod';

/**
 * How the loader proves a check can pass before any agent runs (plan 4.3):
 * - `answer`: score reference.json as if it were the agent's answer;
 * - `script`: run the verifier with reference.json against the fixtures;
 * - `workspace`: run against the hidden expected workspace, then against the
 *   untouched fixtures as a negative control;
 * - `none`: params are validated, nothing runs.
 */
export type SelfCheckMode = 'answer' | 'script' | 'workspace' | 'none';

export interface ScorerDefinition<T extends ScorerType = ScorerType> {
  type: T;
  /** Positive integer, bumped on any behaviour change. */
  version: number;
  params: (typeof SCORER_PARAM_SCHEMAS)[T];
  /** The mode for a task without an expected workspace; see selfCheckModeFor. */
  selfCheck: SelfCheckMode;
  /**
   * Grades the extracted answer, so a missing or invalid answer makes the key
   * `ungradable` (plan 9.1). verifier_script is not: it receives the answer,
   * or JSON null, and may judge the workspace alone.
   */
  needsAnswer: boolean;
}

type Registry = { readonly [T in ScorerType]: ScorerDefinition<T> };

export const SCORERS: Registry = {
  numeric_tolerance: {
    type: 'numeric_tolerance',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.numeric_tolerance,
    selfCheck: 'answer',
    needsAnswer: true,
  },
  json_match: {
    type: 'json_match',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.json_match,
    selfCheck: 'answer',
    needsAnswer: true,
  },
  exact_match: {
    type: 'exact_match',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.exact_match,
    selfCheck: 'answer',
    needsAnswer: true,
  },
  file_check: {
    type: 'file_check',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.file_check,
    selfCheck: 'workspace',
    needsAnswer: false,
  },
  trajectory_match: {
    type: 'trajectory_match',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.trajectory_match,
    selfCheck: 'none',
    needsAnswer: false,
  },
  verifier_script: {
    type: 'verifier_script',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.verifier_script,
    selfCheck: 'script',
    needsAnswer: false,
  },
  llm_judge: {
    type: 'llm_judge',
    version: 1,
    params: SCORER_PARAM_SCHEMAS.llm_judge,
    selfCheck: 'none',
    needsAnswer: false,
  },
};

/** Every scorer's version, in SCORER_TYPES order: the scorer part of the loader's check hash. */
export const SCORER_VERSIONS: Readonly<Record<ScorerType, number>> = Object.freeze(
  Object.fromEntries(SCORER_TYPES.map((type) => [type, SCORERS[type].version])) as Record<
    ScorerType,
    number
  >,
);

/** `numeric_tolerance@1`: the version as logs and the UI show it. */
export const scorerVersionLabel = (type: ScorerType): string => `${type}@${SCORERS[type].version}`;

/** Types graded on the extracted answer alone; their self-check scores reference.json. */
export const ANSWER_SCORER_TYPES = ['numeric_tolerance', 'json_match', 'exact_match'] as const;
export type AnswerScorerType = (typeof ANSWER_SCORER_TYPES)[number];

export const isAnswerScorerType = (type: ScorerType): type is AnswerScorerType =>
  (ANSWER_SCORER_TYPES as readonly ScorerType[]).includes(type);

/**
 * The self-check mode of one entry. A verifier is answer-based unless the task
 * declares an expected workspace, in which case it is judged on files. A
 * file_check is always `workspace`; one without an expected workspace cannot
 * be self-checked, which the loader reports as `self_check_unsupported`.
 */
export function selfCheckModeFor(type: ScorerType, hasExpectedWorkspace: boolean): SelfCheckMode {
  if (type === 'verifier_script') return hasExpectedWorkspace ? 'workspace' : 'script';
  return SCORERS[type].selfCheck;
}

/** Validates and defaults one entry's params against its type's strict schema. */
export function parseScorerParams<T extends ScorerType>(
  type: T,
  params: unknown,
): z.ZodSafeParseResult<ScorerParams<T>> {
  // TypeScript cannot correlate T across the map; SCORER_PARAM_SCHEMAS[T] parses to ScorerParams<T>.
  const schema: z.ZodType = SCORERS[type].params;
  return schema.safeParse(params) as z.ZodSafeParseResult<ScorerParams<T>>;
}

/** A verification entry with params parsed by its type's schema; `type` narrows `params`. */
export type ParsedVerificationEntry = {
  [T in ScorerType]: { key: string; type: T; params: ScorerParams<T> };
}[ScorerType];

/** Parses one entry's params, keeping the pairing of type and params visible to TypeScript. */
export function parseVerificationEntry(entry: {
  key: string;
  type: ScorerType;
  params: unknown;
}): { success: true; data: ParsedVerificationEntry } | { success: false; error: z.ZodError } {
  const parsed = parseScorerParams(entry.type, entry.params);
  if (!parsed.success) return { success: false, error: parsed.error };
  const data = { key: entry.key, type: entry.type, params: parsed.data };
  return { success: true, data: data as ParsedVerificationEntry };
}
