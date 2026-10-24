/**
 * Schemas of the suite files authors write on disk (plan sections 4.1 to 4.3
 * and 9.3): suite.yaml, each task.yaml, and the params of every scorer type.
 * The suite loader parses with these, and the scorer registry
 * (apps/api/src/scoring/registry.ts) parses params with SCORER_PARAM_SCHEMAS;
 * the task harness in apps/api/src/sandbox/task-run.ts keeps only a looser
 * task.yaml schema of its own.
 *
 * Every object here is strict: a misspelt key (`parms`, `pass-at`) is an
 * error rather than a silently ignored setting, because an ignored scorer
 * option changes what a run is graded on.
 */
import { z } from 'zod';
import { JsonValueSchema, TaskLimitsSchema, VerificationEntrySchema } from './records.js';
import type { ScorerType } from './vocab.js';

/**
 * A suite or task directory name, and the shape of suite.yaml's `name`. The
 * name need not equal its directory's, but two live directories cannot
 * declare the same name: the loader refuses the second with an error.
 */
export const DIRECTORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Absolute (`/x`) or escaping (`..` as a segment): the task_files path CHECK's rule. */
const UNSAFE_PATH = /(^\/|(^|\/)\.\.(\/|$))/;

/** A path inside a folder the author controls, never outside it. */
const relativePath = (what: string) =>
  z
    .string()
    .min(1)
    .refine((p) => !UNSAFE_PATH.test(p) && !p.includes('\\') && !p.includes('\0'), {
      message: `${what} must be a relative path without '..'`,
    });

/** A threshold on a 0 to 1 score. */
const passAt = (fallback: number) => z.number().min(0).max(1).default(fallback);

/** A path into the answer object, e.g. `duplicates` or `totals.vat`. Absent: the whole answer. */
const answerPath = z.string().min(1).optional();

const unique = (values: readonly string[]) => new Set(values).size === values.length;

// ---------------------------------------------------------------------------
// suite.yaml
// ---------------------------------------------------------------------------

export const SuiteYamlSchema = z.strictObject({
  name: z.string().regex(DIRECTORY_KEY_PATTERN),
  /**
   * The author's label, shown muted beside the loader's own version number.
   * YAML reads `0.10` as the number 0.1, so the label is kept as the string of
   * whatever YAML parsed; quote it to keep it verbatim.
   */
  version_label: z.union([z.string().min(1), z.number()]).transform(String),
  description: z.string().optional(),
  /** Display order of the task keys (the task folder names). */
  tasks: z
    .array(z.string().regex(DIRECTORY_KEY_PATTERN))
    .refine(unique, { message: 'task keys must be unique' })
    .optional(),
});
export type SuiteYaml = z.infer<typeof SuiteYamlSchema>;

// ---------------------------------------------------------------------------
// Scorer params (plan section 9.3)
// ---------------------------------------------------------------------------

export const NumericToleranceParamsSchema = z.strictObject({
  path: answerPath,
  /** Passes when |observed − expected| ≤ abs. */
  abs: z.number().nonnegative().optional(),
  /**
   * Passes when |observed − expected| ≤ rel × |expected|. With neither abs
   * nor rel, the values must be equal.
   */
  rel: z.number().nonnegative().optional(),
});
export type NumericToleranceParams = z.infer<typeof NumericToleranceParamsSchema>;

export const JsonMatchParamsSchema = z.strictObject({
  path: answerPath,
  /** Compare lists as multisets. */
  unordered: z.boolean().optional(),
  /** Also compare lists nested inside lists as multisets. */
  inner_unordered: z.boolean().optional(),
  /** Keys of the compared objects (or of each list item) left out of the comparison. */
  exclude_keys: z.array(z.string().min(1)).optional(),
  /** Minimum share of matching keys (openevals json match score). */
  pass_at: passAt(1),
});
export type JsonMatchParams = z.infer<typeof JsonMatchParamsSchema>;

export const ExactMatchParamsSchema = z.strictObject({
  path: answerPath,
  trim: z.boolean().default(true),
  case_sensitive: z.boolean().default(true),
});
export type ExactMatchParams = z.infer<typeof ExactMatchParamsSchema>;

export const FILE_CHECK_FORMATS = ['csv', 'json', 'text'] as const;
export type FileCheckFormat = (typeof FILE_CHECK_FORMATS)[number];

/**
 * Checks one file the agent leaves in the workspace. Every declared check
 * must pass. Column and row checks read the file as CSV, so they need
 * `format: csv`; a JSON schema needs `format: json`.
 */
export const FileCheckParamsSchema = z
  .strictObject({
    /** Relative to the workspace root. */
    path: relativePath('path'),
    /** false: an absent file passes, and the other checks apply only when it exists. */
    must_exist: z.boolean().default(true),
    format: z.enum(FILE_CHECK_FORMATS).optional(),
    /** CSV header columns that must all be present, in any order. */
    columns: z.array(z.string().min(1)).optional(),
    /** CSV data rows, not counting the header. */
    row_count: z.number().int().nonnegative().optional(),
    /** A JSON Schema the parsed file must satisfy. */
    json_schema: z.record(z.string(), JsonValueSchema).optional(),
    /** Substrings the file's text must contain. */
    contains: z.array(z.string().min(1)).optional(),
  })
  .superRefine((p, ctx) => {
    for (const key of ['columns', 'row_count'] as const) {
      if (p[key] !== undefined && p.format !== 'csv') {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} needs format: csv` });
      }
    }
    if (p.json_schema !== undefined && p.format !== 'json') {
      ctx.addIssue({
        code: 'custom',
        path: ['json_schema'],
        message: 'json_schema needs format: json',
      });
    }
  });
export type FileCheckParams = z.infer<typeof FileCheckParamsSchema>;

export const TRAJECTORY_MODES = ['strict', 'unordered', 'subset', 'superset'] as const;
export type TrajectoryMode = (typeof TRAJECTORY_MODES)[number];

export const TrajectoryMatchParamsSchema = z
  .strictObject({
    /** Tool name as the run's tool_use events report it. */
    tool: z.string().min(1),
    /** A call counts only when its arguments contain these (subset match). */
    args: z.record(z.string(), JsonValueSchema).optional(),
    min_calls: z.number().int().nonnegative().default(1),
    max_calls: z.number().int().nonnegative().optional(),
    /** Compare the full trajectory with openevals in this mode instead of counting calls. */
    mode: z.enum(TRAJECTORY_MODES).optional(),
  })
  .refine((p) => p.max_calls === undefined || p.max_calls >= p.min_calls, {
    path: ['max_calls'],
    message: 'max_calls must be at least min_calls',
  });
export type TrajectoryMatchParams = z.infer<typeof TrajectoryMatchParamsSchema>;

export const VerifierScriptParamsSchema = z.strictObject({
  /** File under the task's `verify/` folder, e.g. `check.py`. */
  script: relativePath('script'),
  timeout_s: z.number().int().min(1).max(300).default(30),
  /** The script prints `{"score": …}`; the key passes at or above this. */
  pass_at: passAt(1),
});
export type VerifierScriptParams = z.infer<typeof VerifierScriptParamsSchema>;

export const LlmJudgeParamsSchema = z.strictObject({
  /** File in the task folder, e.g. `rubric.md`. */
  rubric: relativePath('rubric'),
  pass_at: passAt(0.7),
  /** Judge model; the platform's judge default when absent. */
  model: z.string().min(1).optional(),
});
export type LlmJudgeParams = z.infer<typeof LlmJudgeParamsSchema>;

/**
 * The params schema of every scorer type. The registry and the loader look a
 * type up here; a type missing from this map is a compile error.
 */
export const SCORER_PARAM_SCHEMAS = {
  numeric_tolerance: NumericToleranceParamsSchema,
  json_match: JsonMatchParamsSchema,
  exact_match: ExactMatchParamsSchema,
  file_check: FileCheckParamsSchema,
  trajectory_match: TrajectoryMatchParamsSchema,
  verifier_script: VerifierScriptParamsSchema,
  llm_judge: LlmJudgeParamsSchema,
} as const satisfies Record<ScorerType, z.ZodType>;

/** Parsed (defaulted) params of one scorer type, e.g. `ScorerParams<'json_match'>`. */
export type ScorerParams<T extends ScorerType> = z.infer<(typeof SCORER_PARAM_SCHEMAS)[T]>;

// ---------------------------------------------------------------------------
// task.yaml (plan section 4.2)
// ---------------------------------------------------------------------------

/**
 * One `verification` entry as written. Params are checked here only as a
 * mapping: the loader validates them against SCORER_PARAM_SCHEMAS[type] so
 * it can report `params_invalid` on the entry's key.
 */
export const VerificationYamlSchema = VerificationEntrySchema.extend({
  primary: z.boolean().default(false),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type VerificationYaml = z.infer<typeof VerificationYamlSchema>;

export const TaskYamlSchema = z.strictObject({
  summary: z.string().min(1),
  limits: TaskLimitsSchema.strict(),
  answer: z.strictObject({
    /** The only format in v1: the last fenced ```json block of the final response. */
    format: z.literal('fenced_json'),
    /** Sub-path of the answer the primary key scores when its params name no `path`. */
    path: answerPath,
  }),
  verification: z.array(VerificationYamlSchema).min(1),
  /** Only file-producing tasks need this (plan section 4.3). */
  self_check: z
    .strictObject({
      /** Folder in the task, overlaid on fixtures/ to give the end state a correct agent leaves. */
      expected_workspace: relativePath('expected_workspace').optional(),
      /**
       * Also run the checks on the untouched fixtures, which must not pass.
       * Absent means true when expected_workspace is set.
       */
      negative_control: z.boolean().optional(),
    })
    .refine((s) => s.negative_control !== true || s.expected_workspace !== undefined, {
      path: ['negative_control'],
      message: 'negative_control needs expected_workspace',
    })
    .optional(),
});
export type TaskYaml = z.infer<typeof TaskYamlSchema>;
