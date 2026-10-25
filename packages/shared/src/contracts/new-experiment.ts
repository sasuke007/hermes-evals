/**
 * New experiment: the options the form offers, the estimate, the launch body
 * and the Duplicate draft (plan sections 7.1 and 7.2, UI_FLOWS 11).
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { PROVIDERS } from '../vocab.js';
import {
  countView,
  isoTimeView,
  isUnique,
  secondsView,
  sha256View,
  spendCeilingUsd,
  usdView,
} from './common.js';
import { ConfigVersionRefSchema } from './configurations.js';
import { SuiteVersionRefSchema } from './suites.js';

/** Most repetitions one experiment may ask for. */
export const MAX_REPETITIONS = 20;
/** Most runs one experiment may execute at once (the concurrency CHECK). */
export const MAX_CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const NewExperimentTaskOptionSchema = z.object({
  key: z.string(),
  version: z.number().int().positive(),
  summary: z.string(),
  verificationCount: countView,
  valid: z.boolean(),
  /** Self-check reason shown in the tooltip and inline caption of an invalid task. */
  invalidReason: z.string().nullable(),
});
export type NewExperimentTaskOption = z.infer<typeof NewExperimentTaskOptionSchema>;

export const NewExperimentSuiteOptionSchema = SuiteVersionRefSchema.extend({
  path: z.string(),
  selfCheckAt: isoTimeView,
  taskCount: countView,
  validCount: countView,
  /** Time budget the suite's tasks use, for the override field's help line. */
  budgetS: z.number().int().positive(),
  tasks: z.array(NewExperimentTaskOptionSchema),
});
export type NewExperimentSuiteOption = z.infer<typeof NewExperimentSuiteOptionSchema>;

/**
 * Where a per-run estimate comes from: medians of past attempts on the suite
 * and the configuration's config_hash, or the time budget ÷ 4 and 15,000
 * tokens when there are none (plan 7.2).
 */
export const ESTIMATE_BASES = ['history', 'budget'] as const;
export const EstimateBasisSchema = z.enum(ESTIMATE_BASES);
export type EstimateBasis = z.infer<typeof EstimateBasisSchema>;

/** Per-run estimate for one configuration on a suite. */
export const PerRunEstimateSchema = z.object({
  seconds: secondsView,
  /** Null when the model has no price. */
  costUsd: usdView.nullable(),
  tokens: countView,
  basis: EstimateBasisSchema,
  pastRuns: countView,
});
export type PerRunEstimate = z.infer<typeof PerRunEstimateSchema>;

export const NewExperimentConfigOptionSchema = ConfigVersionRefSchema.extend({
  /** Sent back in expectedConfigHashes, so a configuration edited since is a 409. */
  configHash: sha256View,
  model: z.string(),
  provider: z.enum(PROVIDERS),
  memoryEnabled: z.boolean(),
  /** Display strings: "invoice-method@1.0.0". */
  skills: z.array(z.string()),
  /** Display strings: "invoice-db (stdio)". */
  mcpServers: z.array(z.string()),
  /** Per-run estimate on each suite, keyed by suite version id. */
  estimates: z.record(z.string(), PerRunEstimateSchema),
});
export type NewExperimentConfigOption = z.infer<typeof NewExperimentConfigOptionSchema>;

/** One model of the price table (config/prices.yaml), per million tokens. */
export const PriceEntrySchema = z.object({
  model: z.string(),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  /** The day the price was checked, YYYY-MM-DD. */
  checkedAt: z.string(),
});
export type PriceEntry = z.infer<typeof PriceEntrySchema>;

/** Everything New experiment needs before the user types anything. GET /experiments/new-options. */
export const NewExperimentOptionsSchema = z.object({
  suites: z.array(NewExperimentSuiteOptionSchema),
  configurations: z.array(NewExperimentConfigOptionSchema),
  defaults: z.object({
    repetitions: z.number().int().min(1).max(MAX_REPETITIONS),
    concurrency: z.number().int().min(1).max(MAX_CONCURRENCY),
  }),
  /** Runs executing at once is limited by the live workers' total; 0 with no live worker. */
  maxConcurrency: countView,
  workerCount: countView,
  priceTable: z.array(PriceEntrySchema),
});
export type NewExperimentOptions = z.infer<typeof NewExperimentOptionsSchema>;

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

/** A whole number from the query string, with messages that name the parameter. */
const queryInt = (name: string, min: number, max?: number) => {
  const n = z.coerce
    .number({ error: `${name} is required: a whole number` })
    .int(`${name} is a whole number`)
    .min(min, max === undefined ? `${name} is at least ${min}` : `${name} is ${min} to ${max}`);
  return max === undefined ? n : n.max(max, `${name} is ${min} to ${max}`);
};

/**
 * Query of GET /experiments/estimate, as the web sends it:
 * `?suite=&versions=a,b&tasks=&repetitions=&concurrency=&budget=`. Parses to
 * the EstimateQuery the web's estimateExperiment takes, so both ends share
 * it. `budget` is the form's time budget override (30 to 3600 s): it
 * replaces every configuration's budget, as the launch's frozen estimate and
 * the runs themselves do.
 */
export const EstimateQuerySchema = z
  .object({
    suite: z.string({ error: 'suite is required: a suite version id' }).min(1),
    versions: z
      .string({ error: 'versions is required: configuration version ids, comma-separated' })
      .transform((s) =>
        s
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== ''),
      )
      .pipe(
        z
          .array(z.string())
          .min(1, 'name at least one configuration version')
          .refine(isUnique, 'a version is listed twice'),
      ),
    tasks: queryInt('tasks', 1),
    repetitions: queryInt('repetitions', 1, MAX_REPETITIONS),
    concurrency: queryInt('concurrency', 1, MAX_CONCURRENCY),
    budget: queryInt('budget', 30, 3600).optional(),
  })
  .transform((q) => ({
    suiteId: q.suite,
    versionIds: q.versions,
    taskCount: q.tasks,
    repetitions: q.repetitions,
    concurrency: q.concurrency,
    ...(q.budget === undefined ? {} : { budgetS: q.budget }),
  }));
export type EstimateQuery = z.output<typeof EstimateQuerySchema>;
/** The query string's own names, before parsing. */
export type EstimateQueryParams = z.input<typeof EstimateQuerySchema>;

export const ExperimentEstimateViewSchema = z.object({
  runs: countView,
  /** ceil(runs / concurrency). */
  waves: countView,
  perRunSeconds: secondsView,
  durationS: secondsView,
  /** Null when any chosen configuration's model has no price. */
  costUsd: usdView.nullable(),
  perConfiguration: z.array(
    z.object({
      versionId: z.string(),
      name: z.string(),
      runs: countView,
      costUsd: usdView.nullable(),
    }),
  ),
  basis: EstimateBasisSchema,
  pastRuns: countView,
});
export type ExperimentEstimateView = z.infer<typeof ExperimentEstimateViewSchema>;

// ---------------------------------------------------------------------------
// Launch and Duplicate
// ---------------------------------------------------------------------------

/**
 * The values the New experiment form edits, unchecked: a Duplicate draft can
 * name tasks that no longer exist, so drafts use this and launches use
 * LaunchExperimentInputSchema.
 */
export const LaunchExperimentFieldsSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Suite version id. */
  suiteId: z.string(),
  taskKeys: z.array(z.string()),
  baselineVersionId: z.string(),
  candidateVersionIds: z.array(z.string()),
  repetitions: z.number().int(),
  concurrency: z.number().int(),
  spendCeilingUsd: z.number().nullable(),
  timeBudgetOverrideS: z.number().int().nullable(),
});
export type LaunchExperimentFields = z.infer<typeof LaunchExperimentFieldsSchema>;

const id = (what: string) =>
  z.string({ error: `${what} is required` }).min(1, `${what} is required`);

/**
 * Body of POST /experiments (plan 7.1). The API checks the rest against the
 * database before the launch transaction: valid tasks of that suite version,
 * providers ready, a proven live worker, and the hashes (a mismatch is a 409).
 */
export const LaunchExperimentInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'a name is required')
      .max(120, 'the name is at most 120 characters'),
    description: z.string().max(2000, 'the description is at most 2,000 characters'),
    suiteId: id('suiteId'),
    taskKeys: z
      .array(id('a task key'))
      .min(1, 'select at least one task')
      .refine(isUnique, 'a task is selected twice'),
    baselineVersionId: id('baselineVersionId'),
    candidateVersionIds: z
      .array(id('a candidate version id'))
      .min(1, 'select at least one candidate')
      .refine(isUnique, 'a candidate is selected twice'),
    repetitions: z
      .number()
      .int('repetitions is a whole number')
      .min(1, `repetitions is 1 to ${MAX_REPETITIONS}`)
      .max(MAX_REPETITIONS, `repetitions is 1 to ${MAX_REPETITIONS}`),
    concurrency: z
      .number()
      .int('concurrency is a whole number')
      .min(1, `concurrency is 1 to ${MAX_CONCURRENCY}`)
      .max(MAX_CONCURRENCY, `concurrency is 1 to ${MAX_CONCURRENCY}`),
    spendCeilingUsd: spendCeilingUsd.nullable(),
    timeBudgetOverrideS: z
      .number()
      .int('the time budget is whole seconds')
      .min(30, 'the time budget override is 30 to 3600 seconds')
      .max(3600, 'the time budget override is 30 to 3600 seconds')
      .nullable(),
    /** Version id to config hash, as the form showed them; a mismatch is a 409. */
    expectedConfigHashes: z.record(z.string(), sha256View),
  })
  .superRefine((input, ctx) => {
    if (input.candidateVersionIds.includes(input.baselineVersionId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidateVersionIds'],
        message: 'the baseline cannot also be a candidate',
      });
    }
    const chosen = new Set([input.baselineVersionId, ...input.candidateVersionIds]);
    // A missing or empty id already has its own issue; comparing the hashes would repeat it.
    if (chosen.has('') || input.candidateVersionIds.length === 0) return;
    const given = Object.keys(input.expectedConfigHashes);
    const missing = [...chosen].filter((v) => !Object.hasOwn(input.expectedConfigHashes, v));
    const extra = given.filter((v) => !chosen.has(v));
    if (missing.length > 0 || extra.length > 0) {
      const parts = [
        missing.length > 0 ? `missing ${missing.join(', ')}` : null,
        extra.length > 0 ? `not in this experiment: ${extra.join(', ')}` : null,
      ].filter((p) => p !== null);
      ctx.addIssue({
        code: 'custom',
        path: ['expectedConfigHashes'],
        message: `give the hash of exactly the baseline and the candidates (${parts.join('; ')})`,
      });
    }
  });
export type LaunchExperimentInput = z.infer<typeof LaunchExperimentInputSchema>;

/** Answer of POST /experiments: the new experiment, which the page opens. */
export const LaunchExperimentResultSchema = z.object({ id: z.string() });
export type LaunchExperimentResult = z.infer<typeof LaunchExperimentResultSchema>;

/** Duplicate: a prefilled New experiment form on the suite's current version. */
export const NewExperimentDraftSchema = z.object({
  sourceExperimentId: z.string(),
  values: LaunchExperimentFieldsSchema,
  /** What differs from the original because the suite moved on. */
  changes: z.object({
    suiteVersionFrom: z.number().int().positive(),
    suiteVersionTo: z.number().int().positive(),
    changedTasks: z.array(z.string()),
    removedTasks: z.array(z.string()),
    invalidTasks: z.array(z.object({ key: z.string(), reason: z.string() })),
  }),
});
export type NewExperimentDraft = z.infer<typeof NewExperimentDraftSchema>;
