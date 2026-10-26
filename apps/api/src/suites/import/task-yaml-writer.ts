/**
 * task.yaml for a task the import creates (plan 4.6: new files use one
 * canonical style), in the style of the committed suites:
 *
 *   summary: How many overdue invoices does Fjord Software have?
 *   limits:
 *     max_turns: 20
 *     run_budget_seconds: 300
 *     toolsets_needed: [file, terminal]
 *   answer:
 *     format: fenced_json
 *     path: answer
 *   verification:
 *     - key: answer
 *       type: numeric_tolerance
 *       primary: true
 *       params: { abs: 0 }
 *
 * The style is the drafts module's (renderYaml in ../drafts/yaml-patch.ts),
 * which also writes the editor's blank tasks, so every new file reads alike.
 * Copying the checks of another task (`checks.from: task`) takes its
 * `verification` as values, so the copy is in this style too, whatever the
 * source's formatting.
 */
import { parseDocument } from 'yaml';
import type { TaskFormCheck } from '@hermes-evals/shared';
import { renderYaml } from '../drafts/yaml-patch.js';

export interface NewTaskYaml {
  summary: string;
  limits: { maxTurns: number; runBudgetSeconds: number; toolsetsNeeded: readonly string[] };
  /** `answer.path`; null leaves it out (the whole answer block is compared). */
  answerPath: string | null;
  /** The entries as written: `key`, `type`, `primary`, `params` and whatever else the source had. */
  verification: readonly Record<string, unknown>[];
}

/** A check of the import's settings as a task.yaml entry: `primary` only when true, `params` only when set. */
export function verificationEntryOf(check: TaskFormCheck): Record<string, unknown> {
  return {
    key: check.key,
    type: check.type,
    ...(check.primary ? { primary: true } : {}),
    ...(Object.keys(check.params).length > 0 ? { params: check.params } : {}),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `verification` entries of a task.yaml, as values, with their keys in
 * the canonical order (key, type, primary, params, then the rest as
 * written). Null when the text does not parse or holds no list of entries.
 */
export function verificationOf(taskYaml: string | null): Record<string, unknown>[] | null {
  if (taskYaml === null) return null;
  const doc = parseDocument(taskYaml, { uniqueKeys: true });
  if (doc.errors.length > 0) return null;
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch {
    return null;
  }
  const entries = isRecord(value) ? value.verification : undefined;
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isRecord)) return null;
  const order = ['key', 'type', 'primary', 'params'];
  return entries.map((entry) => {
    const known = order.filter((k) => Object.hasOwn(entry, k)).map((k) => [k, entry[k]] as const);
    const rest = Object.entries(entry).filter(([k]) => !order.includes(k));
    return Object.fromEntries([...known, ...rest]);
  });
}

export function newTaskYaml(task: NewTaskYaml): string {
  return renderYaml({
    summary: task.summary,
    limits: {
      max_turns: task.limits.maxTurns,
      run_budget_seconds: task.limits.runBudgetSeconds,
      toolsets_needed: [...task.limits.toolsetsNeeded],
    },
    answer: {
      format: 'fenced_json',
      ...(task.answerPath !== null && task.answerPath !== '' ? { path: task.answerPath } : {}),
    },
    verification: task.verification,
  });
}
