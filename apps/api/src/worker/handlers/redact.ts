/**
 * Replaces secret values in text the platform keeps or shows (stderr tails,
 * error messages, tool descriptions) with `<from env NAME>`, the marker the
 * launch record and the UI use (plan 8.3). The worker passes stdio MCP values
 * into trial containers, so anything a trial prints may echo one.
 *
 * Redact whole texts before cutting them: a value the cut splits would leave
 * a piece no exact match finds. Only an encoded value gets past this (hex,
 * base64); that is why reserved names never reach a container at all.
 */

/** Shortest start of a value that redactTruncated masks; shorter ones are ordinary words. */
export const MIN_PARTIAL_VALUE_CHARS = 4;

/** Each value and its JSON-escaped form, to the name it came from. Empty values are skipped. */
function formsOf(values: Readonly<Record<string, string>>): Map<string, string> {
  const byForm = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    if (value === '') continue;
    for (const form of [value, JSON.stringify(value).slice(1, -1)]) {
      if (!byForm.has(form)) byForm.set(form, name);
    }
  }
  return byForm;
}

/**
 * One pass over the text, longest value first, so a value that contains
 * another is replaced whole and no marker is rewritten. Each value is also
 * matched in its JSON-escaped form, as a JSON log line would carry it.
 * Empty values are skipped: they are never set (an empty value counts as missing).
 */
export function redactValues(text: string, values: Readonly<Record<string, string>>): string {
  const byForm = formsOf(values);
  if (byForm.size === 0) return text;
  const pattern = new RegExp(
    [...byForm.keys()]
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );
  return text.replace(pattern, (match) => `<from env ${byForm.get(match)}>`);
}

const ELLIPSIS = '...';

/**
 * redactValues for a text that may have been cut short with "...": Hermes
 * prints each tool description as its first 55 characters and "...", so a
 * description that held a value can end in the start of it. When the text
 * ends with "..." and the characters before it begin a value (at least
 * MIN_PARTIAL_VALUE_CHARS of them), they become the marker too.
 */
export function redactTruncated(text: string, values: Readonly<Record<string, string>>): string {
  const full = redactValues(text, values);
  if (!full.endsWith(ELLIPSIS)) return full;
  const body = full.slice(0, -ELLIPSIS.length);
  const forms = [...formsOf(values)].sort(([a], [b]) => b.length - a.length);
  let best: { length: number; name: string } | null = null;
  for (const [form, name] of forms) {
    for (let n = Math.min(form.length - 1, body.length); n >= MIN_PARTIAL_VALUE_CHARS; n--) {
      if (body.endsWith(form.slice(0, n))) {
        if (!best || n > best.length) best = { length: n, name };
        break;
      }
    }
  }
  return best ? `${body.slice(0, -best.length)}<from env ${best.name}>${ELLIPSIS}` : full;
}
