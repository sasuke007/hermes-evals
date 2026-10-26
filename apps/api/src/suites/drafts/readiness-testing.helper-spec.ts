/**
 * Test helpers for the readiness specs: draft tasks in memory, with their
 * blobs in a map, run through evaluateReadiness. Test-only: the name ends
 * in `-spec.ts`, so the build leaves it out, and not in `.spec.ts`, so
 * vitest does not run it as a test file.
 */
import {
  TaskReadinessSchema,
  type ReadinessRule,
  type ReadinessRuleResult,
} from '@hermes-evals/shared';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import { sha256Hex } from '../loader/hashing.js';
import type { DraftFileRef, DraftTaskFolder } from './materialise.js';
import { evaluateReadiness } from './readiness.js';

export const NOW = new Date('2026-10-26T16:31:00.000Z');

export const OVERDUE_YAML = `summary: Count invoices past due as of 1 Oct 2026
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
  path: overdue_count
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0 }
`;

export const OVERDUE_PROMPT = `Your working directory contains \`invoices.csv\`.

How many invoices are overdue?

End your reply with your answer as a fenced JSON block, exactly in this shape:

\`\`\`json
{ "overdue_count": 0 }
\`\`\`
`;

export const INVOICES = 'invoice_no,amount,status\nINV-1,10.00,open\n';

/** A blob store in memory: the refs of `files` and a reader over them. */
export function blobs(
  files: Record<string, string | { size: number }>,
  kinds: Record<string, DraftFileRef['kind']> = {},
) {
  const store = new Map<string, Buffer>();
  const refs: DraftFileRef[] = Object.entries(files).map(([path, content]) => {
    const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.alloc(0);
    const sha256 = sha256Hex(Buffer.concat([bytes, Buffer.from(path)]));
    store.set(sha256, bytes);
    const kind =
      kinds[path] ??
      (path.startsWith('fixtures/')
        ? 'fixture'
        : path.startsWith('verify/')
          ? 'verifier'
          : 'other');
    return { path, kind, sha256, size: typeof content === 'string' ? bytes.length : content.size };
  });
  return {
    refs,
    readBlob: async (sha256: string) => {
      const bytes = store.get(sha256);
      if (!bytes) throw new Error('no blob');
      return bytes;
    },
  };
}

export interface Case {
  key?: string;
  taskYaml?: string | null;
  prompt?: string | null;
  reference?: string | null;
  files?: Record<string, string | { size: number }>;
  kinds?: Record<string, DraftFileRef['kind']>;
  otherKeys?: string[];
  renamedFrom?: string | null;
  lastSelfCheck?: DraftSelfCheckRecord | null;
}

export async function readiness(c: Case = {}) {
  const store = blobs(c.files ?? { 'fixtures/invoices.csv': INVOICES }, c.kinds);
  const task: DraftTaskFolder = {
    key: c.key ?? 'overdue_count',
    taskYaml: c.taskYaml === undefined ? OVERDUE_YAML : c.taskYaml,
    prompt: c.prompt === undefined ? OVERDUE_PROMPT : c.prompt,
    reference: c.reference === undefined ? '{ "overdue_count": 17 }\n' : c.reference,
    rubrics: {},
    files: store.refs,
  };
  const outcome = await evaluateReadiness(task, {
    folder: 'invoices-v1',
    otherKeys: c.otherKeys ?? ['total_due'],
    renamedFrom: c.renamedFrom ?? null,
    readBlob: store.readBlob,
    lastSelfCheck: c.lastSelfCheck ?? null,
    now: () => NOW,
  });
  const parsed = TaskReadinessSchema.parse(outcome.readiness);
  const rule = (name: ReadinessRule): ReadinessRuleResult =>
    parsed.rules.find((r) => r.rule === name)!;
  return { ...parsed, rule, analysis: outcome.analysis };
}

export const status = (r: ReadinessRuleResult) => [r.status, r.message];
