/**
 * The BX-7 statement format of knowledge-v1 (../knowledge-v1.ts), as the
 * generator writes it and as it reads it back: the record model, the line
 * writer, and an independent reader that the references are computed with.
 * The reader parses the written text, never the objects the text was made
 * from, so a reference describes the file an agent receives. The shipped
 * reader, samples/skills/bx7-format/scripts/bx7.py, is a separate Python
 * implementation of the same description (SKILL.md); the tests check the two
 * agree on every fixture.
 *
 * A line is 64 characters. Columns (from 1): 1 record type (A header, B
 * opening balance, E movement, F reversal, Z trailer); 2 part (0 on a
 * record's first line, 1-9 on its continuation lines); 3-8 the record's
 * sequence number. Amounts are cents in 14 digits at 18-31; column 17 is the
 * direction (V adds to the balance, W subtracts); a reversal repeats the
 * direction of the movement it reverses and moves the balance the other way.
 */
import { mulberry32, type Rng } from '../invoices-v1/ledger.ts';

export const SEED = 20261026;
export const LINE_WIDTH = 64;
export const FORMAT_ID = 'BX07';
/** Text columns 47-64 of a movement or reversal's first line. */
const FIRST_TEXT = 18;
/** Text columns 9-64 of a continuation line. */
const MORE_TEXT = 56;

export type Direction = 'V' | 'W';

export interface Header {
  format: string;
  /** Ten digits. */
  account: string;
  currency: string;
  /** YYYY-MM-DD: the last day of the period. */
  statementDate: string;
  /** YYYY-MM-DD: the first day of the period. */
  periodStart: string;
  text: string;
}

export interface Movement {
  kind: 'E';
  date: string;
  direction: Direction;
  cents: number;
  code: string;
  reference: string;
  text: string;
}

export interface Reversal {
  kind: 'F';
  date: string;
  /** The direction of the movement it reverses, as BX-7 writes it. */
  direction: Direction;
  cents: number;
  code: string;
  /** Index into the statement's items of the movement it reverses. */
  reverses: number;
  text: string;
}

export type Item = Movement | Reversal;

export interface Statement {
  header: Header;
  opening: { date: string; direction: Direction; cents: number };
  items: Item[];
}

// ---------------------------------------------------------------------------
// Randomness, checks, money and dates
// ---------------------------------------------------------------------------

/** FNV-1a, so each task's stream depends on its key only. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export const taskRng = (key: string): Rng => mulberry32(SEED ^ hash(key));
export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const choose = <T>(r: Rng, items: readonly T[]): T => items[int(r, 0, items.length - 1)]!;

/** A construction a trap relies on; a seed that breaks one is refused rather than written. */
export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`knowledge-v1 generator: ${message}; change SEED`);
}

/** Cents as a JSON number: 1234.56. */
export const units = (cents: number): number => cents / 100;

const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
export const isoDay = (d: number): string => new Date(d * 86_400_000).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number): string => isoDay(day(iso) + n);
export const daysBetween = (from: string, to: string): number => day(to) - day(from);
const compact = (iso: string): string => iso.replaceAll('-', '');
const fromCompact = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const digits = (n: number, width: number): string => {
  const s = String(n);
  check(Number.isInteger(n) && n >= 0 && s.length <= width, `${n} does not fit ${width} digits`);
  return s.padStart(width, '0');
};
const text = (s: string, width: number): string => {
  check(/^[A-Z0-9 ./-]*$/.test(s) && s.length <= width, `text "${s}" does not fit ${width}`);
  return s.padEnd(width, ' ');
};

function line(type: string, part: number, seq: number, body: string): string {
  const out = `${type}${part}${digits(seq, 6)}${body}`;
  check(out.length === LINE_WIDTH, `a ${type} line is ${out.length} characters`);
  return out;
}

/** A record's text: the first line's 18 characters, then 56 a continuation line. */
function textLines(type: string, seq: number, full: string): { first: string; more: string[] } {
  const first = full.slice(0, FIRST_TEXT);
  const more: string[] = [];
  for (let at = FIRST_TEXT; at < full.length; at += MORE_TEXT) {
    more.push(line(type, more.length + 1, seq, text(full.slice(at, at + MORE_TEXT), MORE_TEXT)));
  }
  check(more.length <= 9, 'a record has more than nine continuation lines');
  return { first, more };
}

/** The file's lines, sequence numbers and trailer included (each without its line feed). */
export function statementLines(s: Statement): string[] {
  const h = s.header;
  check(/^\d{10}$/.test(h.account), 'the account is ten digits');
  const lines = [
    line(
      'A',
      0,
      1,
      `${text(h.format, 4)}${h.account}${text(h.currency, 3)}` +
        `${compact(h.statementDate)}${compact(h.periodStart)}${text(h.text, 23)}`,
    ),
    line(
      'B',
      0,
      2,
      `${compact(s.opening.date)}${s.opening.direction}${digits(s.opening.cents, 14)}${text('', 33)}`,
    ),
  ];
  let hashTotal = 0;
  s.items.forEach((item, i) => {
    const seq = i + 3;
    const { first, more } = textLines(item.kind, seq, item.text);
    const lead = `${compact(item.date)}${item.direction}${digits(item.cents, 14)}${text(item.code, 3)}`;
    const middle =
      item.kind === 'E'
        ? text(item.reference, 12)
        : `${digits(item.reverses + 3, 6)}${text('', 6)}`;
    lines.push(line(item.kind, 0, seq, `${lead}${middle}${text(first, FIRST_TEXT)}`), ...more);
    hashTotal += item.cents;
  });
  const trailerSeq = s.items.length + 3;
  lines.push(
    line('Z', 0, trailerSeq, `${digits(s.items.length, 6)}${digits(hashTotal, 16)}${text('', 34)}`),
  );
  return lines;
}

export const statementFile = (s: Statement): string => `${statementLines(s).join('\n')}\n`;

// ---------------------------------------------------------------------------
// Reading: the generator's own reader, written from SKILL.md, not from the writer
// ---------------------------------------------------------------------------

export interface ParsedRecord {
  type: string;
  seq: number;
  /** Lines of the record: its first line and its continuation lines. */
  lines: number;
  date: string;
  direction: Direction | '';
  cents: number;
  code: string;
  /** F only: the sequence number of the movement it reverses. */
  reverses: number;
  text: string;
}

export interface Parsed {
  format: string;
  account: string;
  currency: string;
  statementDate: string;
  periodStart: string;
  lines: number;
  continuationLines: number;
  records: ParsedRecord[];
  /** Records by type letter. */
  counts: Record<string, number>;
  /** Signed: negative when the opening balance shows W. */
  openingCents: number;
  /** Movements showing V and reversals showing W. */
  moneyInCents: number;
  /** Movements showing W and reversals showing V. */
  moneyOutCents: number;
  closingCents: number;
  trailer: { count: number; hashTotal: number };
}

/** The effect of a record on the balance, in cents: E as its direction says, F the other way. */
export function effect(r: ParsedRecord): number {
  if (r.type !== 'E' && r.type !== 'F') return 0;
  const adds = r.direction === 'V' ? r.cents : -r.cents;
  return r.type === 'E' ? adds : -adds;
}

const field = (l: string, from: number, to: number): string => l.slice(from - 1, to);
const num = (s: string, what: string): number => {
  if (!/^\d+$/.test(s)) throw new Error(`BX-7 reader: ${what} "${s}" is not a number`);
  return Number(s);
};

/** Reads a BX-7 file as SKILL.md describes it; throws on anything it does not describe. */
export function parseBx7(content: string): Parsed {
  const raw = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  const records: ParsedRecord[] = [];
  let continuationLines = 0;
  for (const [i, l] of raw.entries()) {
    if (l.length !== LINE_WIDTH) throw new Error(`BX-7 reader: line ${i + 1} is ${l.length} wide`);
    const type = l[0]!;
    const part = num(l[1]!, 'part');
    const seq = num(field(l, 3, 8), 'sequence');
    if (part > 0) {
      const last = records.at(-1);
      if (!last || last.type !== type || last.seq !== seq || last.lines !== part) {
        throw new Error(`BX-7 reader: line ${i + 1} continues nothing`);
      }
      last.text += field(l, 9, 64);
      last.lines += 1;
      continuationLines += 1;
      continue;
    }
    if (seq !== records.length + 1)
      throw new Error(`BX-7 reader: line ${i + 1} is out of sequence`);
    const record: ParsedRecord = {
      type,
      seq,
      lines: 1,
      date: '',
      direction: '',
      cents: 0,
      code: '',
      reverses: 0,
      text: '',
    };
    if (type === 'B' || type === 'E' || type === 'F') {
      const direction = field(l, 17, 17);
      if (direction !== 'V' && direction !== 'W')
        throw new Error(`BX-7 reader: direction ${direction}`);
      record.date = fromCompact(field(l, 9, 16));
      record.direction = direction;
      record.cents = num(field(l, 18, 31), 'amount');
    }
    if (type === 'E' || type === 'F') {
      record.code = field(l, 32, 34);
      record.text = field(l, 47, 64);
      if (type === 'F') record.reverses = num(field(l, 35, 40), 'reversed sequence');
    } else if (type === 'Z') {
      record.reverses = num(field(l, 9, 14), 'trailer count');
      record.cents = num(field(l, 15, 30), 'hash total');
    } else if (type !== 'A' && type !== 'B') {
      throw new Error(`BX-7 reader: line ${i + 1} has the unknown record type ${type}`);
    }
    records.push(record);
  }
  for (const r of records) r.text = r.text.trimEnd();
  const header = raw[0]!;
  const opening = records[1]!;
  const trailer = records.at(-1)!;
  if (records[0]!.type !== 'A' || opening.type !== 'B' || trailer.type !== 'Z') {
    throw new Error('BX-7 reader: the file does not run header, opening balance, ..., trailer');
  }
  const counts: Record<string, number> = { A: 0, B: 0, E: 0, F: 0, Z: 0 };
  for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const items = records.filter((r) => r.type === 'E' || r.type === 'F');
  for (const r of items.filter((x) => x.type === 'F')) {
    const target = records[r.reverses - 1];
    if (
      !target ||
      target.type !== 'E' ||
      target.direction !== r.direction ||
      target.cents < r.cents
    ) {
      throw new Error(`BX-7 reader: reversal ${r.seq} does not match movement ${r.reverses}`);
    }
  }
  const sum = (keep: (r: ParsedRecord) => boolean) =>
    items.filter(keep).reduce((s, r) => s + r.cents, 0);
  const openingCents = opening.direction === 'V' ? opening.cents : -opening.cents;
  const parsed: Parsed = {
    format: field(header, 9, 12),
    account: field(header, 13, 22),
    currency: field(header, 23, 25),
    statementDate: fromCompact(field(header, 26, 33)),
    periodStart: fromCompact(field(header, 34, 41)),
    lines: raw.length,
    continuationLines,
    records,
    counts,
    openingCents,
    moneyInCents: sum((r) => effect(r) > 0),
    moneyOutCents: sum((r) => effect(r) < 0),
    closingCents: openingCents + items.reduce((s, r) => s + effect(r), 0),
    trailer: { count: trailer.reverses, hashTotal: trailer.cents },
  };
  if (parsed.trailer.count !== items.length || parsed.trailer.hashTotal !== sum(() => true)) {
    throw new Error('BX-7 reader: the trailer does not match the records');
  }
  return parsed;
}

/** Movements (E) only, as their direction column says, by direction. */
export function movementTotals(p: Parsed): Record<Direction, { count: number; cents: number }> {
  const out = { V: { count: 0, cents: 0 }, W: { count: 0, cents: 0 } };
  for (const r of p.records) {
    if (r.type !== 'E' || r.direction === '') continue;
    out[r.direction].count += 1;
    out[r.direction].cents += r.cents;
  }
  return out;
}
