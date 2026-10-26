/**
 * Setting one param of a check: a value replaces it, undefined removes it (an emptied field
 * leaves task.yaml without the key, so the scorer's default applies).
 */
import type { JsonValue } from '@hermes-evals/shared';

export type Params = Record<string, JsonValue>;

export function withParam(params: Params, name: string, value: JsonValue | undefined): Params {
  const next = { ...params };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}

/** The props every type's fields take. */
export interface FieldProps {
  params: Params;
  /** The check's own field issues, by param name ("abs", "pass_at"). */
  errors: Record<string, string>;
  readonly: boolean;
}

export const asString = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '');
export const asList = (v: JsonValue | undefined): string[] =>
  Array.isArray(v) ? v.map(String) : [];
