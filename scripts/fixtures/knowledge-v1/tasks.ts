/**
 * The statement tasks of knowledge-v1: closing_balance, record_counts,
 * large_file, reason_codes, pick_version and prompt_override. Each builds its
 * BX-7 file, reads it back with the generator's own reader (format.ts
 * parseBx7), and computes its reference and its trap answer from what was
 * read (the construction of each trap is described in ../knowledge-v1.ts).
 * house_summary and unrelated are in report-tasks.ts.
 */
import { mulberry32, promptTail, type JsonObject } from '../invoices-v1/ledger.ts';
import {
  check,
  int,
  movementTotals,
  parseBx7,
  SEED,
  statementFile,
  taskRng,
  units,
  type Direction,
  type Parsed,
  type Statement,
} from './format.ts';
import { buildStatement, CODES, codeOf, EVERYDAY_CODES } from './statements.ts';

/** One task folder's generated content, its trap, and what its mock scripts need. */
export interface Task {
  key: string;
  /** Path in the task folder → content (reference.json is written from `reference`). */
  files: Map<string, string>;
  /** The answer object a correct agent gives (reference.json). */
  reference: JsonObject;
  /** What an agent that falls into the trap answers. */
  trap: { answer: JsonObject; note: string };
  /** A phrase only this task's prompt holds: its no-knowledge mock script's `match`. */
  phrase: string;
  /** The workspace file the task is about (in fixtures/). */
  file: string;
  /** Whether `file` is a BX statement, which the knowledge arms' mock runs bx7.py on. */
  statement: boolean;
}

/** The company's current account, which every monthly statement is for. */
export const ACCOUNT = String(int(mulberry32(SEED), 1_000_000_000, 9_999_999_999)).padStart(
  10,
  '0',
);
/** The treasury account of pick_version's export. */
export const TREASURY_ACCOUNT = String(int(mulberry32(SEED + 1), 1_000_000_000, 9_999_999_999));
/** The fee codes SKILL.md names in its short list: all an agent that stops there knows. */
export const SKILL_FEE_CODES = ['K52'];

const FEE_CODES = new Set(CODES.filter((c) => c.cls === 'fee').map((c) => c.code));
const statementIntro = (file: string, what = 'a bank statement') =>
  `Your working directory contains \`${file}\`, ${what} in the BX-7 statement file format.\n\n`;
const sortedObject = (entries: Array<[string, number]>): JsonObject =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1)));

function written(text: string): Parsed {
  const parsed = parseBx7(text);
  check(parsed.format === 'BX07', 'a statement is not BX07');
  return parsed;
}

export function closingBalance(): Task {
  const file = 'statement_2026_03.bx7';
  const r = taskRng('closing_balance');
  const text = statementFile(
    buildStatement(r, {
      account: ACCOUNT,
      currency: 'EUR',
      periodStart: '2026-03-01',
      statementDate: '2026-03-31',
      headerText: 'MONTHLY STATEMENT',
      opening: { direction: 'W', cents: int(r, 120_000, 900_000) },
      movements: 32,
      codes: EVERYDAY_CODES,
      longText: 0.12,
    }),
  );
  const p = written(text);
  check(p.openingCents < 0 && p.continuationLines >= 2, 'closing_balance opens overdrawn');
  const phrase = `What is the closing balance of ${file}?`;
  return {
    key: 'closing_balance',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        statementIntro(file) +
          `${phrase} The closing balance is the account's balance after every record in the file has been applied, in the account's currency, rounded to the cent. A negative balance (an overdrawn account) is a negative number.\n\n` +
          promptTail('{ "closing_balance": 0.0 }'),
      ],
    ]),
    reference: { closing_balance: units(p.closingCents) },
    trap: {
      // The opening balance's W ignored: an overdrawn start read as money in the account.
      answer: { closing_balance: units(p.closingCents - 2 * p.openingCents) },
      note: 'the opening balance read as positive, its direction letter W ignored',
    },
    phrase,
    file,
    statement: true,
  };
}

export function recordCounts(): Task {
  const file = 'statement_2026_04.bx7';
  const r = taskRng('record_counts');
  const text = statementFile(
    buildStatement(r, {
      account: ACCOUNT,
      currency: 'EUR',
      periodStart: '2026-04-01',
      statementDate: '2026-04-30',
      headerText: 'MONTHLY STATEMENT',
      opening: { direction: 'V', cents: int(r, 1_500_000, 6_000_000) },
      movements: 38,
      codes: EVERYDAY_CODES,
      reversals: 4,
      longText: 0.2,
    }),
  );
  const p = written(text);
  const linesOf = (type: string) =>
    p.records.filter((x) => x.type === type).reduce((n, x) => n + x.lines, 0);
  check(
    linesOf('E') - p.counts.E! >= 2 && linesOf('F') > p.counts.F!,
    'record_counts needs continuation lines on movements and on a reversal',
  );
  const phrase = `How many records does ${file} hold?`;
  return {
    key: 'record_counts',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        statementIntro(file) +
          `${phrase} Count records as the BX-7 format defines them, and give the number of movement records, the number of reversal records, and the number of records of every type together.\n\n` +
          promptTail('{ "record_counts": { "movements": 0, "reversals": 0, "records": 0 } }'),
      ],
    ]),
    reference: {
      record_counts: { movements: p.counts.E!, reversals: p.counts.F!, records: p.records.length },
    },
    trap: {
      answer: {
        record_counts: { movements: linesOf('E'), reversals: linesOf('F'), records: p.lines },
      },
      note: 'lines counted as records: every continuation line counted again',
    },
    phrase,
    file,
    statement: true,
  };
}

/** Records in large_file's statement: header, opening balance, movements, reversals, trailer. */
export const LARGE_RECORDS = { movements: 4850, reversals: 147 };

export function largeFile(): Task {
  const file = 'statement_2026_q2.bx7';
  const r = taskRng('large_file');
  const text = statementFile(
    buildStatement(r, {
      account: ACCOUNT,
      currency: 'EUR',
      periodStart: '2026-04-01',
      statementDate: '2026-06-30',
      headerText: 'QUARTERLY STATEMENT',
      opening: { direction: 'V', cents: int(r, 5_000_000, 20_000_000) },
      movements: LARGE_RECORDS.movements,
      codes: [...EVERYDAY_CODES, 'K55', 'X84'],
      reversals: LARGE_RECORDS.reversals,
      longText: 0.06,
    }),
  );
  const p = written(text);
  check(p.records.length === 5000, `large_file holds ${p.records.length} records, not 5,000`);
  // A reader that skips the reversal rule applies each F record as its letter says.
  const asWritten = p.records
    .filter((x) => x.type === 'E' || x.type === 'F')
    .reduce((s, x) => s + (x.direction === 'V' ? x.cents : -x.cents), p.openingCents);
  check(Math.abs(asWritten - p.closingCents) > 100, 'large_file reversals must move the balance');
  const phrase = `What is the closing balance of ${file}?`;
  return {
    key: 'large_file',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        statementIntro(file, "a quarter's bank statement with 5,000 records") +
          `${phrase} The closing balance is the account's balance after every record in the file has been applied, in the account's currency, rounded to the cent.\n\n` +
          promptTail('{ "closing_balance": 0.0 }'),
      ],
    ]),
    reference: { closing_balance: units(p.closingCents) },
    trap: {
      answer: { closing_balance: units(asWritten) },
      note: 'reversal records applied in the direction their letter shows, as for a movement',
    },
    phrase,
    file,
    statement: true,
  };
}

export function reasonCodes(): Task {
  const file = 'statement_2026_05.bx7';
  const r = taskRng('reason_codes');
  const text = statementFile(
    buildStatement(r, {
      account: ACCOUNT,
      currency: 'EUR',
      periodStart: '2026-05-01',
      statementDate: '2026-05-31',
      headerText: 'MONTHLY STATEMENT',
      opening: { direction: 'V', cents: int(r, 1_500_000, 6_000_000) },
      movements: 30,
      codes: EVERYDAY_CODES,
      planted: ['K52', 'K52', 'K55', 'K55', 'K55', 'K58', 'X84', 'X84', 'K61', 'K66'],
      longText: 0.1,
    }),
  );
  const p = written(text);
  const totals = new Map<string, number>();
  for (const x of p.records.filter((y) => y.type === 'E' && FEE_CODES.has(y.code))) {
    totals.set(x.code, (totals.get(x.code) ?? 0) + x.cents);
  }
  const used = new Set(p.records.map((x) => x.code));
  check(
    [...totals.keys()].filter((c) => !SKILL_FEE_CODES.includes(c)).length >= 3 &&
      used.has('K61') &&
      used.has('K66') &&
      p.counts.F === 0,
    'reason_codes needs fee codes beyond the short list, and K codes that are not fees',
  );
  const fees = (keep: (code: string) => boolean) =>
    sortedObject([...totals].filter(([c]) => keep(c)).map(([c, v]) => [c, units(v)]));
  const phrase = `Which fee codes does ${file} use, and what is the total of each?`;
  return {
    key: 'reason_codes',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        statementIntro(file) +
          'A fee is a movement whose reason code has the class `fee` in the BX-7 reason code table.\n\n' +
          `${phrase} Key each total by its reason code, and give it as a positive amount in the account's currency, rounded to the cent.\n\n` +
          promptTail('{ "fees_by_code": { "A00": 0.0 } }'),
      ],
    ]),
    reference: { fees_by_code: fees(() => true) },
    trap: {
      answer: { fees_by_code: fees((c) => SKILL_FEE_CODES.includes(c)) },
      note: 'only the fee codes SKILL.md lists: the table in codes.md never read',
    },
    phrase,
    file,
    statement: true,
  };
}

export function pickVersion(): Task {
  const file = 'treasury_export.bx';
  const r = taskRng('pick_version');
  const text = statementFile(
    buildStatement(r, {
      account: TREASURY_ACCOUNT,
      currency: 'EUR',
      periodStart: '2026-08-01',
      statementDate: '2026-08-31',
      headerText: 'TREASURY EXPORT',
      opening: { direction: 'V', cents: int(r, 2_000_000, 9_000_000) },
      movements: 30,
      codes: EVERYDAY_CODES,
      longText: 0,
    }),
  );
  const p = written(text);
  const totals = movementTotals(p);
  check(p.continuationLines === 0 && p.counts.F === 0, 'pick_version reads cleanly as BX-6 too');
  // BX-6: three implied decimals, and V is money out there (W money in).
  const bx6Out = Math.round(totals.V.cents / 10) / 100;
  const phrase = `How much money went out of the account in ${file}?`;
  return {
    key: 'pick_version',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        `Your working directory contains \`${file}\`, a bank statement file from our old treasury system's export folder, in one of the bank's BX statement file formats.\n\n` +
          `${phrase} Give the total of every debit (money out) over the statement period, in the account's currency, rounded to the cent, as a positive number.\n\n` +
          promptTail('{ "money_out": 0.0 }'),
      ],
    ]),
    reference: { money_out: units(totals.W.cents) },
    trap: {
      answer: { money_out: bx6Out },
      note: 'read as BX-6, the decoy: amounts in thousandths and V as money out',
    },
    phrase,
    file,
    statement: true,
  };
}

const flip = (d: Direction): Direction => (d === 'V' ? 'W' : 'V');

/**
 * A statement as the bank's own ledger writes it, from the bank's side:
 * every direction letter the other way round (the opening balance's and
 * each movement's), so a receipt shows W and a payment V.
 */
const fromBanksSide = (s: Statement): Statement => ({
  ...s,
  opening: { ...s.opening, direction: flip(s.opening.direction) },
  items: s.items.map((item) => ({ ...item, direction: flip(item.direction) })),
});

export function promptOverride(): Task {
  const file = 'ledger_view_2026_07.bx7';
  const r = taskRng('prompt_override');
  const text = statementFile(
    fromBanksSide(
      buildStatement(r, {
        account: ACCOUNT,
        currency: 'EUR',
        periodStart: '2026-07-01',
        statementDate: '2026-07-31',
        headerText: 'LEDGER VIEW',
        opening: { direction: 'V', cents: int(r, 1_500_000, 6_000_000) },
        movements: 30,
        codes: EVERYDAY_CODES,
        longText: 0.1,
      }),
    ),
  );
  const p = written(text);
  const totals = movementTotals(p);
  check(p.counts.F === 0 && totals.V.cents !== totals.W.cents, 'prompt_override moves both ways');
  // The file agrees with the prompt: every code that moves money one way only
  // (a receipt in, a payment, card or tax out) shows the other letter here.
  check(
    p.records
      .filter((x) => x.type === 'E')
      .every((x) => {
        const { directions } = codeOf(x.code);
        return directions.length > 1 || x.direction === flip(directions[0]!);
      }) && p.records[1]!.direction === 'W',
    "prompt_override's letters are the other way round throughout",
  );
  const phrase = `How much money arrived in our account over the period of ${file}, and how much left it?`;
  return {
    key: 'prompt_override',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        statementIntro(file, "a statement of our account exported from the bank's own ledger") +
          "That ledger records our account from the bank's side, so in this file the direction letters mean the opposite of what the BX-7 format says: `V` marks money leaving our account and `W` marks money arriving in it. Every other BX-7 rule applies as usual.\n\n" +
          `${phrase} Give both as positive amounts in the account's currency, rounded to the cent.\n\n` +
          promptTail('{ "movements": { "money_in": 0.0, "money_out": 0.0 } }'),
      ],
    ]),
    reference: {
      movements: { money_in: units(totals.W.cents), money_out: units(totals.V.cents) },
    },
    trap: {
      answer: { movements: { money_in: units(totals.V.cents), money_out: units(totals.W.cents) } },
      note: "the format's own direction letters followed instead of the prompt's: payments read as money in",
    },
    phrase,
    file,
    statement: true,
  };
}
