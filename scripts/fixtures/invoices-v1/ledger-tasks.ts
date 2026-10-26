/**
 * The six invoices-v1 tasks that read invoices.csv alone: total_due,
 * overdue_list, dup_invoices, per_vendor, disputed and summary_file. Each
 * takes the base ledger, plants its trap and computes its reference and its
 * trap answer (the construction of each trap is described in ../invoices-v1.ts).
 */
import {
  check,
  copyLedger,
  csv,
  day,
  divRound,
  eur,
  int,
  jsonFile,
  ledgerCsv,
  money,
  pick,
  promptTail,
  shuffle,
  sum,
  taskRng,
  unpaid,
  VENDORS,
  type Invoice,
  type JsonObject,
  type Task,
} from './ledger.ts';

/** The cutoff day of overdue_list, stated in its prompt. */
export const OVERDUE_TODAY = '2026-09-01';

export function totalDue(base: readonly Invoice[]): Task {
  return {
    key: 'total_due',
    files: new Map([['fixtures/invoices.csv', ledgerCsv(base)]]),
    reference: { total_due: eur(sum(base.filter(unpaid))) },
    trap: { answer: { total_due: eur(sum(base)) }, note: 'paid invoices added in' },
    phrase: 'What is the total amount still due, in EUR, rounded to the cent?',
    reads: ['invoices.csv'],
    baselineTrapped: false,
  };
}

export function overdueList(base: readonly Invoice[]): Task {
  const r = taskRng('overdue_list');
  const rows = copyLedger(base);
  const today = day(OVERDUE_TODAY);
  const near = rows.filter(
    (i) => i.status === 'open' && Math.abs(i.due - today) <= 25 && i.due !== today,
  );
  check(near.length >= 2, 'overdue_list needs two open invoices near the cutoff');
  for (const i of pick(r, near, 2)) {
    i.due = today;
    i.date = today - 30;
  }
  const numbers = (keep: (i: Invoice) => boolean) =>
    rows
      .filter((i) => unpaid(i) && keep(i))
      .map((i) => i.no)
      .sort();
  const prompt =
    'Your working directory contains `invoices.csv`, our accounts-payable ledger.\n\n' +
    `Today is ${OVERDUE_TODAY}. An invoice is overdue when it is not paid (its \`status\` is \`open\` or \`disputed\`) and its \`due_date\` is before today.\n\n` +
    'Which invoices are overdue today? List every one of them.\n\n' +
    promptTail('{ "overdue": ["INV-00000000"] }');
  return {
    key: 'overdue_list',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['prompt.md', prompt],
    ]),
    reference: { overdue: numbers((i) => i.due < today) },
    trap: {
      answer: { overdue: numbers((i) => i.due <= today) },
      note: 'invoices due on the cutoff day counted as overdue',
    },
    phrase: 'Which invoices are overdue today?',
    reads: ['invoices.csv'],
    baselineTrapped: false,
  };
}

export function dupInvoices(base: readonly Invoice[]): Task {
  const r = taskRng('dup_invoices');
  const rows = copyLedger(base);
  const [a, b, c, d] = pick(r, rows, 4) as [Invoice, Invoice, Invoice, Invoice];
  const pairs: string[][] = [];
  for (const [original, copy] of [
    [a, b],
    [c, d],
  ] as const) {
    // The bill again, under the copy's own number, waiting to be paid twice.
    Object.assign(copy, { ...original, no: copy.no, status: 'open' });
    pairs.push([original.no, copy.no].sort());
  }
  // The decoy: one vendor, one amount, two months: a recurring charge, not a bill sent twice.
  const used = new Set([a.no, b.no, c.no, d.no]);
  const free = (name: string) => rows.filter((i) => i.vendor === name && !used.has(i.no));
  const vendor = shuffle(
    r,
    VENDORS.map((v) => v.name),
  ).find((name) => free(name).length >= 2)!;
  const [first, second] = free(vendor) as [Invoice, Invoice];
  second.cents = first.cents;
  second.date = first.date + 31;
  second.due = second.date + 30;
  const bills = new Map<string, number>();
  for (const i of rows) {
    const bill = `${i.vendor}|${i.date}|${i.cents}`;
    bills.set(bill, (bills.get(bill) ?? 0) + 1);
  }
  check(
    [...bills.values()].filter((n) => n > 1).length === 2 && second.date <= day('2026-10-31'),
    'dup_invoices must hold exactly its two planted pairs',
  );
  return {
    key: 'dup_invoices',
    files: new Map([['fixtures/invoices.csv', ledgerCsv(rows)]]),
    reference: { duplicates: pairs.sort((x, y) => (x[0]! < y[0]! ? -1 : 1)) },
    trap: {
      answer: { duplicates: [] },
      note: 'looked for repeated invoice numbers, of which there are none',
    },
    phrase: 'Which invoices are the same bill as another one?',
    reads: ['invoices.csv'],
    baselineTrapped: true,
  };
}

export function perVendor(base: readonly Invoice[]): Task {
  const r = taskRng('per_vendor');
  const rows = copyLedger(base);
  const candidates = VENDORS.map((v) => v.name).filter(
    (name) => rows.filter((i) => i.vendor === name && unpaid(i)).length >= 2,
  );
  for (const name of pick(r, candidates, 3)) {
    // One unpaid row and one other row of the vendor get one or two trailing spaces.
    const own = rows.filter((i) => i.vendor === name);
    const first = pick(r, own.filter(unpaid), 1)[0]!;
    const second = pick(
      r,
      own.filter((i) => i !== first),
      1,
    )[0]!;
    for (const i of [first, second]) i.vendor = `${name}${' '.repeat(int(r, 1, 2))}`;
  }
  const owed = (key: (i: Invoice) => string): JsonObject => {
    const totals = new Map<string, number>();
    for (const i of rows.filter(unpaid)) totals.set(key(i), (totals.get(key(i)) ?? 0) + i.cents);
    return Object.fromEntries(
      [...totals].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, eur(v)]),
    );
  };
  const reference = owed((i) => i.vendor.trim());
  const trapped = owed((i) => i.vendor);
  check(
    Object.keys(trapped).length > Object.keys(reference).length,
    'per_vendor needs vendors split by their spaces',
  );
  return {
    key: 'per_vendor',
    files: new Map([['fixtures/invoices.csv', ledgerCsv(rows)]]),
    reference: { outstanding_by_vendor: reference },
    trap: {
      answer: { outstanding_by_vendor: trapped },
      note: 'vendor names grouped with their trailing spaces',
    },
    phrase: 'How much do we owe each vendor on its unpaid invoices?',
    reads: ['invoices.csv'],
    baselineTrapped: true,
  };
}

export function disputed(base: readonly Invoice[]): Task {
  const open = base.filter((i) => i.status === 'open');
  const held = base.filter((i) => i.status === 'disputed');
  return {
    key: 'disputed',
    files: new Map([['fixtures/invoices.csv', ledgerCsv(base)]]),
    reference: { average_payable: eur(divRound(sum(open), open.length, 'average_payable')) },
    trap: {
      answer: { average_payable: eur(Math.round(sum(open) / (open.length + held.length))) },
      note: 'disputed invoices kept in the count with a zero amount',
    },
    phrase: 'What is the average amount of an invoice in the payment run',
    reads: ['invoices.csv'],
    baselineTrapped: true,
  };
}

export function summaryFile(base: readonly Invoice[]): Task {
  const rows = copyLedger(base);
  // The vendor with the fewest unpaid invoices has all of them paid here.
  const unpaidOf = (name: string) => rows.filter((i) => i.vendor === name && unpaid(i)).length;
  const settled = [...VENDORS].sort(
    (x, y) => unpaidOf(x.name) - unpaidOf(y.name) || (x.name < y.name ? -1 : 1),
  )[0]!.name;
  for (const i of rows) if (i.vendor === settled) i.status = 'paid';
  const lines = VENDORS.map((v) => {
    const own = rows.filter((i) => i.vendor === v.name && unpaid(i));
    return { vendor: v.name, unpaid_invoices: own.length, outstanding: sum(own) };
  });
  const summary = (keep: typeof lines) =>
    csv(
      ['vendor', 'unpaid_invoices', 'outstanding'],
      keep.map((l) => [l.vendor, String(l.unpaid_invoices), money(l.outstanding)]),
    );
  const trapped = lines.filter((l) => l.unpaid_invoices > 0);
  const expected = { rows: lines.map((l) => ({ ...l, outstanding: eur(l.outstanding) })) };
  return {
    key: 'summary_file',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['expected/summary.csv', summary(lines)],
      ['verify/expected_summary.json', jsonFile(expected)],
    ]),
    reference: { summary_file: 'summary.csv', rows: lines.length },
    trap: {
      answer: { summary_file: 'summary.csv', rows: trapped.length },
      files: { 'summary.csv': summary(trapped) },
      note: `built from the unpaid rows alone, so ${settled} has no row`,
    },
    phrase: 'Write `summary.csv` in the working directory',
    reads: ['invoices.csv'],
    baselineTrapped: true,
  };
}
