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
import { ARTIFACT_ROOTS, TRAJECTORY_MODES, type ScorerType } from './vocab.js';

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
// Home seeds (Phase 6 P1)
// ---------------------------------------------------------------------------

/** The task folder whose files seed the trial's home. Only HOME_SEED_PATHS may be in it. */
export const TASK_HOME_DIR = 'home';

/**
 * The only files a task's `home/` folder may hold: Hermes's two memory
 * files. Any other path there is a load error. Each is copied, hash
 * re-checked, to the same path under the trial home (homeSeedTarget), in
 * every arm whatever `memory_enabled` says, so the same seed in both arms
 * isolates the setting.
 */
export const HOME_SEED_PATHS = ['home/memories/MEMORY.md', 'home/memories/USER.md'] as const;
export type HomeSeedPath = (typeof HOME_SEED_PATHS)[number];

/** The one home folder collected after a run (P2): artifacts with root home live under it. */
export const HOME_MEMORIES_DIR = 'memories';

/**
 * Hermes's default character budgets of the two memory files
 * (agent/agent_init.py: memory_char_limit 2200, user_char_limit 1375 at
 * v0.22.4). The loader warns, not errors, when a seed is over its budget:
 * Hermes still loads it, but a real agent could not have written it.
 */
export const MEMORY_CHAR_LIMITS = { 'MEMORY.md': 2200, 'USER.md': 1375 } as const;

/**
 * What separates two entries of a memory file: a section sign on a line of
 * its own (ENTRY_DELIMITER in tools/memory_tool_store.py, v0.22.4). Hermes
 * splits on it, trims each entry and drops empty ones; the loader warns
 * when a seed does not read as such a list.
 */
export const MEMORY_ENTRY_DELIMITER = '\n§\n';

/** Whether a task-folder path is one of HOME_SEED_PATHS. */
export const isHomeSeedPath = (path: string): path is HomeSeedPath =>
  (HOME_SEED_PATHS as readonly string[]).includes(path);

/**
 * Where a home seed lands, relative to the trial home: `home/memories/MEMORY.md`
 * becomes `memories/MEMORY.md`. The same relative path is the artifact's
 * path when the agent's copy is collected, so seed and artifact compare by it.
 */
export function homeSeedTarget(path: HomeSeedPath): string {
  return path.slice(TASK_HOME_DIR.length + 1);
}

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
 * Checks one file the agent leaves in the workspace, or in the home's
 * `memories/` (Phase 6 P2). Every declared check must pass. Column and row
 * checks read the file as CSV, so they need `format: csv`; a JSON schema
 * needs `format: json`.
 */
export const FileCheckParamsSchema = z
  .strictObject({
    /**
     * Which collected files the path is in: the workspace (the default), or
     * the home, of which only `memories/` is collected, e.g.
     * `root: home, path: memories/USER.md`.
     */
    root: z.enum(ARTIFACT_ROOTS).default('workspace'),
    /** Relative to the root. */
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
    if (p.root === 'home' && !p.path.startsWith(`${HOME_MEMORIES_DIR}/`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: `with root: home the path must be under ${HOME_MEMORIES_DIR}/, the only home folder collected`,
      });
    }
  });
export type FileCheckParams = z.infer<typeof FileCheckParamsSchema>;

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
 * text_match (plan 9.3, DESIGN_CHECKS_FIX_PROMPT.md Part F): phrases and an
 * optional regular expression looked for in the answer's text. Each phrase
 * and the pattern count once; the score is the share found, and the key
 * passes at or above `pass_at`. A string value is matched as it is, any
 * other value as its JSON text.
 *
 * The pattern is only checked to be non-empty here: whether it compiles,
 * and is safe to run on the agent's text, depends on the regular expression
 * engine, so the api loader checks that and reports a load issue with the
 * compiler's message (scoring/text-match.ts compileTextPattern).
 */
export const TextMatchParamsSchema = z
  .strictObject({
    path: answerPath,
    /** Phrases the text must contain, each counted once. */
    contains: z.array(z.string().min(1, 'a phrase must not be empty')).optional(),
    /** A regular expression found anywhere in the text; counts once. */
    pattern: z.string().min(1, 'the pattern must not be empty').optional(),
    /** Applies to the phrases and the pattern. Off by default (Part F). */
    case_sensitive: z.boolean().default(false),
    /** Minimum share of the phrases and pattern found. */
    pass_at: passAt(1),
  })
  .superRefine((p, ctx) => {
    if ((p.contains?.length ?? 0) === 0 && p.pattern === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['contains'],
        message: 'Add at least one phrase or a pattern.',
      });
    }
    // Case-insensitive phrases that differ only in case are one phrase counted twice.
    const folded = (p.contains ?? []).map((c) => (p.case_sensitive ? c : c.toLowerCase()));
    if (!unique(folded)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contains'],
        message: p.case_sensitive
          ? 'phrases must not repeat'
          : 'phrases must not repeat (case is ignored)',
      });
    }
  });
export type TextMatchParams = z.infer<typeof TextMatchParamsSchema>;

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
  text_match: TextMatchParamsSchema,
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
  /** Only file-producing and memory-writing tasks need this (plan sections 4.3 and 18.2 P2). */
  self_check: z
    .strictObject({
      /** Folder in the task, overlaid on fixtures/ to give the end state a correct agent leaves. */
      expected_workspace: relativePath('expected_workspace').optional(),
      /**
       * Folder in the task, overlaid on the home seeds (`home/`) to give the
       * memory files a correct agent leaves, e.g. `expected_home` holding
       * `memories/USER.md`. Its files are stored as kind `expected_home` and
       * never copied into a trial. Home checks (a file_check with root home,
       * or a verifier reading `--home`) must pass against it.
       */
      expected_home: relativePath('expected_home').optional(),
      /**
       * Also run the checks on the untouched inputs (the fixtures, and the
       * home seeds alone), which must not pass. Absent means true when
       * expected_workspace or expected_home is set.
       */
      negative_control: z.boolean().optional(),
    })
    .superRefine((s, ctx) => {
      const folders = [s.expected_workspace, s.expected_home];
      if (s.negative_control === true && folders.every((f) => f === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['negative_control'],
          message: 'negative_control needs expected_workspace or expected_home',
        });
      }
      if (s.expected_home !== undefined && s.expected_home === s.expected_workspace) {
        ctx.addIssue({
          code: 'custom',
          path: ['expected_home'],
          message: 'expected_home and expected_workspace must be different folders',
        });
      }
      const home = s.expected_home?.replace(/^(\.\/)+/, '');
      if (home === TASK_HOME_DIR || home?.startsWith(`${TASK_HOME_DIR}/`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['expected_home'],
          message: `expected_home must be a folder of its own, not ${TASK_HOME_DIR}/, which holds the seeds`,
        });
      }
    })
    .optional(),
});
export type TaskYaml = z.infer<typeof TaskYamlSchema>;
