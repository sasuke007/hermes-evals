/**
 * The shared pieces of the invoices-v1 generator (../invoices-v1.ts): the
 * seeded PRNG, dates and money in integer cents, the CSV and JSON writers,
 * the eight vendors, the policy file and the base ledger every task copies.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Status = 'open' | 'paid' | 'disputed';

export interface Invoice {
  no: string;
  /** As written in the CSV: per_vendor adds trailing spaces to some. */
  vendor: string;
  /** Days since 1970-01-01. */
  date: number;
  due: number;
  /** In the invoice's currency, in cents. */
  cents: number;
  currency: string;
  po: string;
  status: Status;
}

/** One task folder's generated content, its trap, and what its baseline mock script does. */
export interface Task {
  key: string;
  /** Path in the task folder → content (reference.json is written from `reference`). */
  files: Map<string, string>;
  /** The answer object a correct agent gives (reference.json). */
  reference: JsonObject;
  /** What an agent that falls into the trap answers, and leaves in the workspace. */
  trap: { answer: JsonObject; files?: { [path: string]: string }; note: string };
  /** A phrase only this task's prompt has: the baseline mock script's `match`. */
  phrase: string;
  /** Files the baseline mock prints with `cat` before it answers. */
  reads: string[];
  /** Whether the baseline mock answers with the trap answer (else with the reference). */
  baselineTrapped: boolean;
}

export const SEED = 20261026;

// ---------------------------------------------------------------------------
// Randomness, dates and money
// ---------------------------------------------------------------------------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so each task's stream depends on its key only. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export const taskRng = (key: string): Rng => mulberry32(SEED ^ hash(key));
export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const range = (lo: number, hi: number): number[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

export function shuffle<T>(r: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const pick = <T>(r: Rng, items: readonly T[], n: number): T[] =>
  shuffle(r, items).slice(0, n);
export const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
export const isoDay = (d: number): string => new Date(d * 86_400_000).toISOString().slice(0, 10);

/**
 * num / den rounded to the nearest integer. An exact half is refused, so no
 * rounding convention (half up, half even) can decide a reference.
 */
export function divRound(num: number, den: number, what: string): number {
  const q = Math.floor(num / den);
  const rest = num - q * den;
  if (rest * 2 === den) throw new Error(`${what}: ${num}/${den} is exactly half; change SEED`);
  return rest * 2 > den ? q + 1 : q;
}

/** Cents as the CSV writes them: `4539.53`. */
export const money = (cents: number): string =>
  `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/** Cents as a JSON number: 4539.53. */
export const eur = (cents: number): number => cents / 100;

/** A construction the traps rely on; a seed that breaks one is refused rather than written. */
export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`invoices-v1 generator: ${message}; change SEED`);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Quotes only what CSV needs quoted: spaces stay bare, which is per_vendor's trap. */
const csvField = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export const csv = (header: readonly string[], rows: readonly string[][]): string =>
  [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n') + '\n';

const LEDGER_HEADER = [
  'invoice_no',
  'vendor_name',
  'invoice_date',
  'due_date',
  'amount',
  'currency',
  'po_number',
  'status',
];

export const sortLedger = (rows: readonly Invoice[]): Invoice[] =>
  [...rows].sort((a, b) => a.date - b.date || (a.no < b.no ? -1 : 1));

/** invoices.csv: the eight columns of plan 18.1, in invoice date order. */
export const ledgerCsv = (rows: readonly Invoice[]): string =>
  csv(
    LEDGER_HEADER,
    sortLedger(rows).map((i) => [
      i.no,
      i.vendor,
      isoDay(i.date),
      isoDay(i.due),
      money(i.cents),
      i.currency,
      i.po,
      i.status,
    ]),
  );

const isContainer = (v: Json): v is Json[] | JsonObject => typeof v === 'object' && v !== null;
const entriesOf = (v: Json[] | JsonObject): number =>
  Array.isArray(v) ? v.length : Object.keys(v).length;

/**
 * JSON as prettier prints it at width 100, so `prettier --check` passes on
 * every generated file: an object always one key per line; a list on one
 * line when it fits and holds no object, else one item per line, as also
 * when it holds two or more lists or objects of more than one entry each.
 * `prefix` is what shares the line: the key before, the comma after.
 */
export function json(value: Json, indent = '', prefix = 0): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const matrix = value.length > 1 && value.every((v) => isContainer(v) && entriesOf(v) > 1);
    const hasObject = value.some((v) => isContainer(v) && !Array.isArray(v));
    const flat = `[${value.map((v) => json(v, inner)).join(', ')}]`;
    const fits = !flat.includes('\n') && indent.length + prefix + flat.length <= 100;
    if (!matrix && !hasObject && fits) return flat;
    const item = (v: Json, i: number) => `${inner}${json(v, inner, i < value.length - 1 ? 1 : 0)}`;
    return `[\n${value.map(item).join(',\n')}\n${indent}]`;
  }
  if (isContainer(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, v], i) => {
      const key = `${JSON.stringify(k)}: `;
      return `${inner}${key}${json(v, inner, key.length + (i < entries.length - 1 ? 1 : 0))}`;
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

export const jsonFile = (value: Json): string => `${json(value)}\n`;

/** The closing instruction of a prompt, with the answer's shape. */
export const promptTail = (shape: string, what = 'your answer'): string =>
  `End your reply with ${what} as a fenced JSON block, exactly in this shape:\n\n\`\`\`json\n${shape}\n\`\`\`\n`;

// ---------------------------------------------------------------------------
// Vendors, the policy file and the base ledger
// ---------------------------------------------------------------------------

export const VENDORS = [
  { name: 'Acme Supplies', band: 'standard' },
  { name: 'Borealis Logistics', band: 'zero' },
  { name: 'Cobalt Print Co', band: 'standard' },
  { name: 'Delta Facilities', band: 'standard' },
  { name: 'Evergreen Catering', band: 'reduced' },
  { name: 'Fjord Software', band: 'standard' },
  { name: 'Granite Office', band: 'standard' },
  { name: 'Helios Energy', band: 'reduced' },
] as const;
export type Band = (typeof VENDORS)[number]['band'];
export const BANDS: readonly Band[] = ['standard', 'reduced', 'zero'];
/** VAT rates in basis points. */
export const VAT_BP: Record<Band, number> = { standard: 2000, reduced: 500, zero: 0 };
/** Late fee terms: 5 basis points a day once 15 days of grace are over, at most 75.00 EUR. */
export const FEE = { graceDays: 15, dailyBp: 5, capCents: 7500 };

/** policy_terms.json, the same bytes in every task that has it. */
export const POLICY: Json = {
  payment_terms_days: 30,
  late_fee: {
    applies_to: 'open invoices not paid by their due date',
    grace_days: FEE.graceDays,
    daily_rate: FEE.dailyBp / 10000,
    max_fee_eur: eur(FEE.capCents),
    rule: 'No fee while an invoice is at most grace_days past its due date. After that, the fee is daily_rate times the invoice amount for each day past the end of the grace period, capped at max_fee_eur per invoice.',
  },
  vat: {
    rates: Object.fromEntries(BANDS.map((b) => [b, VAT_BP[b] / 10000])),
    vendor_bands: Object.fromEntries(VENDORS.map((v) => [v.name, v.band])),
    note: 'Band zero is zero-rated: no VAT is charged, but its net amounts still belong in the VAT return.',
  },
};

/**
 * The 48 invoices every task starts from: six per vendor, numbered
 * INV-20260101 to INV-20260148 in random order, dated 2026-06-01 to
 * 2026-09-30 and due 30 days later, 150.00 to 6500.00 EUR, ten without a PO
 * number; invoices due before mid-August are paid more often.
 */
export function baseLedger(): Invoice[] {
  const r = mulberry32(SEED);
  const numbers = shuffle(r, range(101, 148)).map((n) => `INV-20260${n}`);
  const vendors = shuffle(
    r,
    VENDORS.flatMap((v) => Array<string>(6).fill(v.name)),
  );
  const pos = pick(r, range(1000, 9999), 48);
  const noPo = new Set(pick(r, range(0, 47), 10));
  const rows = numbers.map((no, i): Invoice => {
    const date = day('2026-06-01') + int(r, 0, 121);
    const roll = r();
    const paidBelow = date + 30 < day('2026-08-15') ? 0.7 : 0.3;
    const status: Status =
      roll < paidBelow ? 'paid' : roll < paidBelow + 0.12 ? 'disputed' : 'open';
    return {
      no,
      vendor: vendors[i]!,
      date,
      due: date + 30,
      cents: int(r, 15000, 650000),
      currency: 'EUR',
      po: noPo.has(i) ? '' : `PO-${pos[i]}`,
      status,
    };
  });
  const count = (s: Status) => rows.filter((i) => i.status === s).length;
  check(
    count('paid') >= 12 && count('open') >= 12 && count('disputed') >= 4,
    'base ledger statuses',
  );
  return sortLedger(rows);
}

export const copyLedger = (rows: readonly Invoice[]): Invoice[] => rows.map((i) => ({ ...i }));
/** Not settled: `open` or `disputed`. */
export const unpaid = (i: Invoice): boolean => i.status !== 'paid';
export const sum = (rows: readonly Invoice[]): number => rows.reduce((s, i) => s + i.cents, 0);

/** Cents per key as a JSON object of amounts, keys in ascending order. */
export const amounts = (map: ReadonlyMap<string, number>): JsonObject =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, eur(v)]));
