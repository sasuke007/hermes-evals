/**
 * GET /runs/:id/attempts/:n/stderr, the inspector's "Full log" (Phase 5
 * section 6.1, Phase 7): an attempt's stderr.log as text.
 *
 * The API reads no trial directory: when an attempt ends, the worker stores
 * the log's end, redacted as the stderr tail is (every secret value the
 * trial held replaced by `<from env NAME>`), in the blob store, and names it
 * on the attempt's `collected` platform event as `stderr_log: { sha256,
 * bytes }` beside `stderr_lines` (execution/attempt/stderr-capture.ts). That
 * end is the whole log, or its last ATTEMPT_STDERR_MAX_BYTES from a line
 * start. An attempt with no such record answers 404: one still running, one
 * that wrote nothing to stderr or never started a container, one recovery
 * ended after its worker was lost, and one that ended before Phase 7.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { ATTEMPT_STDERR_MAX_BYTES, type AttemptStderr } from '@hermes-evals/shared';
import { attempts, runEvents } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { isSha256 } from '../../storage/blob-store.js';

/** What the collected event says of the stored log. */
export interface StderrLogRef {
  sha256: string;
  /** stderr.log's size on disk. */
  bytes: number;
  /** Lines in the whole log, when the worker counted them. */
  lines: number | null;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The stored log a `collected` payload names, read defensively; null when it names none. */
export function stderrLogRefOf(payload: unknown): StderrLogRef | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const log = p['stderr_log'];
  if (typeof log !== 'object' || log === null) return null;
  const { sha256, bytes } = log as Record<string, unknown>;
  const size = count(bytes);
  if (typeof sha256 !== 'string' || !isSha256(sha256) || size === null) return null;
  return { sha256, bytes: size, lines: count(p['stderr_lines']) };
}

/** Lines of a text as the worker counts them: a last line without its newline included. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines += 1;
  return text.endsWith('\n') ? lines : lines + 1;
}

/** The answer, from the stored text and what the collected event recorded. */
export function attemptStderrView(input: {
  runId: string;
  attempt: number;
  text: string;
  ref: StderrLogRef;
}): AttemptStderr {
  const { ref } = input;
  const truncated = ref.bytes > ATTEMPT_STDERR_MAX_BYTES;
  return {
    runId: input.runId,
    attempt: input.attempt,
    text: input.text,
    sizeBytes: ref.bytes,
    // The worker records the count with the log; the text's own count is the fallback.
    totalLines: ref.lines ?? lineCount(input.text),
    truncated,
  };
}

/** The id of attempt `n` of the run, or null. */
export async function attemptIdOf(db: AppDb, runId: string, n: number): Promise<string | null> {
  const [row] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.runId, runId), eq(attempts.number, n)));
  return row?.id ?? null;
}

/** The stored log the attempt's `collected` event names (the last one, should there be two). */
export async function stderrLogRef(db: AppDb, attemptId: string): Promise<StderrLogRef | null> {
  const [row] = await db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.attemptId, attemptId),
        eq(runEvents.type, 'platform'),
        sql`${runEvents.payload} ->> 'subtype' = 'collected'`,
      ),
    )
    .orderBy(desc(runEvents.seq))
    .limit(1);
  return row ? stderrLogRefOf(row.payload) : null;
}
