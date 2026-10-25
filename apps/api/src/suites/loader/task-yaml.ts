/**
 * task.yaml rules (plan 4.2). TaskYamlSchema checks the shape; the rules the
 * schema leaves to the loader are checked here, on the raw parsed value, so
 * one broken entry does not hide the problems of the others:
 *
 * - exactly one entry has `primary: true` (primary_count);
 * - keys are unique (duplicate_key);
 * - every type is a known scorer (unknown_type, from the schema's enum);
 * - params validate against that type's strict schema (params_invalid), after
 *   `answer.path` is applied to an answer-type primary that names no path;
 * - the rules a schema cannot state (paramRuleIssues): a text_match pattern
 *   must compile (params_invalid, with the compiler's reason), a
 *   trajectory_match `max_calls` beside `mode` is reported as unused, and a
 *   trajectory_match tool that looks like an MCP tool named another way than
 *   Hermes names it gets the name to use (both warnings);
 * - the checks' declared worst case fits one scoring pass
 *   (scoring/scoring-time.ts, schema_invalid on `verification`): pg-boss
 *   fails an evaluate-run job at its expiry, so a task that could outlast it
 *   would be graded `error` on every run however correct its checks.
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
  type ScorerParams,
  type ScorerType,
  type TaskYaml,
  type VerificationEntry,
} from '@hermes-evals/shared';
import {
  hermesMcpToolName,
  MCP_TOOL_PREFIX,
  sanitizeMcpNameComponent,
} from '../../execution/stream-json.js';
import { isAnswerScorerType, parseScorerParams } from '../../scoring/registry.js';
import { scoringTimeProblem, type TimedKey } from '../../scoring/scoring-time.js';
import { compileTextPattern } from '../../scoring/text-match.js';
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
  const timed: TimedKey[] = [];
  rawEntries.forEach((entry, index) => {
    if (!isRecord(entry) || !isScorerType(entry.type)) return;
    const written = entry.params === undefined ? {} : entry.params;
    if (!isRecord(written)) return; // the schema reported it
    const params = withAnswerPath(entry.type, entry.primary === true, written, answerPath);
    const result = parseScorerParams(entry.type, params);
    if (result.success) timed.push({ type: entry.type, params: result.data });
    const problems = result.success
      ? paramRuleIssues(entry.type, result.data)
      : result.error.issues.map((issue) => ({
          severity: 'error' as const,
          path: issueTarget(issue),
          message: issue.message,
        }));
    for (const problem of problems) {
      const target = ['verification', index, 'params', ...problem.path];
      issues.push({
        severity: problem.severity,
        code: 'params_invalid',
        ...(keyOf(index) !== undefined ? { key: keyOf(index) } : {}),
        path: at(target),
        message: `${keyOf(index) ?? `entry ${index}`}: ${formatPath(target.slice(2))}: ${problem.message}${lineOf(target)}`,
      });
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

  const tooSlow = scoringTimeProblem(timed);
  if (tooSlow !== null) {
    issues.push({
      severity: 'error',
      code: 'schema_invalid',
      path: at(['verification']),
      message: `${tooSlow}${lineOf(['verification'])}`,
    });
  }

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

/** A problem with schema-valid params, at a path inside `params`. */
export interface ParamRuleIssue {
  severity: LoadIssue['severity'];
  path: Path;
  message: string;
}

/**
 * Why a trajectory_match `tool` looks like an MCP tool that no call will
 * ever be named, or null (Phase 3 question 10). Hermes names server
 * `invoice-db`'s tool `list_invoices` `mcp__invoice_db__list_invoices`
 * (stream-json.ts hermesMcpToolName), and the scorer compares names exactly,
 * so these never match:
 * - `server.tool`: no tool Hermes offers has a dot in its name;
 * - `mcp_` with one underscore, such as `mcp_invoice_db_query`;
 * - `mcp__` with a server or tool part Hermes would sanitize, such as
 *   `mcp__invoice-db__list_invoices`.
 * A warning, not an error: the key still loads and grades, as `failed`.
 */
export function mcpToolNameProblem(tool: string): string | null {
  const dotted = /^([^.\s]+)\.([^.\s]+)$/.exec(tool);
  if (dotted) {
    const [, server, name] = dotted;
    return `${tool} looks like MCP server ${server}'s tool ${name}, which Hermes names ${hermesMcpToolName(server!, name!)}; no call is named ${tool}, so the key would always fail`;
  }
  if (tool.startsWith('mcp_') && !tool.startsWith(MCP_TOOL_PREFIX)) {
    return `${tool} looks like an MCP tool, but Hermes names MCP tools ${MCP_TOOL_PREFIX}<server>__<tool>, with two underscores after mcp and after the server (e.g. ${MCP_TOOL_PREFIX}invoice_db__query); no call is named ${tool}, so the key would always fail`;
  }
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    const rest = tool.slice(MCP_TOOL_PREFIX.length);
    // `_` is kept by the sanitizer, so the `__` between server and tool survives it.
    const sanitized = sanitizeMcpNameComponent(rest);
    if (sanitized !== rest) {
      return `${tool} is not a name Hermes gives an MCP tool: it replaces every character outside A-Z, a-z, 0-9 and _ with _, so the tool is ${MCP_TOOL_PREFIX}${sanitized}`;
    }
  }
  return null;
}

/**
 * Rules on params that already passed their type's schema:
 * - text_match: the pattern must compile as the scorer compiles it, so an
 *   invalid one is a load error with the compiler's reason ("The pattern is
 *   not valid: unterminated group.") instead of an `error` on every run;
 * - trajectory_match: with `mode`, the whole trajectory is compared against
 *   `min_calls` calls and `max_calls` is not read, which is worth a warning
 *   because an ignored setting changes what a run is graded on; and a tool
 *   named like an MCP tool in another form than Hermes's
 *   (mcpToolNameProblem) is a warning with the name to use.
 */
export function paramRuleIssues(type: ScorerType, params: unknown): ParamRuleIssue[] {
  if (type === 'text_match') {
    const { pattern, case_sensitive } = params as ScorerParams<'text_match'>;
    if (pattern === undefined) return [];
    const compiled = compileTextPattern(pattern, case_sensitive);
    return compiled.ok ? [] : [{ severity: 'error', path: ['pattern'], message: compiled.message }];
  }
  if (type === 'trajectory_match') {
    const { tool, mode, max_calls } = params as ScorerParams<'trajectory_match'>;
    const issues: ParamRuleIssue[] = [];
    const misnamed = mcpToolNameProblem(tool);
    if (misnamed !== null) issues.push({ severity: 'warning', path: ['tool'], message: misnamed });
    if (mode !== undefined && max_calls !== undefined) {
      issues.push({
        severity: 'warning',
        path: ['max_calls'],
        message: `max_calls is not used with mode: ${mode}; the trajectory is compared with min_calls calls of the tool`,
      });
    }
    return issues;
  }
  return [];
}
