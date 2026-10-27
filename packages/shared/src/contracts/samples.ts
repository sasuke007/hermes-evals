/**
 * The samples a fresh clone starts with (Phase 8 G3, G4): what the API's
 * start-up seed created and skipped, the names it gives the recommended
 * configurations, and the sample experiment the Experiments page offers.
 *
 * The seed runs once per API start (SEED_SAMPLES, on by default), through
 * the same services the pages use, and never fails the start: a problem is
 * logged and reported here, and System shows it.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { isoTimeView } from './common.js';

// ---------------------------------------------------------------------------
// The seed's report
// ---------------------------------------------------------------------------

/** What the seed makes, in the order it makes them. */
export const SEED_ITEM_KINDS = ['skill', 'document', 'mcp_server', 'configuration'] as const;
export type SeedItemKind = (typeof SEED_ITEM_KINDS)[number];

/**
 * - `created`: a new resource, or a new version of one whose sample changed.
 * - `skipped`: one with that name (and, for skills and documents, that content) exists.
 * - `failed`: the service refused it, or reading the sample failed; the rest still ran.
 */
export const SEED_OUTCOMES = ['created', 'skipped', 'failed'] as const;
export type SeedOutcome = (typeof SEED_OUTCOMES)[number];

/**
 * - `off`: SEED_SAMPLES is false, so nothing was seeded.
 * - `running`: this API start is seeding now.
 * - `done`: it went through every sample; some items may have failed.
 * - `failed`: it stopped before the end (the samples folder is missing, the
 *   database refused); `error` says why, and the API runs on regardless.
 */
export const SEED_STATES = ['off', 'running', 'done', 'failed'] as const;
export type SeedState = (typeof SEED_STATES)[number];

export const SeedItemSchema = z
  .object({
    kind: z.enum(SEED_ITEM_KINDS),
    /**
     * A skill's name, `<suite>/<file>` for a document, an MCP server's
     * name, or a configuration's name.
     */
    name: z.string().min(1),
    outcome: z.enum(SEED_OUTCOMES),
    /**
     * Why it was skipped or failed, as the log says it: "exists with the
     * same content", or the service's message. For `created`, an optional
     * note such as "version 1.1.0"; null without one.
     */
    detail: z.string().min(1).nullable(),
  })
  .superRefine((item, ctx) => {
    if (item.outcome !== 'created' && item.detail === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['detail'],
        message: `a ${item.outcome} item says why`,
      });
    }
  });
export type SeedItem = z.infer<typeof SeedItemSchema>;

/** The seed of this API start, as System shows it. Held in the API's memory: a restart seeds again. */
export const SeedReportSchema = z
  .object({
    state: z.enum(SEED_STATES),
    /** Null when `off`. */
    startedAt: isoTimeView.nullable(),
    /** Null when `off` or `running`. */
    finishedAt: isoTimeView.nullable(),
    /** Every sample met so far, in SEED_ITEM_KINDS order. Empty when `off`. */
    items: z.array(SeedItemSchema),
    /** What stopped the seed: set exactly when `failed`. */
    error: z.string().min(1).nullable(),
  })
  .superRefine((report, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const off = report.state === 'off';
    const finished = report.state === 'done' || report.state === 'failed';
    if (off !== (report.startedAt === null)) {
      issue(
        'startedAt',
        off ? 'a seed that is off has not started' : 'a seed that ran has a start',
      );
    }
    if (finished !== (report.finishedAt !== null)) {
      issue(
        'finishedAt',
        finished ? 'a finished seed has an end' : 'only a finished seed has an end',
      );
    }
    if (off && report.items.length > 0) issue('items', 'a seed that is off made nothing');
    if ((report.state === 'failed') !== (report.error !== null)) {
      issue(
        'error',
        report.state === 'failed' ? 'a failed seed says why' : 'only a failed seed has an error',
      );
    }
  });
export type SeedReport = z.infer<typeof SeedReportSchema>;

/** How many of the report's items had each outcome, for System's summary line. */
export function seedCounts(report: Pick<SeedReport, 'items'>): Record<SeedOutcome, number> {
  const counts: Record<SeedOutcome, number> = { created: 0, skipped: 0, failed: 0 };
  for (const item of report.items) counts[item.outcome] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The recommended configurations and the sample experiment
// ---------------------------------------------------------------------------

/**
 * The two families of every suite's recommended configurations
 * (samples/configurations.yaml): `real` runs provider nous, model
 * openai/gpt-6.1-sol; `mock` runs the scripted mock model, for free.
 */
export const SAMPLE_CONFIGURATION_FAMILIES = ['real', 'mock'] as const;
export type SampleConfigurationFamily = (typeof SAMPLE_CONFIGURATION_FAMILIES)[number];

/** `<suite>-<arm>` for the real family, `<suite>-<arm>-mock` for the mock: "invoices-v1-baseline-mock". */
export const sampleConfigurationName = (
  suite: string,
  arm: string,
  family: SampleConfigurationFamily,
): string => (family === 'mock' ? `${suite}-${arm}-mock` : `${suite}-${arm}`);

/**
 * "Run a sample experiment" (G4): invoices-v1, its baseline against its
 * with-skill arm on the mock model, every valid task, 2 repetitions,
 * through the normal launch. Unavailable, with the reason, while the suite
 * or either configuration is missing.
 */
export const SAMPLE_EXPERIMENT = {
  suite: 'invoices-v1',
  baseline: sampleConfigurationName('invoices-v1', 'baseline', 'mock'),
  candidate: sampleConfigurationName('invoices-v1', 'with-skill', 'mock'),
  repetitions: 2,
  name: 'Sample: invoices-v1, baseline against with-skill (mock model)',
} as const;
