/**
 * How much of an attempt's output the run inspector shows (plan 8.3,
 * UI_FLOWS 18): the window the timeline keeps of each tool's output, and
 * the whole stderr.log behind the error banner's "Full log". See
 * ./common.ts for the conventions every contract file follows.
 *
 * Route, under /api:
 *   GET /runs/:id/attempts/:n/stderr   AttemptStderr; 404 when the run, the
 *        attempt or its stderr.log is not there (a queued attempt, or a log
 *        removed after TRIAL_RETENTION_DAYS)
 */
import { z } from 'zod';
import { countView } from './common.js';

// ---------------------------------------------------------------------------
// The timeline's output windows (Phase 6 question 13)
// ---------------------------------------------------------------------------

/**
 * How many characters of a tool's output the timeline keeps: an MCP tool's
 * result 20,000, since a page of an MCP server's data (an invoice-db page is
 * about 7,000 characters) must show its `next_cursor`; any other tool's
 * 5,000. A longer output is cut there and its row marked `truncated`, with
 * `outputChars` the whole length. The model itself is given more (Hermes's
 * own limits, docs/limits.md).
 */
export const TIMELINE_OUTPUT_LIMITS = { tool: 5_000, mcp: 20_000 } as const;

/** The window of one tool row: TIMELINE_OUTPUT_LIMITS.mcp when an MCP server's tool made it. */
export function timelineOutputLimit(row: { server: string | null }): number {
  return row.server !== null ? TIMELINE_OUTPUT_LIMITS.mcp : TIMELINE_OUTPUT_LIMITS.tool;
}

// ---------------------------------------------------------------------------
// The whole stderr.log (Phase 5 section 6.1)
// ---------------------------------------------------------------------------

/**
 * The most of a stderr.log GET …/stderr answers with. A longer log is
 * answered with its end, cut at a line start, since the end is where a run
 * stopped; `truncated` says so.
 */
export const ATTEMPT_STDERR_MAX_BYTES = 1024 * 1024;

/** Route params of GET /runs/:id/attempts/:n/stderr: the attempt number, from 1. */
export const AttemptStderrParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce
    .number({ error: 'n is an attempt number' })
    .int('n is a whole number')
    .positive('n is 1 or more'),
});
export type AttemptStderrParams = z.infer<typeof AttemptStderrParamsSchema>;

/**
 * GET /runs/:id/attempts/:n/stderr: the attempt's stderr.log as text, for
 * the inspector's "Full log". Secret values are redacted as in the stored
 * stderr tail; bytes that are not valid UTF-8 read as U+FFFD.
 */
export const AttemptStderrSchema = z
  .object({
    runId: z.string(),
    attempt: z.number().int().positive(),
    /** The log, or its last ATTEMPT_STDERR_MAX_BYTES when `truncated`; '' for an empty log. */
    text: z.string(),
    /** The whole log's size on disk. */
    sizeBytes: countView,
    /** Lines in the whole log, a last line without its newline included (the banner's "N lines"). */
    totalLines: countView,
    /** True when `text` is only the log's end. */
    truncated: z.boolean(),
  })
  .refine((s) => s.truncated === s.sizeBytes > ATTEMPT_STDERR_MAX_BYTES, {
    path: ['truncated'],
    message: 'truncated exactly when the log is over ATTEMPT_STDERR_MAX_BYTES',
  });
export type AttemptStderr = z.infer<typeof AttemptStderrSchema>;
