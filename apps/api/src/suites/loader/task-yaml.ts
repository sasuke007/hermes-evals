/**
 * task.yaml rules (plan 4.2). TaskYamlSchema checks the shape; the rules the
 * schema leaves to the loader are checked here, on the raw parsed value, so
 * one broken entry does not hide the problems of the others:
 *
 * - exactly one entry has `primary: true` (primary_count);
 * - keys are unique (duplicate_key);
 * - every type is a known scorer (unknown_type, from the schema's enum);
 * - params validate against that type's strict schema (params_invalid), after
 *   `answer.path` is applied to an answer-type primary that names no path.
 *
 * Issue paths point into the file: `task.yaml#verification[1].params.path`,
 * with 0-based list indices. Messages end with the line they refer to.
 */
import type { Document, LineCounter } from 'yaml';
import {
  SCORER_TYPES,
  TaskYamlSchema,
  VerificationYamlSchema,
  type LoadIssue,
  type ScorerType,
  type TaskYaml,
  type VerificationEntry,
} from '@hermes-evals/shared';
import { isAnswerScorerType, parseScorerParams } from '../../scoring/registry.js';
import { TASK_YAML } from './limits.js';
import { formatPath, issueTarget, positionOf } from './yaml-source.js';

export interface TaskYamlCheck {
  /** The schema-valid file, or null when its shape is wrong. */
  data: TaskYaml | null;
  /**
   * Every entry that is well-formed on its own, with effective params: as
   * written, plus `answer.path` on the primary. Stored on the task row even
   * when the task is invalid, so the page can show what was declared.
   */
  verification: VerificationEntry[];
  /** Raw entry index of each `verification` element, for issue paths. */
  indices: number[];
  issues: LoadIssue[];
}

type Path = readonly PropertyKey[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScorerType = (value: unknown): value is ScorerType =>
  typeof value === 'string' && (SCORER_TYPES as readonly string[]).includes(value);

export function checkTaskYaml(
  value: unknown,
  doc: Document.Parsed,
  lines: LineCounter,
): TaskYamlCheck {
  const issues: LoadIssue[] = [];
  const at = (path: Path): string =>
    path.length === 0 ? TASK_YAML : `${TASK_YAML}#${formatPath(path)}`;
  const lineOf = (path: Path): string => {
    const pos = positionOf(doc, lines, path);
    return pos ? ` (line ${pos.line})` : '';
  };
  const raw = isRecord(value) ? value : {};
  const rawEntries: unknown[] = Array.isArray(raw.verification) ? raw.verification : [];
  const keyOf = (index: unknown): string | undefined => {
    const entry = typeof index === 'number' ? rawEntries[index] : undefined;
    return isRecord(entry) && typeof entry.key === 'string' ? entry.key : undefined;
  };

  const parsed = TaskYamlSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const target = issueTarget(issue);
      const inEntry = target[0] === 'verification' ? keyOf(target[1]) : undefined;
      const written =
        target[0] === 'verification' && target[2] === 'type' && target.length === 3
          ? (rawEntries[target[1] as number] as { type?: unknown }).type
          : undefined;
      // A type that is written but not in the registry; a missing one is a shape error.
      const unknownType = issue.code === 'invalid_value' && written !== undefined;
      issues.push({
        severity: 'error',
        code: unknownType ? 'unknown_type' : 'schema_invalid',
        ...(inEntry !== undefined ? { key: inEntry } : {}),
        path: at(target),
        message: unknownType
          ? `unknown scorer type ${JSON.stringify(written)}; known types: ${SCORER_TYPES.join(', ')}${lineOf(target)}`
          : `${formatPath(target) || 'task.yaml'}: ${issue.message}${lineOf(target)}`,
      });
    }
  }

  // Exactly one primary, among the entries as written.
  if (rawEntries.length > 0) {
    const primaries = rawEntries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => isRecord(entry) && entry.primary === true);
    if (primaries.length !== 1) {
      const named = primaries.map(({ index }) => keyOf(index) ?? `#${index}`).join(', ');
      issues.push({
        severity: 'error',
        code: 'primary_count',
        path: at(['verification']),
        message:
          primaries.length === 0
            ? `no verification entry has primary: true; exactly one must${lineOf(['verification'])}`
            : `${primaries.length} verification entries have primary: true (${named}); exactly one must${lineOf(['verification'])}`,
      });
    }
  }

  // Unique keys: every repeat is reported where it is written.
  const firstIndex = new Map<string, number>();
  rawEntries.forEach((_entry, index) => {
    const key = keyOf(index);
    if (key === undefined) return;
    const first = firstIndex.get(key);
    if (first === undefined) {
      firstIndex.set(key, index);
      return;
    }
    issues.push({
      severity: 'error',
      code: 'duplicate_key',
      key,
      path: at(['verification', index, 'key']),
      message: `key ${key} is used by verification entries ${first} and ${index}; keys must be unique${lineOf(['verification', index, 'key'])}`,
    });
  });

  // Params against each type's strict schema, with answer.path applied first.
  const answerPath =
    isRecord(raw.answer) && typeof raw.answer.path === 'string' && raw.answer.path !== ''
      ? raw.answer.path
      : undefined;
  const verification: VerificationEntry[] = [];
  const indices: number[] = [];
  rawEntries.forEach((entry, index) => {
    if (!isRecord(entry) || !isScorerType(entry.type)) return;
    const written = entry.params === undefined ? {} : entry.params;
    if (!isRecord(written)) return; // the schema reported it
    const params = withAnswerPath(entry.type, entry.primary === true, written, answerPath);
    const result = parseScorerParams(entry.type, params);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const target = ['verification', index, 'params', ...issueTarget(issue)];
        issues.push({
          severity: 'error',
          code: 'params_invalid',
          ...(keyOf(index) !== undefined ? { key: keyOf(index) } : {}),
          path: at(target),
          message: `${keyOf(index) ?? `entry ${index}`}: ${formatPath(target.slice(2))}: ${issue.message}${lineOf(target)}`,
        });
      }
    }
    const shaped = VerificationYamlSchema.safeParse(entry);
    if (shaped.success) {
      verification.push({
        key: shaped.data.key,
        type: shaped.data.type,
        primary: shaped.data.primary,
        params,
      });
      indices.push(index);
    }
  });

  return { data: parsed.success ? parsed.data : null, verification, indices, issues };
}

/**
 * The params an entry is graded with. The primary key of an answer type that
 * names no `path` scores `answer.path` (plan 4.2). Other types never take it:
 * file_check's `path` is a workspace file, not a place in the answer.
 */
export function withAnswerPath(
  type: ScorerType,
  primary: boolean,
  params: Record<string, unknown>,
  answerPath: string | undefined,
): Record<string, unknown> {
  if (!primary || answerPath === undefined || !isAnswerScorerType(type) || 'path' in params) {
    return params;
  }
  return { ...params, path: answerPath };
}
