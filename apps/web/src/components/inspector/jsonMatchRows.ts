/**
 * json_match's evidence key by key (Phase 5 section 6.1, Phase 7; RunInspectorStates › JSON
 * match with partial credit): one row per key or item of the compared value, with the
 * answer's value where it matches and "expected 2, got 3" where it does not. Rows stored
 * before Phase 7 have no entries; ScoreEvidence then lists the mismatches' paths alone.
 */
import type { JsonValue } from '@hermes-evals/shared';
import type { JsonMatchEntry, JsonMatchEvidence } from '@/api/types/runs';
import { inlineJson } from './inspectorFormat';

/** One row of the evidence table. */
export interface JsonMatchRow {
  /** The key (`Granite Office`), the item (`[2]`), or `value` for a value compared whole. */
  label: string;
  match: boolean;
  /** The answer's value on a match; what differs otherwise. */
  note: string;
}

/** Rows a table shows before "Show all"; every mismatch shows either way. */
export const JSON_MATCH_ROWS_SHOWN = 20;

const shown = (value: JsonValue | undefined): string =>
  value === undefined ? '' : inlineJson(value);

function noteOf(entry: JsonMatchEntry): string {
  if (entry.match) return shown(entry.observed ?? entry.expected);
  if (entry.observed === undefined)
    return `expected ${shown(entry.expected)}, missing from the answer`;
  if (entry.expected === undefined) return `not in the reference, got ${shown(entry.observed)}`;
  return `expected ${shown(entry.expected)}, got ${shown(entry.observed)}`;
}

/** The table's rows, in the evidence's order (the reference's, then what only the answer has). */
export function jsonMatchRows(evidence: JsonMatchEvidence): JsonMatchRow[] {
  return (evidence.entries ?? []).map((entry) => ({
    label: entry.path === '' ? 'value' : entry.path,
    match: entry.match,
    note: noteOf(entry),
  }));
}

/**
 * The caption under the table: "Compared at `overdue_by_vendor` against the reference, key
 * by key. The score is the share of keys that match." Backticks mark code.
 */
export function jsonMatchCaption(evidence: JsonMatchEvidence): string {
  const where = evidence.path ? ` at \`${evidence.path}\`` : '';
  if (evidence.unit === 'keys') {
    return `Compared${where} against the reference, key by key. The score is the share of keys that match.`;
  }
  if (evidence.unit === 'items') {
    return `Compared${where} against the reference, item by item. The score is the share of items that match.`;
  }
  return `Compared${where} with the reference as one value.`;
}

/** True when the evidence has a mismatch to show, so the score's expander opens by itself. */
export function hasJsonMismatch(evidence: JsonMatchEvidence | null): boolean {
  if (!evidence) return false;
  return evidence.mismatches.length > 0 || (evidence.entries ?? []).some((e) => !e.match);
}
