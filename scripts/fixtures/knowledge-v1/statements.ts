/**
 * The reason-code table of BX-7 (written to samples/skills/bx7-format/codes.md
 * by ../knowledge-v1.ts) and the random statements the tasks are built from:
 * movements drawn from the codes' amount ranges and texts, reversals of
 * earlier movements, and texts long enough to run onto continuation lines.
 */
import type { Rng } from '../invoices-v1/ledger.ts';
import {
  addDays,
  check,
  choose,
  daysBetween,
  int,
  type Direction,
  type Item,
  type Movement,
  type Reversal,
  type Statement,
} from './format.ts';

export type CodeClass =
  | 'card'
  | 'fee'
  | 'refund'
  | 'interest'
  | 'payment'
  | 'receipt'
  | 'transfer'
  | 'tax'
  | 'correction';

export interface ReasonCode {
  code: string;
  name: string;
  cls: CodeClass;
  /** The directions a movement with this code can show. */
  directions: readonly Direction[];
  /** Amount range in cents. */
  range: readonly [number, number];
  /** Texts of at most 18 characters (one line) and longer ones (continuation lines). */
  short: readonly string[];
  long: readonly string[];
}

/**
 * Every BX-7 reason code. The letter does not give the class: K61 and K66
 * are not fees, and X84 is one. SKILL.md names five of these as examples
 * (C11, P20, R31, K52, N70); the rest are only in codes.md.
 */
export const CODES: readonly ReasonCode[] = [
  {
    code: 'C11',
    name: 'Card purchase',
    cls: 'card',
    directions: ['W'],
    range: [450, 38000],
    short: ['CARD STATIONERY', 'CARD TAXI 4471', 'CARD CAFE CORNER', 'CARD HARDWARE'],
    long: [
      'CARD PURCHASE OFFICE SUPPLIES DEPOT CITY CENTRE',
      'CARD PURCHASE TRAIN TICKETS RETURN JOURNEY 2 ADULTS',
    ],
  },
  {
    code: 'C14',
    name: 'Cash withdrawal by card',
    cls: 'card',
    directions: ['W'],
    range: [2000, 50000],
    short: ['CASH ATM 0182', 'CASH ATM 2290'],
    long: ['CASH WITHDRAWAL ATM 0182 MAIN STREET BRANCH'],
  },
  {
    code: 'C19',
    name: 'Card purchase in another currency',
    cls: 'card',
    directions: ['W'],
    range: [1200, 90000],
    short: ['CARD USD SOFTWARE', 'CARD GBP HOTEL'],
    long: ['CARD PURCHASE IN USD CLOUD SOFTWARE SUBSCRIPTION ANNUAL PLAN'],
  },
  {
    code: 'K52',
    name: 'Account maintenance fee',
    cls: 'fee',
    directions: ['W'],
    range: [1200, 2500],
    short: ['ACCOUNT FEE', 'MAINTENANCE FEE'],
    long: ['ACCOUNT MAINTENANCE FEE FOR THE MONTH'],
  },
  {
    code: 'K55',
    name: 'Payment processing fee',
    cls: 'fee',
    directions: ['W'],
    range: [50, 990],
    short: ['PAYMENT FEE', 'TRANSFER FEE'],
    long: ['PAYMENT PROCESSING FEE OUTGOING TRANSFERS'],
  },
  {
    code: 'K58',
    name: 'Card replacement fee',
    cls: 'fee',
    directions: ['W'],
    range: [1500, 2500],
    short: ['CARD REPLACEMENT'],
    long: ['CARD REPLACEMENT FEE CARD ENDING 4471'],
  },
  {
    code: 'K61',
    name: 'Fee refund',
    cls: 'refund',
    directions: ['V'],
    range: [200, 2500],
    short: ['FEE REFUND'],
    long: ['REFUND OF A FEE CHARGED IN ERROR'],
  },
  {
    code: 'K66',
    name: 'Overdraft interest',
    cls: 'interest',
    directions: ['W'],
    range: [100, 6000],
    short: ['OVERDRAFT INTEREST'],
    long: ['OVERDRAFT INTEREST FOR DAYS BELOW ZERO'],
  },
  {
    code: 'N70',
    name: 'Interest credited',
    cls: 'interest',
    directions: ['V'],
    range: [50, 9000],
    short: ['CREDIT INTEREST', 'INTEREST PAID'],
    long: ['INTEREST CREDITED ON THE AVERAGE BALANCE'],
  },
  {
    code: 'P20',
    name: 'Supplier payment',
    cls: 'payment',
    directions: ['W'],
    range: [15000, 900000],
    short: ['SUPPLIER INV 2207', 'PRINTING SERVICES', 'COURIER SERVICES'],
    long: [
      'SUPPLIER PAYMENT OFFICE FURNITURE INVOICE 2026-117',
      'SUPPLIER PAYMENT IT SUPPORT CONTRACT MONTHLY RETAINER',
    ],
  },
  {
    code: 'P23',
    name: 'Salary payment',
    cls: 'payment',
    directions: ['W'],
    range: [180000, 550000],
    short: ['SALARY', 'SALARY PAYMENT'],
    long: ['SALARY PAYMENT EMPLOYEE 0042 NET PAY THIS MONTH'],
  },
  {
    code: 'P27',
    name: 'Direct debit',
    cls: 'payment',
    directions: ['W'],
    range: [2000, 60000],
    short: ['DD ELECTRICITY', 'DD TELEPHONE', 'DD INSURANCE'],
    long: ['DIRECT DEBIT OFFICE LEASE MONTHLY INSTALMENT'],
  },
  {
    code: 'R31',
    name: 'Customer receipt',
    cls: 'receipt',
    directions: ['V'],
    range: [20000, 1200000],
    short: ['CUSTOMER PAYMENT', 'INVOICE 4410 PAID'],
    long: [
      'CUSTOMER RECEIPT INVOICE 2026-0418 WITH THANKS',
      'CUSTOMER RECEIPT PART PAYMENT INVOICE 2026-0377',
    ],
  },
  {
    code: 'R35',
    name: 'Incoming transfer',
    cls: 'receipt',
    directions: ['V'],
    range: [10000, 800000],
    short: ['TRANSFER IN', 'INCOMING TRANSFER'],
    long: ['INCOMING TRANSFER FROM PARTNER ACCOUNT SETTLEMENT'],
  },
  {
    code: 'T40',
    name: 'Transfer between own accounts',
    cls: 'transfer',
    directions: ['V', 'W'],
    range: [50000, 1500000],
    short: ['OWN ACCOUNT', 'SAVINGS SWEEP'],
    long: ['TRANSFER BETWEEN OWN ACCOUNTS SAVINGS SWEEP'],
  },
  {
    code: 'X81',
    name: 'Withholding tax',
    cls: 'tax',
    directions: ['W'],
    range: [500, 20000],
    short: ['WITHHOLDING TAX'],
    long: ['WITHHOLDING TAX ON INTEREST CREDITED'],
  },
  {
    code: 'X84',
    name: 'Currency conversion charge',
    cls: 'fee',
    directions: ['W'],
    range: [80, 3000],
    short: ['FX CHARGE', 'CONVERSION CHARGE'],
    long: ['CURRENCY CONVERSION CHARGE ON A CARD PURCHASE IN USD'],
  },
  {
    code: 'Z90',
    name: 'Bank correction',
    cls: 'correction',
    directions: ['V', 'W'],
    range: [100, 10000],
    short: ['BANK CORRECTION'],
    long: ['CORRECTION OF A BOOKING ERROR BY THE BANK'],
  },
];

export const codeOf = (code: string): ReasonCode => {
  const found = CODES.find((c) => c.code === code);
  check(found !== undefined, `no reason code ${code}`);
  return found!;
};

/**
 * The codes a random movement is drawn from, a code listed twice drawn twice
 * as often: everything but the fees, refunds and corrections.
 */
export const EVERYDAY_CODES = [
  'C11',
  'C11',
  'C11',
  'C14',
  'C19',
  'N70',
  'P20',
  'P20',
  'P20',
  'P23',
  'P27',
  'P27',
  'R31',
  'R31',
  'R31',
  'R35',
  'R35',
  'T40',
  'X81',
];

export interface StatementPlan {
  account: string;
  currency: string;
  periodStart: string;
  statementDate: string;
  headerText: string;
  opening: { direction: Direction; cents: number };
  /** Random movements, drawn from `codes`. */
  movements: number;
  codes: readonly string[];
  /** Movements with a fixed code, placed at random dates. */
  planted?: readonly string[];
  reversals?: number;
  /** Share of movements and reversals whose text runs onto continuation lines. */
  longText: number;
}

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const reference = (r: Rng): string =>
  Array.from({ length: 12 }, () => ALNUM[int(r, 0, ALNUM.length - 1)]).join('');

function movement(r: Rng, plan: StatementPlan, code: string): Movement {
  const c = codeOf(code);
  return {
    kind: 'E',
    date: addDays(plan.periodStart, int(r, 0, daysBetween(plan.periodStart, plan.statementDate))),
    direction: choose(r, c.directions),
    cents: int(r, c.range[0], c.range[1]),
    code,
    reference: reference(r),
    text: r() < plan.longText ? choose(r, c.long) : choose(r, c.short),
  };
}

/**
 * A statement: the plan's movements in date order (a stable order on equal
 * dates), each reversal after the movement it reverses, with that
 * movement's direction and code and all or half of its amount.
 */
export function buildStatement(r: Rng, plan: StatementPlan): Statement {
  const moves = [
    ...Array.from({ length: plan.movements }, () => movement(r, plan, choose(r, plan.codes))),
    ...(plan.planted ?? []).map((code) => movement(r, plan, code)),
  ];
  moves.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const reversed = new Set<Movement>();
  const pairs: Array<{ target: Movement; reversal: Omit<Reversal, 'reverses'> }> = [];
  for (let i = 0; i < (plan.reversals ?? 0); i += 1) {
    const free = moves.filter(
      (m) => !reversed.has(m) && daysBetween(m.date, plan.statementDate) >= 1,
    );
    check(free.length > 0, 'no movement is left to reverse');
    const target = choose(r, free);
    reversed.add(target);
    const later = int(r, 1, Math.min(6, daysBetween(target.date, plan.statementDate)));
    pairs.push({
      target,
      reversal: {
        kind: 'F',
        date: addDays(target.date, later),
        direction: target.direction,
        cents: r() < 0.25 ? Math.max(1, Math.floor(target.cents / 2)) : target.cents,
        code: target.code,
        // The first reversal's text always runs on, when the plan has long texts at all.
        text:
          r() < plan.longText || (i === 0 && plan.longText > 0)
            ? `REVERSAL OF ${target.reference}`
            : 'REVERSAL',
      },
    });
  }
  // Movements first, then reversals, each list by date: a stable sort keeps a
  // reversal after its movement, which is never dated later than it.
  const items: Item[] = [...moves];
  const reversals = pairs.map((p) => ({ ...p.reversal, reverses: -1 }));
  items.push(...reversals);
  const order = items.map((item, i) => ({ item, i }));
  order.sort((a, b) =>
    a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : a.i - b.i,
  );
  const sorted = order.map((o) => o.item);
  pairs.forEach((p, k) => {
    const rev = reversals[k]!;
    rev.reverses = sorted.indexOf(p.target);
    check(
      rev.reverses >= 0 && rev.reverses < sorted.indexOf(rev),
      'a reversal precedes its movement',
    );
  });
  return {
    header: {
      format: 'BX07',
      account: plan.account,
      currency: plan.currency,
      statementDate: plan.statementDate,
      periodStart: plan.periodStart,
      text: plan.headerText,
    },
    opening: { date: plan.periodStart, ...plan.opening },
    items: sorted,
  };
}
