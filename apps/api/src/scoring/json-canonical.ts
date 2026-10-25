/**
 * The canonical text json_match compares values by, shared by the matcher
 * and by the mismatch paths it reports.
 */
import type { JsonValue } from '@hermes-evals/shared';

export type JsonObject = { [key: string]: JsonValue };

export const isObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Which lists compare as multisets: this one (`here`) and every list inside a list (`inner`). */
export interface ListOrder {
  here: boolean;
  inner: boolean;
}

/**
 * Canonical text of a value: object keys sorted, and a list sorted by its
 * items' canonical text when the order says it is a multiset. Two values are
 * equal under the options exactly when their texts are equal.
 */
export function canonicalText(value: JsonValue, order: ListOrder): string {
  if (Array.isArray(value)) {
    const inside: ListOrder = { here: order.inner, inner: order.inner };
    const items = value.map((item) => canonicalText(item, inside));
    if (order.here) items.sort();
    return `[${items.join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalText(value[k]!, order)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
