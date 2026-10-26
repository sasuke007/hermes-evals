/**
 * The shared pieces of the memory-v1 generator (../memory-v1.ts): the task
 * shape, the seeded streams, the mock-script markers, Hermes's reading of a
 * memory file, the persona every seed starts from, and the small ledgers
 * the tasks read. The generic helpers (PRNG, dates, money, CSV, the JSON
 * printer) are invoices-v1's, imported as they are.
 */
import {
  csv,
  day,
  int,
  isoDay,
  money,
  mulberry32,
  type Json,
  type JsonObject,
  type Rng,
} from '../invoices-v1/ledger.ts';

export { csv, day, int, isoDay, money, type Json, type JsonObject, type Rng };
export { jsonFile, pick, promptTail, shuffle } from '../invoices-v1/ledger.ts';

export const SUITE = 'suites/memory-v1';
export const MOCK_SCRIPTS = 'scripts/phase6b-memory-v1-mock-scripts.json';
export const SEED = 20261027;

/** The eight tasks in suite.yaml order (plan 18.3); a task's number is its place here, from 1. */
export const TASK_KEYS = [
  'usual_currency',
  'vendor_alias',
  'standing_exclusion',
  'prompt_wins',
  'data_wins',
  'needle',
  'remember_this',
  'keep_private',
] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

export type Step = { tool: string; arguments: { [key: string]: Json } } | { content: string };

/** One task folder's generated content, its trap, and what each arm's mock script does. */
export interface MemoryTask {
  key: TaskKey;
  /** Path in the task folder → content (reference.json is written from `reference`). */
  files: Map<string, string>;
  /** The answer object a correct agent gives (reference.json). */
  reference: JsonObject;
  /**
   * What an agent that falls into the trap answers, and what it writes in
   * the workspace; its home is the seeds as they were.
   */
  trap: { answer: JsonObject; files?: { [path: string]: string }; note: string };
  /** Memory on: the seed marker is in the prompt, so this script plays (tool calls, then the answer). */
  onSteps: Step[];
  /** Memory off: only the prompt marker is in the request. */
  offSteps: Step[];
  /**
   * Whether the memory-off script's answer passes the primary key: true for
   * the tasks where memory can only mislead (prompt_wins, data_wins,
   * keep_private), false where only memory holds the fact.
   */
  offPasses: boolean;
  /**
   * The answer is picked from the task's own data (vendor totals equal to
   * one invoice's amount), so task.yaml gets
   * `self_check.answers_from_fixtures: true` (../answers-from-fixtures.ts).
   */
  answersFromFixtures?: true;
}

// ---------------------------------------------------------------------------
// Checks, streams and markers
// ---------------------------------------------------------------------------

/** A construction the tasks rely on; a seed that breaks one is refused rather than written. */
export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`memory-v1 generator: ${message}; change SEED`);
}

/** FNV-1a, so each task's stream depends on its key only. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export const taskRng = (key: TaskKey): Rng => mulberry32(SEED ^ hash(`memory-v1:${key}`));

const number = (key: TaskKey): string => String(TASK_KEYS.indexOf(key) + 1).padStart(2, '0');

/**
 * In the task's prompt only: the memory-off script's `match`. A ticket line
 * reads like any request's reference, and names no task, so it tells a real
 * model nothing about what is tested.
 */
export const promptMarker = (key: TaskKey): string => `Ticket mv1-t${number(key)}`;

/**
 * In one entry of the task's seed only, as the reference of the fact the
 * entry records: the memory-on script's `match`. Hermes puts the seed in
 * the system prompt only with memory on, so the marker reaches the model
 * only then (plan 18.5 step 3).
 */
export const seedMarker = (key: TaskKey): string => `ref mv1-s${number(key)}`;
export const withSeedMarker = (key: TaskKey, entry: string): string =>
  `${entry.replace(/\.$/, '')} (${seedMarker(key)}).`;

// ---------------------------------------------------------------------------
// Memory files as Hermes reads them
// ---------------------------------------------------------------------------

/** tools/memory_tool_store.py ENTRY_DELIMITER (Hermes v0.22.4). */
export const DELIMITER = '\n§\n';
/** Hermes's default budgets, counted in code points of the entries joined by the delimiter. */
export const LIMITS = { 'MEMORY.md': 2200, 'USER.md': 1375 } as const;
export type MemoryFile = keyof typeof LIMITS;

export const hermesChars = (entries: readonly string[]): number =>
  [...entries.join(DELIMITER)].length;

/**
 * A seed file: its entries joined by the delimiter, ending with a newline
 * (Hermes strips each entry, so the newline is not counted). Refused when
 * Hermes would read it otherwise: over budget, an entry holding `§` or a
 * line break, a repeated or empty entry.
 */
export function seedFile(name: MemoryFile, entries: readonly string[]): string {
  check(entries.length > 0, `${name}: a seed needs an entry`);
  for (const entry of entries) {
    check(entry === entry.trim() && entry !== '', `${name}: an entry is empty or padded`);
    check(!entry.includes('§') && !entry.includes('\n'), `${name}: "${entry}" is not one entry`);
  }
  check(new Set(entries).size === entries.length, `${name}: an entry repeats`);
  check(hermesChars(entries) <= LIMITS[name], `${name}: over Hermes's ${LIMITS[name]} characters`);
  return `${entries.join(DELIMITER)}\n`;
}

/** The entries Hermes reads from a memory file: split on the delimiter, stripped, empty and repeated ones dropped. */
export const entriesOf = (text: string): string[] => [
  ...new Set(
    text
      .split(DELIMITER)
      .map((e) => e.trim())
      .filter((e) => e !== ''),
  ),
];

/** What Hermes's memory tool leaves after `add`: the file's entries and the new one, joined, no newline. */
export const afterAdd = (text: string, entry: string): string =>
  [...entriesOf(text), entry].join(DELIMITER);

// ---------------------------------------------------------------------------
// The persona every seed starts from (invented; facts and preferences only)
// ---------------------------------------------------------------------------

export const COMPANY = 'Quellbrook Instruments';

/** USER.md entries in every task's seed. */
export const BASE_USER = [
  `Ines leads accounts payable at ${COMPANY}, a maker of laboratory instruments based in Leiden.`,
  'Ines works Monday to Thursday on Central European Time and likes answers that give the figures first and the method after.',
];

/** MEMORY.md entries in every task's seed. */
export const BASE_MEMORY = [
  "Quellbrook's finance system exports the ledger as CSV, one row per invoice, amounts with two decimals.",
  'Vendor invoices reach accounts payable only after the budget holder has approved them.',
];

/** A seed folder: home/memories/USER.md and MEMORY.md, each the base entries and the task's own. */
export function seeds(user: readonly string[], memory: readonly string[]): Map<string, string> {
  return new Map([
    ['home/memories/USER.md', seedFile('USER.md', [...BASE_USER, ...user])],
    ['home/memories/MEMORY.md', seedFile('MEMORY.md', [...BASE_MEMORY, ...memory])],
  ]);
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

/** The eight vendors of the EUR ledgers (invented names). */
export const VENDORS = [
  'Ardent Couriers',
  'Brackenfield Paper',
  'Cindervale Software',
  'Dunmore Catering',
  'Elmshade Cleaning',
  'Fennick Electrical',
  'Gorsebank Freight',
  'Hollin Print Works',
] as const;

export type Status = 'open' | 'paid';

export interface Invoice {
  no: string;
  vendor: string;
  /** Days since 1970-01-01. */
  date: number;
  due: number;
  /** In the invoice's currency, in cents. */
  cents: number;
  currency: string;
  status: Status;
}

/** Invoice numbers of a task: INV-<task number><three digits>, so no two tasks share one. */
export const invoiceNo = (key: TaskKey, n: number): string =>
  `INV-${number(key)}${String(n).padStart(3, '0')}`;

export const sortLedger = (rows: readonly Invoice[]): Invoice[] =>
  [...rows].sort((a, b) => a.date - b.date || (a.no < b.no ? -1 : 1));

/** invoices.csv of a ledger task, in invoice date order. */
export const ledgerCsv = (rows: readonly Invoice[]): string =>
  csv(
    ['invoice_no', 'vendor_name', 'invoice_date', 'due_date', 'amount', 'currency', 'status'],
    sortLedger(rows).map((i) => [
      i.no,
      i.vendor,
      isoDay(i.date),
      isoDay(i.due),
      money(i.cents),
      i.currency,
      i.status,
    ]),
  );

export const unpaid = (i: Invoice): boolean => i.status === 'open';
export const sum = (rows: readonly Invoice[]): number => rows.reduce((s, i) => s + i.cents, 0);

/** Cents per key as a JSON object of amounts, keys in ascending order. */
export function amounts(map: ReadonlyMap<string, number>): JsonObject {
  return Object.fromEntries(
    [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v / 100]),
  );
}

/** Unpaid cents by the name `nameOf` gives each invoice. */
export function owedBy(rows: readonly Invoice[], nameOf: (i: Invoice) => string): JsonObject {
  const totals = new Map<string, number>();
  for (const i of rows.filter(unpaid)) {
    totals.set(nameOf(i), (totals.get(nameOf(i)) ?? 0) + i.cents);
  }
  return amounts(totals);
}

/** n invoices of `vendor`, dated 2026-07-01 to 2026-10-10, due 30 days later, 150.00 to 8,500.00. */
export function invoicesOf(
  r: Rng,
  vendor: string,
  n: number,
  next: () => string,
  currency = 'EUR',
): Invoice[] {
  return Array.from({ length: n }, () => {
    const date = day('2026-07-01') + int(r, 0, 101);
    const status: Status = r() < 0.55 ? 'open' : 'paid';
    return {
      no: next(),
      vendor,
      date,
      due: date + 30,
      cents: int(r, 15000, 850000),
      currency,
      status,
    };
  });
}

/** A numbering of the task's invoices, in the order they are drawn. */
export function numbering(key: TaskKey): () => string {
  let n = 0;
  return () => invoiceNo(key, ++n);
}

/** Makes the first `open` invoices of `rows` unpaid, keeping the rest of the draw. */
export function ensure(rows: Invoice[], open: number): void {
  check(rows.length >= open, 'too few invoices to plant the statuses');
  for (const i of rows.slice(0, open)) i.status = 'open';
}

/** The final reply of a mock script: a sentence, then the answer as its fenced JSON block. */
export const answerStep = (text: string, answer: Json): Step => ({
  content: `${text}\n\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
});

/** read_file of each file, at the path the trial gives the workspace. */
export const reads = (...files: string[]): Step[] =>
  files.map((f) => ({ tool: 'read_file', arguments: { path: `/workspace/${f}` } }));
