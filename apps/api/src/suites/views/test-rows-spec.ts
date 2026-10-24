/**
 * Row builders for the view tests: suites, suite_sources, tasks and
 * task_files rows as Drizzle reads them, with the sample suite's values.
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it as a test file.
 */
import { createHash } from 'node:crypto';
import type { SelfCheck, VerificationEntry } from '@hermes-evals/shared';
import type { SourceRow, SuiteRow, TaskFileRow, TaskRow } from './rows.js';

export const hash = (seed: string): string => createHash('sha256').update(seed).digest('hex');

export const T0 = new Date('2026-10-21T15:31:12.000Z');
export const T1 = new Date('2026-10-23T09:12:04.000Z');
export const T2 = new Date('2026-10-23T15:41:07.000Z');
export const T3 = new Date('2026-10-23T16:05:31.000Z');

export function suiteRow(versionNumber: number, over: Partial<SuiteRow> = {}): SuiteRow {
  return {
    id: `suite_v${versionNumber}`,
    sourcePath: 'invoices-v1',
    versionNumber,
    name: 'invoices-v1',
    versionLabel: '0.1',
    description: 'Accounts-payable questions over one family of invoice fixtures.',
    contentHash: hash(`suite v${versionNumber}`),
    checkHash: hash(`checks v${versionNumber}`),
    taskCount: 2,
    validCount: 2,
    loadedAt: T0,
    ...over,
  };
}

export function sourceRow(current: SuiteRow | null, over: Partial<SourceRow> = {}): SourceRow {
  return {
    path: 'invoices-v1',
    name: 'invoices-v1',
    currentSuiteId: current?.id ?? null,
    lastAttemptedAt: T1,
    lastOutcome: 'unchanged',
    lastError: null,
    lastChanges: null,
    ...over,
  };
}

export const TOTAL_DUE_YAML = `summary: Total amount still due
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file]
answer:
  format: fenced_json
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params:
      path: total_due
      abs: 0.01
`;

export const TOTAL_DUE_VERIFICATION: VerificationEntry[] = [
  {
    key: 'answer',
    type: 'numeric_tolerance',
    primary: true,
    params: { path: 'total_due', abs: 0.01 },
  },
];

export const PASSED_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: T1.toISOString(),
  duration_ms: 4,
  results: [
    {
      key: 'answer',
      type: 'numeric_tolerance',
      mode: 'answer',
      status: 'passed',
      score: 1,
      comment: 'within 0.01',
    },
  ],
};

export function taskRow(suite: SuiteRow, over: Partial<TaskRow> = {}): TaskRow {
  const key = over.key ?? 'total_due';
  return {
    id: `task_${suite.versionNumber}_${key}`,
    suiteId: suite.id,
    key,
    versionNumber: 1,
    introducedInSuiteId: suite.id,
    position: 0,
    summary: 'Total amount still due',
    prompt: 'What is the total still due?\nReply with a fenced JSON block.',
    taskYaml: TOTAL_DUE_YAML,
    limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
    reference: { total_due: 48213.65 },
    verification: TOTAL_DUE_VERIFICATION,
    selfCheck: PASSED_CHECK,
    loadIssues: [],
    valid: true,
    invalidReason: null,
    contentHash: hash(`${key} v1`),
    ...over,
  };
}

export function fileRow(
  task: TaskRow,
  path: string,
  content: string,
  kind: TaskFileRow['kind'] = 'fixture',
): TaskFileRow {
  return {
    taskId: task.id,
    path,
    kind,
    sha256: hash(content),
    size: Buffer.byteLength(content),
  };
}
