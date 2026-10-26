/**
 * Suite fixtures: the `invoices-v1` suite and its 12 tasks (UI design brief,
 * section 7; SuiteList, SuiteDetail and TaskDetail artboards).
 *
 * This file is at the bottom of the fixture import graph, so it also holds the
 * helpers the other fixture files share (timestamps, hashes, ids).
 *
 * Scenarios handled here (see scenarios.ts): invalid-task, reverted,
 * newer-version, reload-failed, empty.
 */
import type { JsonValue, ScorerType } from '@hermes-evals/shared';
import type {
  SelfCheckFailureView,
  SuiteChangeSet,
  SuiteDetail,
  SuiteHistoryEntry,
  SuiteListRow,
  SuiteReloadResult,
  SuiteVersionOption,
  SuiteVersionRef,
  TablePreview,
  TaskDetail,
  TaskDiff,
  TaskFixtureFile,
  TaskSelfCheckView,
  TaskVersionEntry,
  TextDiffLine,
  VerificationEntryView,
} from '@/api/types/suites';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/**
 * A fixture timestamp in October 2026. Fixture timestamps carry no offset, so
 * they read as the design's clock times in any time zone; live data has one.
 */
export function at(day: number, hms: string): string {
  const time = hms.length === 5 ? `${hms}:00` : hms;
  return `2026-10-${String(day).padStart(2, '0')}T${time}`;
}

/** Adds seconds to a fixture timestamp (no offset in, none out). */
export function addSeconds(iso: string, seconds: number): string {
  const d = new Date(`${iso}Z`);
  d.setUTCSeconds(d.getUTCSeconds() + seconds);
  return d.toISOString().slice(0, 19);
}

/** The design's string hash, used to derive stable per-run numbers. */
export function designHash(s: string, mod = 9973): number {
  let h = 0;
  for (let j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) % mod;
  return h;
}

/** A stable 64-character sha256-looking hex string with the prefix and suffix the design shows. */
export function sha(seed: string, prefix = '', suffix = ''): string {
  let state = designHash(seed, 2147483647) || 1;
  let body = '';
  while (prefix.length + body.length + suffix.length < 64) {
    state = (state * 48271) % 2147483647;
    body += (state % 16).toString(16);
  }
  return prefix + body + suffix;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A stable ULID-looking id: `<prefix>_01J…`. */
export function ulid(prefix: string, seed: string, length = 10): string {
  let state = designHash(seed, 2147483647) || 7;
  let out = '01J';
  while (out.length < length) {
    state = (state * 16807) % 2147483647;
    out += CROCKFORD[state % 32];
  }
  return `${prefix}_${out}`;
}

/** Rounds to `digits` decimals without floating-point noise. */
export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function emptyChanges(): SuiteChangeSet {
  return { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] };
}

// ---------------------------------------------------------------------------
// Ids and versions
// ---------------------------------------------------------------------------

export const SUITE_NAME = 'invoices-v1';
export const SUITE_PATH = './suites/invoices-v1';
export const SUITE_V1_ID = 'suite_01JAT3F9C2A1';
export const SUITE_V2_ID = 'suite_01JBF7D20E4B';

export const SUITE_V1_HASH = sha('suite-v1', '3f9c2a1');
/** v2 after Flow D: late_fees changed and failed its self-check. */
export const SUITE_V2_HASH = sha('suite-v2', '7d20e4b');
/** v2 in the newer-version scenario: total_due changed and is still valid. */
export const SUITE_V2_TOTAL_DUE_HASH = sha('suite-v2-total-due', 'a41c9e0');

export const SUITE_DESCRIPTION =
  'Accounts-payable questions over one family of invoice fixtures. Each task has a trap that a careful method avoids.';

export const SUITE_V1_REF: SuiteVersionRef = {
  suiteId: SUITE_V1_ID,
  name: SUITE_NAME,
  versionNumber: 1,
  versionLabel: '0.1',
  contentHash: SUITE_V1_HASH,
};

const V1_CREATED_AT = at(21, '15:31:12');
const V1_LAST_LOAD_AT = at(23, '09:12:04');
const V2_LOADED_AT = at(23, '15:41:07');
const REVERTED_AT = at(23, '16:05:31');

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface VerificationSeed {
  key: string;
  type: ScorerType;
  primary?: boolean;
  params: Record<string, JsonValue>;
  sentence: string;
}

interface FixtureSeed {
  path: string;
  typeLabel: string;
  sizeBytes: number;
  sha256: string;
}

interface TaskSeed {
  key: string;
  summary: string;
  prompt: string;
  fixtures: FixtureSeed[];
  verification: VerificationSeed[];
  reference: JsonValue;
  toolsetsNeeded: string[];
  verifier?: { path: string; source: string };
}

const INVOICES_CSV: FixtureSeed = {
  path: 'invoices.csv',
  typeLabel: 'CSV · 48 rows · 8 columns',
  sizeBytes: 4198,
  sha256: sha('invoices.csv', '51e0a9c3', '0d17'),
};

const file = (path: string, typeLabel: string, sizeBytes: number): FixtureSeed => ({
  path,
  typeLabel,
  sizeBytes,
  sha256: sha(path),
});

/** The first five rows of invoices.csv, as the TaskDetail preview shows them. */
export const INVOICES_PREVIEW: TablePreview = {
  columns: [
    'invoice_no',
    'vendor_name',
    'invoice_date',
    'due_date',
    'amount',
    'currency',
    'po_number',
    'status',
  ],
  rows: [
    [
      'INV-0981',
      'Brightline Freight',
      '2026-08-02',
      '2026-09-01',
      '1625.00',
      'EUR',
      'PO-5518',
      'open',
    ],
    [
      'INV-0988',
      'Kestrel Office Supply',
      '2026-08-04',
      '2026-09-03',
      '312.40',
      'EUR',
      'PO-5530',
      'open',
    ],
    [
      'INV-0994',
      'Norvale Logistics',
      '2026-08-05',
      '2026-09-04',
      '2275.00',
      'EUR',
      'PO-5534',
      'open',
    ],
    [
      'INV-1003',
      'Brightline Freight',
      '2026-08-09',
      '2026-09-08',
      '960.00',
      'EUR',
      'PO-5540',
      'paid',
    ],
    ['INV-1011', 'Halden Print Co.', '2026-08-11', '2026-09-10', '148.90', 'EUR', '', 'open'],
  ],
  totalRows: 48,
};

const answerJson = (path: string, extra: string, params: Record<string, JsonValue> = {}) => ({
  key: 'answer',
  type: 'json_match' as const,
  primary: true,
  params: { path, ...params, pass_at: 1.0 },
  sentence: `json_match on ${path}${extra}, pass at 1.0`,
});

const answerNumeric = (path: string) => ({
  key: 'answer',
  type: 'numeric_tolerance' as const,
  primary: true,
  params: { path, abs: 0.01 },
  sentence: `numeric_tolerance on ${path}, within ±0.01 of the reference`,
});

const FENCE = '```';

const LATE_FEES_VERIFIER = `"""Check late_fees: recompute each fee from policy_terms.json and compare."""
import argparse, json, sys

parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home")
args = parser.parse_args()

answer = json.load(open(args.answer))
policy = json.load(open(f"{args.workspace}/policy_terms.json"))
rate = policy["late_fee_rate"]
grace = policy["grace_days"]
expected = round(sum(fee for fee in answer.get("fees", {}).values()), 2)
score = 1 if abs(expected - answer.get("late_fees_total", -1)) <= 0.01 else 0
print(json.dumps({"key": "check", "score": score, "comment": f"rate {rate}, grace {grace} days"}))
`;

const SUMMARY_VERIFIER = `"""Check summary_file: one row per vendor, outstanding amounts match."""
import argparse, csv, json

parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home")
args = parser.parse_args()

rows = list(csv.DictReader(open(f"{args.workspace}/summary.csv")))
vendors = {r["vendor"] for r in rows}
score = 1 if len(rows) == len(vendors) == 5 else 0
print(json.dumps({"key": "answer", "score": score, "comment": f"{len(rows)} rows, {len(vendors)} vendors"}))
`;

const TASK_SEEDS: TaskSeed[] = [
  {
    key: 'total_due',
    summary: 'Sum the amount due across all open invoices',
    prompt: `Your working directory contains \`invoices.csv\`, our accounts-payable ledger. Every amount is in EUR.

An invoice is settled only when its \`status\` is \`paid\`. Every other invoice is still due, including \`disputed\` ones.

What is the total amount still due, in EUR, rounded to the cent?

End your reply with your answer as a fenced JSON block, exactly in this shape:

${FENCE}json
{ "total_due": 0.0 }
${FENCE}`,
    fixtures: [INVOICES_CSV],
    verification: [answerNumeric('total_due')],
    reference: { total_due: 48213.65 },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'overdue_list',
    summary: 'List invoices past due as of 30 Sep 2026',
    prompt: `Your working directory contains \`invoices.csv\`, an export of vendor invoices.

List every invoice that is past its due date as of 30 Sep 2026 and is not \`paid\`.

End your answer with a fenced JSON block of the form \`{"overdue": ["INV-…", …]}\`, ordered by invoice number.`,
    fixtures: [INVOICES_CSV],
    verification: [answerJson('overdue', ', unordered', { unordered: true })],
    reference: {
      overdue: ['INV-0981', 'INV-0988', 'INV-0994', 'INV-1011', 'INV-1031', 'INV-1127'],
    },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'dup_invoices',
    summary: 'Find invoices billed twice by the same vendor',
    prompt: `Your working directory contains \`invoices.csv\`, an export of open and paid vendor invoices for August and September 2026.

Some vendors have billed the same goods twice under different invoice numbers. Find every pair of invoices that are duplicates of each other.

End your answer with a fenced JSON block of the form \`{"duplicates": [["INV-…", "INV-…"], …]}\`, one inner list per pair, ordered by the first invoice number.`,
    fixtures: [INVOICES_CSV],
    verification: [
      {
        key: 'answer',
        type: 'json_match',
        primary: true,
        params: { path: 'duplicates', unordered: true, inner_unordered: true, pass_at: 1.0 },
        sentence: 'json_match on duplicates, unordered, pass at 1.0',
      },
      {
        key: 'reads_fixture',
        type: 'trajectory_match',
        params: { tool: 'read_file', args: { path: 'invoices.csv' }, min_calls: 1 },
        sentence: 'trajectory_match: calls read_file on invoices.csv at least once',
      },
    ],
    reference: {
      duplicates: [
        ['INV-0988', 'INV-1131'],
        ['INV-1042', 'INV-1107'],
      ],
    },
    toolsetsNeeded: ['file'],
  },
  {
    key: 'vat_split',
    summary: 'Split totals into net and VAT per rate band',
    prompt: `Your working directory contains \`invoices.csv\` and \`vat_rates.json\`. Amounts in the ledger include VAT.

For each VAT rate band in \`vat_rates.json\`, report the net amount and the VAT amount of the open invoices in that band, and the total VAT.

End your answer with a fenced JSON block of the form \`{"bands": [{"rate": 0.21, "net": 0.0, "vat": 0.0}, …], "total_vat": 0.0}\`.`,
    fixtures: [INVOICES_CSV, file('vat_rates.json', 'JSON · 3 bands', 214)],
    verification: [
      answerJson('bands', ', unordered', { unordered: true }),
      {
        key: 'totals',
        type: 'numeric_tolerance',
        params: { path: 'total_vat', abs: 0.01 },
        sentence: 'numeric_tolerance on total_vat, within ±0.01 of the reference',
      },
    ],
    reference: {
      bands: [
        { rate: 0.21, net: 31840.5, vat: 6686.51 },
        { rate: 0.09, net: 7312.4, vat: 658.12 },
        { rate: 0, net: 1716.12, vat: 0 },
      ],
      total_vat: 7344.63,
    },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'credit_notes',
    summary: 'Apply credit notes and report net balances per invoice',
    prompt: `Your working directory contains \`invoices.csv\` and \`credit_notes.csv\`. Each credit note references the invoice it reduces.

Apply every credit note to its invoice and report the net balance of each open invoice that has at least one credit note.

End your answer with a fenced JSON block of the form \`{"balances": {"INV-…": 0.0, …}}\`.`,
    fixtures: [INVOICES_CSV, file('credit_notes.csv', 'CSV · 14 rows · 4 columns', 612)],
    verification: [
      answerJson('balances', ''),
      {
        key: 'method',
        type: 'llm_judge',
        params: { rubric: 'credit_method.md', pass_at: 0.7 },
        sentence: 'llm_judge with rubric credit_method.md, pass at score ≥ 0.7',
      },
    ],
    reference: {
      balances: {
        'INV-1031': 310.0,
        'INV-1054': 0,
        'INV-1066': 1412.5,
        'INV-1088': 2480.0,
      },
    },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'currency_mix',
    summary: 'Convert mixed-currency invoices to EUR using rates.json',
    prompt: `Your working directory contains \`invoices.csv\`, whose amounts are in EUR, USD and GBP, and \`rates.json\` with the conversion rates to use.

What is the total of all open invoices in EUR, rounded to the cent?

End your answer with a fenced JSON block of the form \`{"total_eur": 0.0}\`.`,
    fixtures: [INVOICES_CSV, file('rates.json', 'JSON · 2 rates', 96)],
    verification: [answerNumeric('total_eur')],
    reference: { total_eur: 38955.1 },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'missing_po',
    summary: 'List invoices with no matching purchase order',
    prompt: `Your working directory contains \`invoices.csv\` and \`purchase_orders.csv\`.

List the invoice numbers whose \`po_number\` is empty or does not appear in \`purchase_orders.csv\`, comma-separated, in invoice-number order.

End your answer with a fenced JSON block of the form \`{"missing_po": "INV-…, INV-…"}\`.`,
    fixtures: [INVOICES_CSV, file('purchase_orders.csv', 'CSV · 52 rows · 3 columns', 1840)],
    verification: [
      {
        key: 'answer',
        type: 'exact_match',
        primary: true,
        params: { path: 'missing_po', trim: true, case_sensitive: true },
        sentence: 'exact_match on missing_po, whitespace trimmed, case-sensitive',
      },
    ],
    reference: { missing_po: 'INV-1011, INV-1076, INV-1140' },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'late_fees',
    summary: 'Compute late fees under the vendor-policy-v3 terms',
    prompt: `Your working directory contains \`invoices.csv\`, \`payments.csv\` and \`policy_terms.json\`, the late-fee terms of vendor policy v3.

Compute the late fee owed on each invoice paid after its due date, and the total.

End your answer with a fenced JSON block of the form \`{"fees": {"INV-…": 0.0, …}, "late_fees_total": 0.0}\`.`,
    fixtures: [
      INVOICES_CSV,
      file('policy_terms.json', 'JSON · 4 keys', 188),
      file('payments.csv', 'CSV · 31 rows · 3 columns', 904),
    ],
    verification: [
      answerNumeric('late_fees_total'),
      {
        key: 'check',
        type: 'verifier_script',
        params: { script: 'check_late_fees.py', timeout_s: 30, pass_at: 1.0 },
        sentence: 'verifier_script check_late_fees.py returns score ≥ 1.0, timeout 30 s',
      },
    ],
    reference: { fees: { 'INV-1031': 8.2, 'INV-1049': 22.75 }, late_fees_total: 30.95 },
    toolsetsNeeded: ['file', 'terminal'],
    verifier: { path: 'verify/check_late_fees.py', source: LATE_FEES_VERIFIER },
  },
  {
    key: 'per_vendor',
    summary: 'Total the outstanding amount per vendor',
    prompt: `Your working directory contains \`invoices.csv\`.

For each vendor, total the amount of its invoices that are not \`paid\`.

End your answer with a fenced JSON block of the form \`{"per_vendor": {"<vendor>": 0.0, …}}\`.`,
    fixtures: [INVOICES_CSV],
    verification: [
      answerJson('per_vendor', ''),
      {
        key: 'uses_db',
        type: 'trajectory_match',
        params: { tool: 'invoice-db.list_invoices', min_calls: 1 },
        sentence: 'trajectory_match: calls invoice-db.list_invoices at least once',
      },
    ],
    reference: {
      per_vendor: {
        'Brightline Freight': 6215.0,
        'Kestrel Office Supply': 1486.65,
        'Halden Print Co.': 558.9,
        'Norvale Logistics': 3465.0,
        'Orbis Facilities': 2120.4,
      },
    },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'disputed',
    summary: 'Exclude disputed invoices from the payable total',
    prompt: `Your working directory contains \`invoices.csv\` and \`disputes.csv\`.

What is the payable total of the open invoices, leaving out every invoice under dispute? Explain which rule you used to exclude invoices.

End your answer with a fenced JSON block of the form \`{"payable": 0.0, "excluded": ["INV-…", …]}\`.`,
    fixtures: [INVOICES_CSV, file('disputes.csv', 'CSV · 3 rows · 3 columns', 168)],
    verification: [
      answerJson('payable', ''),
      {
        key: 'rationale',
        type: 'llm_judge',
        params: { rubric: 'dispute_rationale.md', pass_at: 0.7 },
        sentence: 'llm_judge with rubric dispute_rationale.md, pass at score ≥ 0.7',
      },
    ],
    reference: { payable: 41876.15, excluded: ['INV-1024', 'INV-1119'] },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'partial_pay',
    summary: 'Reconcile partial payments against invoice balances',
    prompt: `Your working directory contains \`invoices.csv\` and \`payments.csv\`. Some invoices were paid in several instalments.

Report the remaining balance of every invoice with at least one payment.

End your answer with a fenced JSON block of the form \`{"balances": {"INV-…": 0.0, …}}\`.`,
    fixtures: [INVOICES_CSV, file('payments.csv', 'CSV · 31 rows · 3 columns', 904)],
    verification: [answerJson('balances', ', unordered', { unordered: true })],
    reference: { balances: { 'INV-1003': 0, 'INV-1066': 706.25, 'INV-1102': 1180.0 } },
    toolsetsNeeded: ['file', 'terminal'],
  },
  {
    key: 'summary_file',
    summary: 'Write summary.csv with one row per vendor',
    prompt: `Your working directory contains \`invoices.csv\`.

Write \`summary.csv\` in the working directory with the columns \`vendor\` and \`outstanding\`: one row per vendor, with the total amount of its invoices that are not \`paid\`.

End your answer with a fenced JSON block of the form \`{"rows": 0}\` giving the number of rows you wrote.`,
    fixtures: [INVOICES_CSV],
    verification: [
      {
        key: 'summary',
        type: 'file_check',
        params: {
          path: 'summary.csv',
          must_exist: true,
          format: 'csv',
          columns: ['vendor', 'outstanding'],
          row_count: 5,
        },
        sentence:
          'file_check: summary.csv exists with columns vendor, outstanding; 1 row per vendor',
      },
      {
        key: 'answer',
        type: 'verifier_script',
        primary: true,
        params: { script: 'check_summary.py', timeout_s: 30, pass_at: 1.0 },
        sentence: 'verifier_script check_summary.py returns score ≥ 1.0, timeout 30 s',
      },
    ],
    reference: { rows: 5 },
    toolsetsNeeded: ['file', 'terminal'],
    verifier: { path: 'verify/check_summary.py', source: SUMMARY_VERIFIER },
  },
];

/** Task keys in suite order. */
export const TASK_KEYS = TASK_SEEDS.map((t) => t.key);

export function taskSeed(key: string): TaskSeed {
  const seed = TASK_SEEDS.find((t) => t.key === key);
  if (!seed) throw new Error(`Unknown task ${key}`);
  return seed;
}

/** The primary verification key of a task (`answer` for every task in invoices-v1). */
export function primaryKey(key: string): string {
  return taskSeed(key).verification.find((v) => v.primary)?.key ?? 'answer';
}

/** All verification entries of a task, in task.yaml order, without the rendered YAML. */
export function taskVerification(key: string): VerificationSeed[] {
  return taskSeed(key).verification;
}

function yamlValue(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => yamlValue(v)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${yamlValue(v)}`)
      .join(', ')} }`;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}.0` : String(value);
  return String(value);
}

function verificationYaml(v: VerificationSeed): string {
  const lines = [`- key: ${v.key}`, `  type: ${v.type}`];
  if (v.primary) lines.push('  primary: true');
  lines.push('  params:');
  for (const [k, value] of Object.entries(v.params)) {
    const shown =
      typeof value === 'number' && k !== 'pass_at' && Number.isInteger(value)
        ? String(value)
        : yamlValue(value);
    lines.push(`    ${k}: ${shown}`);
  }
  return lines.join('\n');
}

function verificationView(v: VerificationSeed): VerificationEntryView {
  return {
    key: v.key,
    type: v.type,
    primary: v.primary ?? false,
    params: v.params,
    yaml: verificationYaml(v),
    sentence: v.sentence,
  };
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

const LATE_FEES_FAILURE: SelfCheckFailureView = {
  key: 'check',
  type: 'verifier_script',
  title:
    'verifier_script check_late_fees.py printed no result line on the reference answer · score status error',
  status: 'error',
  ranAt: V2_LOADED_AT,
  durationMs: 300,
  previousRun: { at: V1_LAST_LOAD_AT, status: 'passed' },
  transcript: `$ python3 verify/check_late_fees.py --answer reference.json --workspace fixtures/ --home home/
Traceback (most recent call last):
  File "verify/check_late_fees.py", line 12, in <module>
    rate = policy["late_fee_rate"]
KeyError: 'late_fee_rate'
expected on stdout: one JSON line {"key": "check", "score": …, "comment": "…"}
got: no line`,
  explanation:
    'The fixture policy_terms.json changed since the last load, and its keys no longer match what the script reads. Fix one or the other in ./suites/invoices-v1/late_fees/, then reload.',
};

/** Reason shown on New experiment for a task that cannot be selected. */
export const LATE_FEES_INVALID_REASON =
  'Its verifier script check_late_fees.py printed no result line on the reference answer during the self-check at 15:41 (score status error). A task whose check fails on its own reference would score every run wrong.';

function selfCheckFor(seed: TaskSeed, ranAt: string, invalid: boolean): TaskSelfCheckView {
  const results = seed.verification.map((v) => {
    if (invalid && v.type === 'verifier_script') {
      return {
        key: v.key,
        type: v.type,
        status: 'error' as const,
        score: null,
        note: 'printed no result line on the reference answer',
      };
    }
    if (v.type === 'trajectory_match') {
      return {
        key: v.key,
        type: v.type,
        status: 'skipped' as const,
        score: null,
        note: 'definition valid · needs a trajectory, so it is not scored against the reference',
      };
    }
    if (v.type === 'llm_judge') {
      return {
        key: v.key,
        type: v.type,
        status: 'skipped' as const,
        score: null,
        note: 'definition valid · never called at load',
      };
    }
    if (v.type === 'file_check') {
      return {
        key: v.key,
        type: v.type,
        status: 'passed' as const,
        score: 1,
        note: 'passes on the expected workspace; fails on the untouched fixtures, as it should',
      };
    }
    return {
      key: v.key,
      type: v.type,
      status: 'passed' as const,
      score: 1,
      note: 'scored against the reference answer',
    };
  });
  return {
    status: invalid ? 'error' : 'passed',
    ranAt,
    trigger: 'suite reload',
    results,
  };
}

// ---------------------------------------------------------------------------
// Suite states per scenario
// ---------------------------------------------------------------------------

/** Which suite state a scenario shows. */
export type SuiteState = 'v1' | 'invalid-task' | 'reverted' | 'newer-version' | 'reload-failed';

interface SuiteVersionSeed {
  id: string;
  versionNumber: number;
  hash: string;
  loadedAt: string;
  /** Task keys whose version is 2 in this suite version. */
  changedTasks: string[];
  invalidTasks: string[];
}

const V1_SEED: SuiteVersionSeed = {
  id: SUITE_V1_ID,
  versionNumber: 1,
  hash: SUITE_V1_HASH,
  loadedAt: V1_CREATED_AT,
  changedTasks: [],
  invalidTasks: [],
};

const V2_LATE_FEES_SEED: SuiteVersionSeed = {
  id: SUITE_V2_ID,
  versionNumber: 2,
  hash: SUITE_V2_HASH,
  loadedAt: V2_LOADED_AT,
  changedTasks: ['late_fees'],
  invalidTasks: ['late_fees'],
};

const V2_TOTAL_DUE_SEED: SuiteVersionSeed = {
  id: SUITE_V2_ID,
  versionNumber: 2,
  hash: SUITE_V2_TOTAL_DUE_HASH,
  loadedAt: V2_LOADED_AT,
  changedTasks: ['total_due'],
  invalidTasks: [],
};

function currentSeed(state: SuiteState): SuiteVersionSeed {
  if (state === 'invalid-task') return V2_LATE_FEES_SEED;
  if (state === 'newer-version') return V2_TOTAL_DUE_SEED;
  return V1_SEED;
}

function seedFor(state: SuiteState, suiteId: string): SuiteVersionSeed | null {
  if (suiteId === SUITE_V1_ID) return V1_SEED;
  if (suiteId === SUITE_V2_ID) {
    if (state === 'invalid-task' || state === 'reverted') return V2_LATE_FEES_SEED;
    if (state === 'newer-version') return V2_TOTAL_DUE_SEED;
  }
  return null;
}

/** The newer suite version an older experiment's snapshot strip mentions, if any. */
export function newerSuiteVersion(state: SuiteState): {
  suiteId: string;
  versionNumber: number;
  changedTasks: string[];
  invalidTasks: string[];
} | null {
  if (state !== 'invalid-task' && state !== 'newer-version') return null;
  const seed = currentSeed(state);
  return {
    suiteId: seed.id,
    versionNumber: seed.versionNumber,
    changedTasks: seed.changedTasks,
    invalidTasks: seed.invalidTasks,
  };
}

function refFor(seed: SuiteVersionSeed): SuiteVersionRef {
  return {
    suiteId: seed.id,
    name: SUITE_NAME,
    versionNumber: seed.versionNumber,
    versionLabel: '0.1',
    contentHash: seed.hash,
  };
}

function lastLoad(state: SuiteState): SuiteListRow['lastLoad'] {
  if (state === 'invalid-task') {
    return {
      outcome: 'created',
      at: V2_LOADED_AT,
      changes: { ...emptyChanges(), changed: ['late_fees'], nowInvalid: ['late_fees'] },
      error: null,
      servedVersion: null,
    };
  }
  if (state === 'newer-version') {
    return {
      outcome: 'created',
      at: V2_LOADED_AT,
      changes: { ...emptyChanges(), changed: ['total_due'] },
      error: null,
      servedVersion: null,
    };
  }
  if (state === 'reverted') {
    return {
      outcome: 'reverted',
      at: REVERTED_AT,
      changes: { ...emptyChanges(), changed: ['late_fees'], nowValid: ['late_fees'] },
      error: null,
      servedVersion: null,
    };
  }
  if (state === 'reload-failed') {
    return {
      outcome: 'error',
      at: V2_LOADED_AT,
      changes: emptyChanges(),
      error: {
        file: './suites/invoices-v1/vat_split/task.yaml',
        line: 14,
        column: 9,
        message: 'mapping values are not allowed here',
        excerpt: [
          { line: 12, text: '  - key: totals', highlight: false },
          { line: 13, text: '    type: numeric_tolerance', highlight: false },
          { line: 14, text: '    params: tolerance: 0.01', highlight: true },
          { line: null, text: '                     ^', highlight: false },
        ],
      },
      servedVersion: { versionNumber: 1, contentHash: SUITE_V1_HASH, loadedAt: V1_LAST_LOAD_AT },
    };
  }
  return {
    outcome: 'unchanged',
    at: V1_LAST_LOAD_AT,
    changes: emptyChanges(),
    error: null,
    servedVersion: null,
  };
}

function taskVersion(seed: SuiteVersionSeed, key: string): number {
  return seed.changedTasks.includes(key) ? 2 : 1;
}

function versionOptions(state: SuiteState): SuiteVersionOption[] {
  const v1 = (current: boolean, reverted: boolean): SuiteVersionOption => ({
    suiteId: SUITE_V1_ID,
    versionNumber: 1,
    versionLabel: '0.1',
    contentHash: SUITE_V1_HASH,
    loadedAt: reverted ? REVERTED_AT : V1_CREATED_AT,
    current,
    reverted,
  });
  const v2 = (seed: SuiteVersionSeed, current: boolean): SuiteVersionOption => ({
    suiteId: seed.id,
    versionNumber: 2,
    versionLabel: '0.1',
    contentHash: seed.hash,
    loadedAt: seed.loadedAt,
    current,
    reverted: false,
  });
  if (state === 'invalid-task') return [v2(V2_LATE_FEES_SEED, true), v1(false, false)];
  if (state === 'newer-version') return [v2(V2_TOTAL_DUE_SEED, true), v1(false, false)];
  if (state === 'reverted') return [v1(true, true), v2(V2_LATE_FEES_SEED, false)];
  return [v1(true, false)];
}

function taskRows(seed: SuiteVersionSeed): SuiteDetail['tasks'] {
  return TASK_SEEDS.map((t) => {
    const invalid = seed.invalidTasks.includes(t.key);
    return {
      key: t.key,
      version: taskVersion(seed, t.key),
      summary: t.summary,
      verificationTypes: t.verification.map((v) => v.type),
      maxTurns: 20,
      budgetS: 300,
      fixtureCount: t.fixtures.length,
      valid: !invalid,
      selfCheckFailure: invalid ? LATE_FEES_FAILURE : null,
    };
  });
}

const VERIFICATION_TYPES_BY_USE: ScorerType[] = [
  'json_match',
  'numeric_tolerance',
  'llm_judge',
  'trajectory_match',
  'verifier_script',
  'exact_match',
  'file_check',
];

function listRow(state: SuiteState, seed: SuiteVersionSeed): SuiteListRow {
  const load = lastLoad(state);
  return {
    ...refFor(seed),
    path: SUITE_PATH,
    description: SUITE_DESCRIPTION,
    taskCount: TASK_SEEDS.length,
    validCount: TASK_SEEDS.length - seed.invalidTasks.length,
    verificationTypes: VERIFICATION_TYPES_BY_USE,
    loadedAt: load.outcome === 'error' ? V1_LAST_LOAD_AT : load.at,
    lastLoad: load,
  };
}

/** Suite list rows for a state; `none` is the empty suites directory. */
export function suiteListFixture(state: SuiteState | 'none'): SuiteListRow[] {
  if (state === 'none') return [];
  return [listRow(state, currentSeed(state))];
}

/** Suite detail for a version id in a state, or null when that version does not exist. */
export function suiteDetailFixture(state: SuiteState, suiteId: string): SuiteDetail | null {
  const seed = seedFor(state, suiteId);
  if (!seed) return null;
  const current = currentSeed(state).id === seed.id;
  const row = listRow(state, seed);
  return {
    ...row,
    loadedAt: current ? row.loadedAt : seed.loadedAt,
    validCount: TASK_SEEDS.length - seed.invalidTasks.length,
    previousContentHash: seed.versionNumber === 2 ? SUITE_V1_HASH : null,
    tasks: taskRows(seed),
    versions: versionOptions(state),
    current,
  };
}

/** The current suite version id in a state. */
export function currentSuiteId(state: SuiteState): string {
  return currentSeed(state).id;
}

/** Every version of the suite directory, newest first. Experiments are filled in by the API layer. */
export function suiteHistoryFixture(state: SuiteState): SuiteHistoryEntry[] {
  const v1Created: SuiteHistoryEntry = {
    suiteId: SUITE_V1_ID,
    versionNumber: 1,
    versionLabel: '0.1',
    contentHash: SUITE_V1_HASH,
    loadedAt: V1_CREATED_AT,
    outcome: 'created',
    changes: { ...emptyChanges(), added: [...TASK_KEYS] },
    sameFilesAs: null,
    current: state === 'v1' || state === 'reload-failed',
    experiments: [],
  };
  if (state === 'v1' || state === 'reload-failed') return [v1Created];
  const v2Seed = state === 'newer-version' ? V2_TOTAL_DUE_SEED : V2_LATE_FEES_SEED;
  const v2: SuiteHistoryEntry = {
    suiteId: v2Seed.id,
    versionNumber: 2,
    versionLabel: '0.1',
    contentHash: v2Seed.hash,
    loadedAt: v2Seed.loadedAt,
    outcome: 'created',
    changes: {
      ...emptyChanges(),
      changed: [...v2Seed.changedTasks],
      nowInvalid: [...v2Seed.invalidTasks],
    },
    sameFilesAs: null,
    current: state !== 'reverted',
    experiments: [],
  };
  if (state !== 'reverted') return [v2, { ...v1Created, current: false }];
  const revertedEntry: SuiteHistoryEntry = {
    ...v1Created,
    loadedAt: REVERTED_AT,
    outcome: 'reverted',
    changes: { ...emptyChanges(), changed: ['late_fees'], nowValid: ['late_fees'] },
    current: true,
  };
  return [revertedEntry, v2, { ...v1Created, current: false }];
}

/** Result of POST /suites/reload in a state. */
export function suiteReloadFixture(state: SuiteState): SuiteReloadResult {
  const load = lastLoad(state);
  const seed = currentSeed(state);
  const message =
    state === 'invalid-task'
      ? '1 task now invalid: late_fees'
      : state === 'newer-version'
        ? '1 task changed: total_due · all self-checks passed'
        : state === 'reverted'
          ? 'Reverted to v1 · late_fees valid again'
          : state === 'reload-failed'
            ? 'Could not reload: vat_split/task.yaml:14:9 · mapping values are not allowed here'
            : 'All self-checks passed';
  return {
    at: state === 'v1' ? at(23, '15:41:07') : load.at,
    suites: [
      {
        sourcePath: SUITE_PATH,
        name: SUITE_NAME,
        outcome: state === 'v1' ? 'unchanged' : load.outcome,
        suiteId: state === 'reload-failed' ? null : seed.id,
        versionNumber: state === 'reload-failed' ? null : seed.versionNumber,
        changes: load.changes,
        message,
        error: load.error,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Task detail, history and diff
// ---------------------------------------------------------------------------

function fixtureFiles(seed: TaskSeed, version: number): TaskFixtureFile[] {
  return seed.fixtures.map((f) => ({
    path: f.path,
    typeLabel: f.typeLabel,
    sizeBytes: f.path === 'policy_terms.json' && version === 2 ? 203 : f.sizeBytes,
    sha256:
      f.path === 'policy_terms.json' && version === 2 ? sha('policy_terms.json-v2') : f.sha256,
    preview: f.path === 'invoices.csv' ? INVOICES_PREVIEW : null,
  }));
}

/** Task detail without the "In experiments" usage and the home files, which the API layer adds. */
export function taskDetailFixture(
  state: SuiteState,
  suiteId: string,
  key: string,
): Omit<TaskDetail, 'experiments' | 'homeFiles'> | null {
  const suite = seedFor(state, suiteId);
  const seed = TASK_SEEDS.find((t) => t.key === key);
  if (!suite || !seed) return null;
  const version = taskVersion(suite, key);
  const invalid = suite.invalidTasks.includes(key);
  const ranAt = suite.versionNumber === 2 ? V2_LOADED_AT : V1_LAST_LOAD_AT;
  const reference = key === 'total_due' && version === 2 ? { total_due: 48526.05 } : seed.reference;
  return {
    suite: refFor(suite),
    key,
    version,
    introducedInSuiteVersion: version === 2 ? 2 : 1,
    summary: seed.summary,
    path: `${SUITE_PATH}/${key}/task.yaml`,
    prompt: { file: 'prompt.md', markdown: seed.prompt, characters: seed.prompt.length },
    fixtures: fixtureFiles(seed, version),
    verification: seed.verification.map(verificationView),
    reference: { file: 'reference.json', value: reference },
    verifier: seed.verifier
      ? { path: seed.verifier.path, sha256: sha(seed.verifier.path), source: seed.verifier.source }
      : null,
    selfCheck: selfCheckFor(seed, ranAt, invalid),
    limits: { maxTurns: 20, budgetS: 300, toolsetsNeeded: seed.toolsetsNeeded },
    valid: !invalid,
    selfCheckFailure: invalid ? LATE_FEES_FAILURE : null,
  };
}

/** A task's versions, newest first. */
export function taskHistoryFixture(state: SuiteState, key: string): TaskVersionEntry[] {
  const v1: TaskVersionEntry = {
    version: 1,
    contentHash: sha(`${key}-v1`),
    suiteId: SUITE_V1_ID,
    introducedInSuiteVersion: 1,
    loadedAt: V1_CREATED_AT,
    changedFiles: [],
    current: true,
  };
  const changedIn =
    state === 'newer-version'
      ? V2_TOTAL_DUE_SEED
      : state === 'invalid-task' || state === 'reverted'
        ? V2_LATE_FEES_SEED
        : null;
  if (!changedIn || !changedIn.changedTasks.includes(key)) return [v1];
  const v2: TaskVersionEntry = {
    version: 2,
    contentHash: sha(`${key}-v2`),
    suiteId: changedIn.id,
    introducedInSuiteVersion: 2,
    loadedAt: changedIn.loadedAt,
    changedFiles:
      key === 'total_due'
        ? ['prompt.md', 'reference.json', 'fixtures/invoices.csv']
        : ['fixtures/policy_terms.json'],
    current: state !== 'reverted',
  };
  return [v2, { ...v1, current: state === 'reverted' }];
}

/** The diff of a task between two suite versions (only total_due and late_fees ever change). */
export function taskDiffFixture(
  state: SuiteState,
  key: string,
  fromSuiteId: string,
  toSuiteId: string,
): TaskDiff | null {
  const from = seedFor(state, fromSuiteId);
  const to = seedFor(state, toSuiteId);
  const seed = TASK_SEEDS.find((t) => t.key === key);
  if (!from || !to || !seed) return null;
  const fromVersion = taskVersion(from, key);
  const toVersion = taskVersion(to, key);
  const base = {
    key,
    from: { suiteId: from.id, suiteVersion: from.versionNumber, taskVersion: fromVersion },
    to: { suiteId: to.id, suiteVersion: to.versionNumber, taskVersion: toVersion },
  };
  const same = (text: string) =>
    text.split('\n').map((line, i) => ({
      kind: 'same' as const,
      text: line,
      oldLine: i + 1,
      newLine: i + 1,
    }));
  const yaml = [
    `summary: ${seed.summary}`,
    'limits:',
    '  max_turns: 20',
    '  run_budget_seconds: 300',
    `  toolsets_needed: [${seed.toolsetsNeeded.join(', ')}]`,
    'verification:',
    ...seed.verification.map((v) => verificationYaml(v).replace(/^/gm, '  ')),
  ].join('\n');
  const unchangedFiles = fixtureFiles(seed, 1).map((f) => ({
    path: `fixtures/${f.path}`,
    change: 'unchanged' as const,
    before: { sizeBytes: f.sizeBytes, sha256: f.sha256 },
    after: { sizeBytes: f.sizeBytes, sha256: f.sha256 },
  }));
  if (fromVersion === toVersion) {
    return {
      ...base,
      prompt: same(seed.prompt),
      taskYaml: same(yaml),
      reference: [],
      files: unchangedFiles,
    };
  }
  if (key === 'total_due') {
    const promptLines = seed.prompt.split('\n');
    const prompt = promptLines.flatMap((line, i): TextDiffLine[] => {
      if (line.startsWith('An invoice is settled')) {
        return [
          { kind: 'removed' as const, text: line, oldLine: i + 1, newLine: null },
          {
            kind: 'added' as const,
            text: 'An invoice is settled only when its `status` is `paid`. Every other invoice is still due, including `disputed` ones and invoices paid in part.',
            oldLine: null,
            newLine: i + 1,
          },
        ];
      }
      return [{ kind: 'same' as const, text: line, oldLine: i + 1, newLine: i + 1 }];
    });
    return {
      ...base,
      prompt,
      taskYaml: same(yaml),
      reference: [{ path: 'total_due', kind: 'changed', before: 48213.65, after: 48526.05 }],
      files: [
        {
          path: 'fixtures/invoices.csv',
          change: 'changed',
          before: { sizeBytes: 4198, sha256: INVOICES_CSV.sha256 },
          after: { sizeBytes: 4276, sha256: sha('invoices.csv-v2') },
        },
      ],
    };
  }
  return {
    ...base,
    prompt: same(seed.prompt),
    taskYaml: same(yaml),
    reference: [],
    files: unchangedFiles.map((f) =>
      f.path === 'fixtures/policy_terms.json'
        ? {
            ...f,
            change: 'changed' as const,
            after: { sizeBytes: 203, sha256: sha('policy_terms.json-v2') },
          }
        : f,
    ),
  };
}

/** Preview of a fixture file: invoices.csv is tabular; other files have none. */
export function fixturePreviewFixture(path: string): TablePreview | null {
  return path === 'invoices.csv' ? INVOICES_PREVIEW : null;
}

/** The suite state the active scenarios select. */
export function suiteStateFrom(active: (name: string) => boolean): SuiteState {
  if (active('invalid-task')) return 'invalid-task';
  if (active('reverted')) return 'reverted';
  if (active('newer-version')) return 'newer-version';
  if (active('reload-failed')) return 'reload-failed';
  return 'v1';
}

/** True when the suites directory reads as empty (the `empty` scenario). */
export function noSuitesFrom(active: (name: string) => boolean): boolean {
  return active('empty');
}
