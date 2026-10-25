/**
 * The first line of a stderr tail, one rule for both sides of the circuit
 * breaker's "in 14 of 14 runs": finish.ts stores it as the failure's
 * `stderr_first_line`, and the Overview (experiments/views/failure.ts)
 * compares every failed run's tail with it. Using one helper keeps a long
 * first line comparable: the stored copy is cut, so the other side must be
 * cut the same way.
 */

/** Longest first line kept, in characters. */
export const FIRST_LINE_MAX_CHARS = 500;

/**
 * The session banner Hermes prints on stderr in every run that got that far
 * (`Session: <id>` from hermes_cli/gateway_chat.py, `session_id: <id>` from
 * stream_json.py at 4d04303). It names the run, not what went wrong, and
 * differs in every run, so as a first line it made every failure with a
 * result look unique ("in 1 of 14 runs").
 */
const SESSION_BANNER = /^(?:Session|session_id): \S+$/;

/**
 * The first non-blank line of `text` that is not Hermes's session banner,
 * trimmed and cut to FIRST_LINE_MAX_CHARS, or null.
 */
export function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || SESSION_BANNER.test(line)) continue;
    // Trimmed again after the cut, so a cut that ends in a space reads the same both sides.
    return line.slice(0, FIRST_LINE_MAX_CHARS).trimEnd();
  }
  return null;
}
