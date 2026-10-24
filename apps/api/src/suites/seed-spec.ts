/**
 * A suite directory as the loader would leave it after two loads, inserted
 * row by row (no loader involved) with its files in a real blob store:
 *
 *   v1  total_due v1 (valid), late_fees v1 (valid)
 *   v2  total_due v1 (carried over), late_fees v2 (policy_terms.json
 *       changed; its verifier now prints no result line, so it is invalid)
 *
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it as a test file.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SelfCheck, VerificationEntry } from '@hermes-evals/shared';
import { suiteSources, suites, taskFiles, tasks } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { BlobStore } from '../storage/blob-store.js';
import { hash } from './views/test-rows-spec.js';

export const T_V1 = new Date('2026-10-21T15:31:12.000Z');
export const T_V2 = new Date('2026-10-23T15:41:07.000Z');

export const INVOICES_CSV =
  'invoice_no,vendor_name,amount,status\n' +
  Array.from(
    { length: 12 },
    (_, i) => `INV-${1000 + i},Vendor ${i % 3},${(100 + i).toFixed(2)},open`,
  ).join('\n') +
  '\n';

/** Over INLINE_PREVIEW_LIMIT, so Task detail names it without an inline preview. */
export const LEDGER_CSV =
  'entry,account,debit,credit\n' +
  Array.from({ length: 4000 }, (_, i) => `${i + 1},4000-${i % 7},${i}.00,0.00`).join('\n') +
  '\n';

export const README_MD = '# Notes\n\nInvoices are in EUR.\n';
export const POLICY_V1 = '{"late_fee_rate": 0.015, "grace_days": 10}\n';
export const POLICY_V2 = '{"late_fee_percent": 1.5, "grace_days": 10}\n';
export const CHECK_PY = `import json, sys
policy = json.load(open("fixtures/policy_terms.json"))
rate = policy["late_fee_rate"]
print(json.dumps({"key": "check", "score": 1.0, "comment": "ok"}))
`;

const TOTAL_DUE_YAML = `summary: Total amount still due
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
      path: total_due   # euros
      abs: 0.01
`;

const LATE_FEES_YAML = `summary: Late fees owed
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { path: late_fees_total, abs: 0.01 }
  - key: check
    type: verifier_script
    params:
      script: check_late_fees.py
      timeout_s: 30
      pass_at: 1.0
`;

const TOTAL_DUE_VERIFICATION: VerificationEntry[] = [
  {
    key: 'answer',
    type: 'numeric_tolerance',
    primary: true,
    params: { path: 'total_due', abs: 0.01 },
  },
];

const LATE_FEES_VERIFICATION: VerificationEntry[] = [
  {
    key: 'answer',
    type: 'numeric_tolerance',
    primary: true,
    params: { path: 'late_fees_total', abs: 0.01 },
  },
  {
    key: 'check',
    type: 'verifier_script',
    primary: false,
    params: { script: 'check_late_fees.py', timeout_s: 30, pass_at: 1.0 },
  },
];

const ANSWER_PASSED: SelfCheck['results'][number] = {
  key: 'answer',
  type: 'numeric_tolerance',
  mode: 'answer',
  status: 'passed',
  score: 1,
  comment: 'within 0.01',
  duration_ms: 2,
};

const ARGV = [
  'python3',
  'verify/check_late_fees.py',
  '--answer',
  'reference.json',
  '--workspace',
  'fixtures/',
];

const LATE_FEES_V1_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: T_V1.toISOString(),
  duration_ms: 310,
  results: [
    ANSWER_PASSED,
    {
      key: 'check',
      type: 'verifier_script',
      mode: 'script',
      status: 'passed',
      score: 1,
      comment: 'ok',
      duration_ms: 300,
      argv: ARGV,
      exit_code: 0,
      stdout_tail: '{"key": "check", "score": 1.0, "comment": "ok"}\n',
      stderr_tail: '',
    },
  ],
};

const LATE_FEES_V2_CHECK: SelfCheck = {
  status: 'error',
  ran_at: T_V2.toISOString(),
  duration_ms: 290,
  results: [
    ANSWER_PASSED,
    {
      key: 'check',
      type: 'verifier_script',
      mode: 'script',
      status: 'error',
      score: null,
      comment: 'no result line on stdout',
      duration_ms: 280,
      argv: ARGV,
      exit_code: 1,
      stdout_tail: '',
      stderr_tail:
        'Traceback (most recent call last):\n  File "verify/check_late_fees.py", line 3, in <module>\n    rate = policy["late_fee_rate"]\nKeyError: \'late_fee_rate\'\n',
    },
  ],
};

const TOTAL_DUE_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: T_V1.toISOString(),
  duration_ms: 3,
  results: [ANSWER_PASSED],
};

export interface SeededDirectory {
  store: BlobStore;
  v1: { id: string; totalDue: string; lateFees: string };
  v2: { id: string; totalDue: string; lateFees: string };
  dispose(): Promise<void>;
}

/** Stores `content` in the blob store and records it in `blobs`, as the loader does. */
async function put(db: AppDb, store: BlobStore, content: string) {
  const ref = await store.putBuffer(Buffer.from(content));
  await store.recordBlob(db, ref);
  return ref;
}

/** The directory `invoices-v1` with versions v1 and v2 (see the file comment). */
export async function seedSuiteDirectory(db: AppDb): Promise<SeededDirectory> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-suites-'));
  const store = new BlobStore(dataDir);
  const blob = {
    invoices: await put(db, store, INVOICES_CSV),
    ledger: await put(db, store, LEDGER_CSV),
    readme: await put(db, store, README_MD),
    policyV1: await put(db, store, POLICY_V1),
    policyV2: await put(db, store, POLICY_V2),
    check: await put(db, store, CHECK_PY),
  };

  return db.transaction(async (tx) => {
    const [v1, v2] = await tx
      .insert(suites)
      .values(
        [1, 2].map((n) => ({
          sourcePath: 'invoices-v1',
          versionNumber: n,
          name: 'invoices-v1',
          versionLabel: '0.1',
          description: 'Accounts-payable questions over one family of invoice fixtures.',
          contentHash: hash(`suite v${n}`),
          checkHash: hash(`checks v${n}`),
          taskCount: 2,
          validCount: n === 1 ? 2 : 1,
          loadedAt: n === 1 ? T_V1 : T_V2,
        })),
      )
      .returning();
    const totalDue = {
      key: 'total_due',
      versionNumber: 1,
      introducedInSuiteId: v1!.id,
      position: 0,
      summary: 'Total amount still due',
      prompt: 'What is the total still due?\nReply with a fenced JSON block.\n',
      taskYaml: TOTAL_DUE_YAML,
      limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
      reference: { total_due: 48213.65 },
      verification: TOTAL_DUE_VERIFICATION,
      selfCheck: TOTAL_DUE_CHECK,
      valid: true,
      contentHash: hash('total_due v1'),
    };
    const lateFees = {
      key: 'late_fees',
      position: 1,
      summary: 'Late fees owed',
      prompt: 'How much in late fees is owed?\nReply with a fenced JSON block.\n',
      taskYaml: LATE_FEES_YAML,
      limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file', 'terminal'] },
      reference: { late_fees_total: 212.4 },
      verification: LATE_FEES_VERIFICATION,
    };
    const rows = await tx
      .insert(tasks)
      .values([
        { ...totalDue, suiteId: v1!.id },
        {
          ...lateFees,
          suiteId: v1!.id,
          versionNumber: 1,
          introducedInSuiteId: v1!.id,
          selfCheck: LATE_FEES_V1_CHECK,
          valid: true,
          contentHash: hash('late_fees v1'),
        },
        { ...totalDue, suiteId: v2!.id },
        {
          ...lateFees,
          suiteId: v2!.id,
          versionNumber: 2,
          introducedInSuiteId: v2!.id,
          selfCheck: LATE_FEES_V2_CHECK,
          valid: false,
          invalidReason:
            'Its verifier script check_late_fees.py printed no result line on the reference answer.',
          contentHash: hash('late_fees v2'),
        },
      ])
      .returning({ id: tasks.id, suiteId: tasks.suiteId, key: tasks.key });
    const id = (suiteId: string, key: string) =>
      rows.find((r) => r.suiteId === suiteId && r.key === key)!.id;
    const ids = {
      v1: { id: v1!.id, totalDue: id(v1!.id, 'total_due'), lateFees: id(v1!.id, 'late_fees') },
      v2: { id: v2!.id, totalDue: id(v2!.id, 'total_due'), lateFees: id(v2!.id, 'late_fees') },
    };
    const file = (
      taskId: string,
      path: string,
      ref: { sha256: string; size: number },
      kind: 'fixture' | 'verifier' = 'fixture',
    ) => ({
      taskId,
      path,
      kind,
      sha256: ref.sha256,
      size: ref.size,
    });
    await tx
      .insert(taskFiles)
      .values([
        ...[ids.v1.totalDue, ids.v2.totalDue].flatMap((taskId) => [
          file(taskId, 'fixtures/invoices.csv', blob.invoices),
          file(taskId, 'fixtures/ledger.csv', blob.ledger),
          file(taskId, 'fixtures/docs/readme.md', blob.readme),
        ]),
        file(ids.v1.lateFees, 'fixtures/invoices.csv', blob.invoices),
        file(ids.v1.lateFees, 'fixtures/policy_terms.json', blob.policyV1),
        file(ids.v1.lateFees, 'verify/check_late_fees.py', blob.check, 'verifier'),
        file(ids.v2.lateFees, 'fixtures/invoices.csv', blob.invoices),
        file(ids.v2.lateFees, 'fixtures/policy_terms.json', blob.policyV2),
        file(ids.v2.lateFees, 'verify/check_late_fees.py', blob.check, 'verifier'),
      ]);
    await tx.insert(suiteSources).values({
      path: 'invoices-v1',
      name: 'invoices-v1',
      currentSuiteId: v2!.id,
      lastAttemptedAt: T_V2,
      lastOutcome: 'created',
      lastChanges: {
        added: [],
        removed: [],
        changed: ['late_fees'],
        now_invalid: ['late_fees'],
        now_valid: [],
      },
    });
    return { store, ...ids, dispose: () => rm(dataDir, { recursive: true, force: true }) };
  });
}
