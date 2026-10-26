/**
 * How the task editor checks a draft task (plan 4.6; SA.7, SA.8): the 13
 * readiness rules the API runs on every change without user code, the
 * worker's self-check of the checks that need code or files, and Try it, an
 * answer check on a pasted reply. The task itself is in ./draft-tasks.ts.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { AUTHORING_LIMITS } from '../authoring.js';
import { JsonValueSchema, ScoreEvidenceSchema } from '../records.js';
import { SCORE_STATUSES } from '../status.js';
import { SCORER_TYPES } from '../vocab.js';
import { countView, isoTimeView, sha256View } from './common.js';

// ---------------------------------------------------------------------------
// Readiness (SA.8)
// ---------------------------------------------------------------------------

/** The editor's sections, in page order, plus the task.yaml tab: where a Fix link goes. */
export const TASK_EDITOR_SECTIONS = [
  'task',
  'prompt',
  'workspace',
  'home',
  'answer',
  'reference',
  'checks',
  'expected',
  'limits',
  'yaml',
] as const;
export type TaskEditorSection = (typeof TASK_EDITOR_SECTIONS)[number];

/** The 13 readiness rules of SA.8, in the panel's order. They run in the API on every change, without user code. */
export const READINESS_RULES = [
  'key_summary',
  'task_yaml',
  'checks',
  'check_settings',
  'reference_json',
  'reference_paths',
  'expected_folders',
  'answer_block',
  'mentioned_files',
  'reference_leak',
  'file_limits',
  'self_check',
  'negative_control',
] as const;
export type ReadinessRule = (typeof READINESS_RULES)[number];

/** Each rule's row label in ReadinessPanel, with `code` in backticks as the panel renders it. */
export const READINESS_RULE_LABELS = {
  key_summary: 'Key and summary are set',
  task_yaml: '`task.yaml` is valid',
  checks: 'At least one check, exactly one primary',
  check_settings: "Every check's settings are valid",
  reference_json: 'The reference is valid JSON',
  reference_paths: 'The reference has a value at every path a check reads',
  expected_folders: 'File checks have an expected workspace',
  answer_block: 'The prompt asks for a fenced json block',
  mentioned_files: 'Every file the prompt mentions is in the workspace',
  reference_leak: 'No workspace file contains a reference value',
  file_limits: 'Files are within limits',
  self_check: 'Self-check',
  negative_control: "Doing nothing doesn't pass",
} as const satisfies Record<ReadinessRule, string>;

/** A rule's row: passed (green), warning (amber), problem (violet, dotted) or pending (grey ring, waits on a self-check). */
export const READINESS_STATUSES = ['passed', 'warning', 'problem', 'pending'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/**
 * A task's readiness in one word, for the draft's task table and the import
 * preview: any problem, else any warning, else a row pending ("self-check not
 * run"), else ready.
 */
export const TASK_READINESS = ['ready', 'warnings', 'problems', 'not_run'] as const;
export type TaskReadinessSummary = (typeof TASK_READINESS)[number];

/** Where a Fix link scrolls: a section and, when there is one, the field in it. */
export const ReadinessTargetSchema = z.object({
  section: z.enum(TASK_EDITOR_SECTIONS),
  /**
   * A TaskForm path (`maxTurns`, `checks.1.key`, `checks.0.params.abs`),
   * `key`, `prompt`, `reference`, or a file's path in the task folder
   * (`fixtures/notes.txt`); null for the section as a whole.
   */
  field: z.string().nullable(),
});
export type ReadinessTarget = z.infer<typeof ReadinessTargetSchema>;

export const ReadinessRuleResultSchema = z.object({
  rule: z.enum(READINESS_RULES),
  status: z.enum(READINESS_STATUSES),
  /** The row's line, `code` in backticks, e.g. "No value at `overdue` (check `answer`)."; "" when there is nothing to add. */
  message: z.string(),
  /** Where its Fix goes; null when the row has no Fix (passed, pending). */
  target: ReadinessTargetSchema.nullable(),
});
export type ReadinessRuleResult = z.infer<typeof ReadinessRuleResultSchema>;

/** One message shown at a field (and as a dot on its section in the index), e.g. "Max turns is 1 to 200.". */
export const ReadinessIssueSchema = z.object({
  rule: z.enum(READINESS_RULES),
  severity: z.enum(['problem', 'warning']),
  target: ReadinessTargetSchema,
  message: z.string(),
});
export type ReadinessIssue = z.infer<typeof ReadinessIssueSchema>;

/** A file the prompt names, and where the task has it ("Files mentioned"). */
export const MentionedFileSchema = z.object({
  name: z.string(),
  /** In the workspace files, the expected workspace (written by the agent), the home seeds, or nowhere. */
  location: z.enum(['workspace', 'expected', 'home', 'missing']),
});
export type MentionedFile = z.infer<typeof MentionedFileSchema>;

/** What an answer check reads in the reference ("Values the checks read"). */
export const ReferenceValueSchema = z.object({
  key: z.string(),
  /** The path it reads: its own `path`, else the answer path it inherits; null for the whole reference. */
  path: z.string().nullable(),
  found: z.boolean(),
  /** The value as compact JSON, cut to about 80 characters; null when not found. */
  preview: z.string().nullable(),
});
export type ReferenceValue = z.infer<typeof ReferenceValueSchema>;

/** Counts of a rule list and the one word for it (TASK_READINESS). */
export function summariseReadiness(rules: ReadonlyArray<{ status: ReadinessStatus }>): {
  summary: TaskReadinessSummary;
  counts: { problems: number; warnings: number; pending: number };
} {
  const counts = { problems: 0, warnings: 0, pending: 0 };
  for (const { status } of rules) {
    if (status === 'problem') counts.problems++;
    else if (status === 'warning') counts.warnings++;
    else if (status === 'pending') counts.pending++;
  }
  const summary: TaskReadinessSummary =
    counts.problems > 0
      ? 'problems'
      : counts.warnings > 0
        ? 'warnings'
        : counts.pending > 0
          ? 'not_run'
          : 'ready';
  return { summary, counts };
}

/**
 * The readiness of one draft task (GET …/tasks/:key/readiness, and inside
 * DraftTaskDetail): every rule in READINESS_RULES order, the field messages,
 * and what the Prompt and Reference sections list.
 */
export const TaskReadinessSchema = z
  .object({
    summary: z.enum(TASK_READINESS),
    counts: z.object({ problems: countView, warnings: countView, pending: countView }),
    rules: z.array(ReadinessRuleResultSchema),
    issues: z.array(ReadinessIssueSchema),
    mentionedFiles: z.array(MentionedFileSchema),
    referenceValues: z.array(ReferenceValueSchema),
    /** The task has checks only the worker can self-check (file checks, verifier scripts): Run self-check. */
    needsWorker: z.boolean(),
    checkedAt: isoTimeView,
  })
  .superRefine((r, ctx) => {
    if (r.rules.map((x) => x.rule).join() !== READINESS_RULES.join()) {
      ctx.addIssue({ code: 'custom', path: ['rules'], message: 'one row per rule, in order' });
    }
    const expected = summariseReadiness(r.rules);
    if (
      expected.summary !== r.summary ||
      JSON.stringify(expected.counts) !== JSON.stringify(r.counts)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'summary and counts follow the rules',
      });
    }
  });
export type TaskReadiness = z.infer<typeof TaskReadinessSchema>;

// ---------------------------------------------------------------------------
// Self-check in the worker, and Try it in the API
// ---------------------------------------------------------------------------

export const DraftSelfCheckResultSchema = z.object({
  key: z.string(),
  type: z.enum(SCORER_TYPES),
  mode: z.enum(['answer', 'script', 'workspace', 'home', 'none']),
  /** `fail` marks a negative control: the check on the untouched inputs, which must not pass. */
  expect: z.enum(['pass', 'fail']),
  status: z.enum([...SCORE_STATUSES, 'skipped']),
  score: z.number().min(0).max(1).nullable(),
  comment: z.string(),
  /**
   * Command and output as captured, for a check that ran a verifier: "$ python3
   * verify/check_summary.py --answer …", the stderr tail, then "exit status 1 ·
   * no result line · 0.2 s". Null for checks that run no command.
   */
  transcript: z.string().nullable(),
});
export type DraftSelfCheckResult = z.infer<typeof DraftSelfCheckResultSchema>;

/** The last worker self-check of a draft task (POST …/self-check, plan 4.6). */
export const DraftSelfCheckViewSchema = z.object({
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  ranAt: isoTimeView,
  durationMs: countView,
  /** The task's content hash it ran on (the loader's task hash of the draft folder). */
  contentHash: sha256View,
  /** False once the task changed after the run: shown, marked out of date. */
  current: z.boolean(),
  results: z.array(DraftSelfCheckResultSchema),
});
export type DraftSelfCheckView = z.infer<typeof DraftSelfCheckViewSchema>;

/** Body of POST …/tasks/:key/try: an answer check on the reference, or on a pasted reply. Nothing is stored. */
export const TryCheckRequestSchema = z.strictObject({
  /** The check's key in the draft task, as last saved. */
  key: z.string().min(1),
  /** A reply to take the answer block from; null tries the reference as if it were the answer. */
  reply: z.string().max(AUTHORING_LIMITS.draftTextMaxChars).nullable(),
});
export type TryCheckRequest = z.infer<typeof TryCheckRequestSchema>;

/** Result of Try it: extraction plus the check's scorer, run in the API on a reply (SA.7). */
export const TryCheckResultSchema = z.object({
  key: z.string(),
  type: z.enum(SCORER_TYPES),
  against: z.enum(['reference', 'reply']),
  /** The last fenced json block of the reply: its text, or why there is none. Null against the reference. */
  extraction: z
    .object({
      status: z.enum(['found', 'missing', 'invalid']),
      block: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  /** The path the check read; null for the whole answer. */
  path: z.string().nullable(),
  /** The value at that path as compact JSON; null when the answer has none or nothing was extracted. */
  value: z.string().nullable(),
  status: z.enum(SCORE_STATUSES),
  score: z.number().min(0).max(1).nullable(),
  /** The scorer's line, e.g. "|17 − 17| = 0 ≤ 0" or "4 of 5 keys match". */
  comment: z.string(),
  /** The pass threshold when it can be fractional (json_match, text_match), for "(needs 0.80)"; else null. */
  passAt: z.number().min(0).max(1).nullable(),
  /** The compared values, for the key-by-key list; absent when the scorer has none. */
  expected: JsonValueSchema.optional(),
  observed: JsonValueSchema.optional(),
  evidence: ScoreEvidenceSchema.nullable(),
});
export type TryCheckResult = z.infer<typeof TryCheckResultSchema>;
