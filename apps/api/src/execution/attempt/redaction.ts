/**
 * Keeps the secret values a trial holds out of everything the platform
 * stores about it (plan 8.3, 13). A trial holds two kinds: the env values of
 * its stdio MCP servers, which the worker passes into the container, and its
 * own attempt token. Anything the trial prints may echo either (an agent can
 * run `env`), so every event payload, the final text, the stderr tail, the
 * error message and the network log pass through here before they are kept,
 * each value replaced by `<from env NAME>` (redact.ts).
 *
 * Only exact and JSON-escaped forms are caught: an encoded value gets past
 * any redaction, which is why reserved names never reach a container at all.
 */
import { redactValues } from '../../worker/handlers/redact.js';

const marker = (name: string): string => `<from env ${name}>`;

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

export class Redactor {
  /** How many values were replaced so far, over every text and payload passed through. */
  count = 0;
  private readonly values: Readonly<Record<string, string>>;
  /** Every form a value is matched in; a text containing none of them is returned as is. */
  private readonly forms: string[];

  /** `values` maps each variable name to its value; empty values are never set, so never matched. */
  constructor(values: Readonly<Record<string, string>>) {
    this.values = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
    this.forms = Object.values(this.values).flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
    ]);
  }

  /** Whether `text` holds any value, in any form matched. */
  holdsValue(text: string): boolean {
    return this.forms.some((form) => text.includes(form));
  }

  /** The text with every value replaced by `<from env NAME>`, counting the replacements. */
  text(text: string): string {
    if (!this.holdsValue(text)) return text;
    const redacted = redactValues(text, this.values);
    this.count += Math.max(0, this.markers(redacted) - this.markers(text));
    return redacted;
  }

  /** The text with every value replaced, not counted: for a text that is cut before it is kept. */
  textUncounted(text: string): string {
    return this.holdsValue(text) ? redactValues(text, this.values) : text;
  }

  /** How many `<from env NAME>` markers of this attempt's names the text holds. */
  markers(text: string): number {
    let total = 0;
    for (const name of Object.keys(this.values)) total += occurrences(text, marker(name));
    return total;
  }

  /** Redacts every string, keys included, of a JSON value; returns the same value when it holds none. */
  json<T>(value: T): T {
    if (this.forms.length === 0 || !this.holdsValue(JSON.stringify(value) ?? '')) return value;
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.text(key), this.walk(item)]),
      );
    }
    return value;
  }
}
