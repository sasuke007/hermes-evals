/**
 * The two knowledge-v1 tasks that are not a figure read from a statement:
 * house_summary, a monthly review written in the house style
 * (samples/skills/house-style), and unrelated, a plain CSV sum that no
 * knowledge arm needs (the control). The construction of each trap is
 * described in ../knowledge-v1.ts.
 */
import { csv, promptTail } from '../invoices-v1/ledger.ts';
import {
  addDays,
  check,
  choose,
  daysBetween,
  int,
  movementTotals,
  parseBx7,
  statementFile,
  taskRng,
  units,
} from './format.ts';
import { buildStatement, EVERYDAY_CODES } from './statements.ts';
import { ACCOUNT, type Task } from './tasks.ts';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The house style's date: `5 Jun 2026`. */
export const houseDate = (iso: string): string =>
  `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]!.slice(0, 3)} ${iso.slice(0, 4)}`;

/** The house style's amount: `EUR 12,345.60`, money out `EUR -1,200.00`. */
export function houseAmount(currency: string, cents: number): string {
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ',');
  return `${currency} ${cents < 0 ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Plain amounts, as an agent without the house style writes them: `12345.60 EUR`. */
const plainAmount = (currency: string, cents: number): string =>
  `${(cents / 100).toFixed(2)} ${currency}`;

/** What the knowledge arm's final reply says about its review (outside the answer block). */
export const HOUSE_REPLY_NOTE =
  'The review follows the house style: its title, the layout of three points and a source line, and the way it writes dates and amounts.';

export function houseSummary(): Task {
  const file = 'statement_2026_06.bx7';
  const r = taskRng('house_summary');
  const text = statementFile(
    buildStatement(r, {
      account: ACCOUNT,
      currency: 'EUR',
      periodStart: '2026-06-01',
      statementDate: '2026-06-30',
      headerText: 'MONTHLY STATEMENT',
      opening: { direction: 'V', cents: int(r, 1_500_000, 6_000_000) },
      movements: 26,
      codes: EVERYDAY_CODES,
      longText: 0.1,
    }),
  );
  const p = parseBx7(text);
  const totals = movementTotals(p);
  const outs = p.records.filter((x) => x.type === 'E' && x.direction === 'W');
  const largest = outs.reduce((a, b) => (b.cents > a.cents ? b : a));
  check(
    p.counts.F === 0 && outs.filter((x) => x.cents === largest.cents).length === 1,
    'house_summary has one largest movement out',
  );
  const money = (cents: number) => houseAmount(p.currency, cents);
  const month = MONTHS[Number(p.statementDate.slice(5, 7)) - 1]!;
  const title = `Statement review: account ending ${p.account.slice(-4)}, ${month} ${p.statementDate.slice(0, 4)}`;
  const summary = [
    `- Period ${houseDate(p.periodStart)} to ${houseDate(p.statementDate)}. Opening balance ${money(p.openingCents)}, closing balance ${money(p.closingCents)}.`,
    `- Money in ${money(totals.V.cents)} over ${totals.V.count} movements. Money out ${money(-totals.W.cents)} over ${totals.W.count} movements.`,
    `- Largest movement out: ${money(-largest.cents)} on ${houseDate(largest.date)}.`,
    '',
    `Source: ${file}.`,
  ].join('\n');
  const plain = (cents: number) => plainAmount(p.currency, cents);
  const trapSummary = [
    `Account ${p.account}, ${p.periodStart} to ${p.statementDate}.`,
    `Opening balance ${plain(p.openingCents)}, closing balance ${plain(p.closingCents)}.`,
    `Money in ${plain(totals.V.cents)} (${totals.V.count} movements), money out ${plain(totals.W.cents)} (${totals.W.count} movements).`,
    `Largest payment ${plain(largest.cents)} on ${largest.date}.`,
  ].join(' ');
  return {
    key: 'house_summary',
    files: new Map([
      [`fixtures/${file}`, text],
      [
        'prompt.md',
        `Your working directory contains \`${file}\`, a bank statement in the BX-7 statement file format.\n\n` +
          `Write the monthly statement review of ${file} for the finance team, in the house style. Put the review's title line in \`title\`, and the lines after it in \`summary\`, with \`\\n\` between lines.\n\n` +
          promptTail('{ "title": "", "summary": "" }'),
      ],
    ]),
    reference: { title, summary },
    trap: {
      answer: { title: `Summary of ${file}`, summary: trapSummary },
      note: 'a plain review: its own title, ISO dates and amounts with the currency after them',
    },
    phrase: `Write the monthly statement review of ${file}`,
    file,
    statement: true,
  };
}

const CATEGORIES = ['travel', 'meals', 'office', 'software'] as const;
const DESCRIPTIONS: Record<(typeof CATEGORIES)[number], readonly string[]> = {
  travel: [
    'Train to the client site',
    'Taxi from the airport',
    'Hotel, two nights',
    'Flight to the trade fair',
  ],
  meals: ['Team lunch', 'Client dinner', 'Coffee for the workshop'],
  office: ['Printer paper', 'Desk lamp', 'Whiteboard markers'],
  software: ['Diagram tool, monthly plan', 'Password manager seats'],
};

export function unrelated(): Task {
  const file = 'expenses.csv';
  const r = taskRng('unrelated');
  // Thirteen claims a month, four of them travel, over August to October.
  const rows = (['2026-08-01', '2026-09-01', '2026-10-01'] as const)
    .flatMap((first) =>
      Array.from({ length: 13 }, (_, i) => {
        const category = i < 4 ? 'travel' : choose(r, CATEGORIES.slice(1));
        const date = addDays(first, int(r, 0, daysBetween(first, addDays(first, 27))));
        const cents = category === 'travel' ? int(r, 1500, 48000) : int(r, 300, 12000);
        return { date, category, description: choose(r, DESCRIPTIONS[category]), cents };
      }),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const travel = rows.filter((x) => x.category === 'travel');
  const september = travel.filter((x) => x.date.startsWith('2026-09'));
  check(
    september.length >= 3 && travel.length - september.length >= 3,
    'unrelated needs travel in September and in other months',
  );
  const sum = (xs: typeof rows) => xs.reduce((s, x) => s + x.cents, 0);
  const phrase = 'What did the team spend on travel in September 2026?';
  return {
    key: 'unrelated',
    files: new Map([
      [
        `fixtures/${file}`,
        csv(
          ['date', 'category', 'description', 'amount'],
          rows.map((x) => [x.date, x.category, x.description, (x.cents / 100).toFixed(2)]),
        ),
      ],
      [
        'prompt.md',
        `Your working directory contains \`${file}\`, our team's expense claims: one row per claim, with its date, category, description and amount in EUR.\n\n` +
          `${phrase} Add up the \`amount\` of every claim whose \`category\` is \`travel\` and whose \`date\` falls in September 2026, rounded to the cent.\n\n` +
          promptTail('{ "travel_september": 0.0 }'),
      ],
    ]),
    reference: { travel_september: units(sum(september)) },
    trap: {
      answer: { travel_september: units(sum(travel)) },
      note: 'every travel claim added, whatever its month',
    },
    phrase,
    file,
    statement: false,
  };
}
