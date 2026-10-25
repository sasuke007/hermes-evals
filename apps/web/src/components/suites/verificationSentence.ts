/**
 * Splits a verification entry's sentence (served by the API: "json_match on duplicates,
 * unordered, pass at 1.0") into plain text and the values it names (answer paths, files,
 * tools, phrases, patterns), so VerificationSentence can set the values in code, as the
 * TaskDetail board does: "json_match on `duplicates`, unordered, pass at 1.0". Works for all
 * eight check types: the values come from the entry's own params.
 */
import type { JsonValue } from '@hermes-evals/shared';
import type { VerificationEntryView } from '@/api/types/suites';

export interface SentenceSegment {
  text: string;
  kind: 'type' | 'text' | 'value';
}

const strings = (value: JsonValue | undefined): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
};

/** The values of an entry that its sentence may quote, longest first. */
export function sentenceValues(
  entry: Pick<VerificationEntryView, 'type' | 'params' | 'sentence'>,
): string[] {
  const p = entry.params;
  const values: string[] = [];
  // The scored path: what follows "<type> on " up to the next comma (the API may name
  // task.yaml's answer path there when the params name none).
  const target = new RegExp(`^${entry.type} on (.+?)(?:,|$)`).exec(entry.sentence)?.[1];
  if (target && target !== 'the whole answer') values.push(target);
  values.push(...strings(p.path), ...strings(p.script), ...strings(p.rubric));
  values.push(...strings(p.model), ...strings(p.tool), ...strings(p.columns));
  values.push(...strings(p.exclude_keys));
  if (p.args && typeof p.args === 'object' && !Array.isArray(p.args)) {
    for (const [k, v] of Object.entries(p.args)) {
      values.push(...strings(v));
      if (typeof v !== 'string') values.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  // Phrases are quoted as JSON in the sentence: contains "1.5%", "30 days".
  values.push(...strings(p.contains).map((s) => JSON.stringify(s)));
  if (typeof p.pattern === 'string') values.push(`/${p.pattern}/`);
  return [...new Set(values.filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** The sentence as segments: the type name first, then text and values. */
export function sentenceSegments(
  entry: Pick<VerificationEntryView, 'type' | 'params' | 'sentence'>,
): SentenceSegment[] {
  const out: SentenceSegment[] = [];
  let rest = entry.sentence;
  if (rest.startsWith(entry.type)) {
    out.push({ text: entry.type, kind: 'type' });
    rest = rest.slice(entry.type.length);
  }
  const values = sentenceValues(entry);
  let text = '';
  let i = 0;
  while (i < rest.length) {
    const found = values.find(
      (v) =>
        rest.startsWith(v, i) &&
        // A value is a whole word: "file" must not match inside "file_check".
        !(isWordChar(v[0]) && isWordChar(rest[i - 1])) &&
        !(isWordChar(v[v.length - 1]) && isWordChar(rest[i + v.length])),
    );
    if (found) {
      if (text) out.push({ text, kind: 'text' });
      out.push({ text: found, kind: 'value' });
      text = '';
      i += found.length;
    } else {
      text += rest[i];
      i += 1;
    }
  }
  if (text) out.push({ text, kind: 'text' });
  return out;
}
