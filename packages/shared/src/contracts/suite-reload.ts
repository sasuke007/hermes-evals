/**
 * Reloading suite folders from disk (plan 4.4): the body and result of POST
 * /suites/reload, and the per-directory progress of a Reload all, which
 * sends one load-suites job per directory (Phase 4 question 9). See
 * ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { SUITE_LOAD_OUTCOMES } from '../vocab.js';
import { isoTimeView } from './common.js';
import { SuiteChangeSetSchema, SuiteLoadErrorViewSchema } from './suites.js';

const loadOutcome = z.enum(SUITE_LOAD_OUTCOMES);

/** The result of reloading one suite directory. */
export const SuiteReloadEntrySchema = z.object({
  /** Directory as shown, the same as SuiteListRow.path: `./suites/invoices-v1`. */
  sourcePath: z.string(),
  name: z.string(),
  outcome: loadOutcome,
  suiteId: z.string().nullable(),
  versionNumber: z.number().int().positive().nullable(),
  changes: SuiteChangeSetSchema,
  /** Result line, e.g. "1 task now invalid: late_fees" or "All self-checks passed". */
  message: z.string(),
  error: SuiteLoadErrorViewSchema.nullable(),
});
export type SuiteReloadEntry = z.infer<typeof SuiteReloadEntrySchema>;

/** Result of POST /suites/reload, one entry per suite directory. */
export const SuiteReloadResultSchema = z.object({
  at: isoTimeView,
  suites: z.array(SuiteReloadEntrySchema),
});
export type SuiteReloadResult = z.infer<typeof SuiteReloadResultSchema>;

/** Where one directory of a Reload all stands: its job waits, runs, or ended with an entry or a failure. */
export const SUITE_RELOAD_STATES = ['queued', 'loading', 'done', 'failed'] as const;
export type SuiteReloadState = (typeof SUITE_RELOAD_STATES)[number];

/**
 * One directory of the Reload all in progress. Reload all sends one
 * load-suites job per directory (Phase 4 question 9), so each has its own
 * self-check budget and its own row.
 */
export const SuiteReloadProgressEntrySchema = z
  .object({
    /** As SuiteListRow.path: `./suites/invoices-v1`. */
    sourcePath: z.string(),
    /** suite.yaml's name at the last load; null for a directory never loaded. */
    name: z.string().nullable(),
    state: z.enum(SUITE_RELOAD_STATES),
    /** Its result once `done`. */
    entry: SuiteReloadEntrySchema.nullable(),
    /** Why the job failed (the worker's message, never a stack), once `failed`. */
    error: z.string().nullable(),
  })
  .refine((e) => (e.state === 'done') === (e.entry !== null), {
    path: ['entry'],
    message: 'entry is set exactly when the directory is done',
  })
  .refine((e) => (e.state === 'failed') === (e.error !== null), {
    path: ['error'],
    message: 'error is set exactly when the directory failed',
  });
export type SuiteReloadProgressEntry = z.infer<typeof SuiteReloadProgressEntrySchema>;

/**
 * GET /suites/reload/progress: the last Reload all, per directory, which the
 * suite list polls while POST /suites/reload runs (Phase 5 section 6.1).
 * `active` is false and `directories` empty when no Reload all has run since
 * the API started.
 */
export const SuiteReloadProgressSchema = z.object({
  active: z.boolean(),
  startedAt: isoTimeView.nullable(),
  finishedAt: isoTimeView.nullable(),
  directories: z.array(SuiteReloadProgressEntrySchema),
});
export type SuiteReloadProgress = z.infer<typeof SuiteReloadProgressSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Body of POST /suites/reload. */
export const SuiteReloadRequestSchema = z.strictObject({
  /**
   * One suite directory to reload, as SuiteListRow.path and
   * SuiteReloadEntry.sourcePath show it (`./suites/invoices-v1`; the bare
   * directory name is accepted too); every directory under SUITES_DIR when
   * absent. Matched against the directories on disk, never opened as given.
   */
  path: z.string().min(1).optional(),
});
export type SuiteReloadRequest = z.infer<typeof SuiteReloadRequestSchema>;
