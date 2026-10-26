/**
 * The six invoices-v1 tasks that read a second file beside invoices.csv:
 * vat_split and late_fees (policy_terms.json), credit_notes
 * (credit_notes.csv), currency_mix (rates.json), missing_po
 * (purchase_orders.csv) and partial_pay (payments.csv). Each plants its trap
 * and computes its reference and its trap answer (the construction of each
 * trap is described in ../invoices-v1.ts).
 */
import {
  amounts,
  BANDS,
  check,
  copyLedger,
  csv,
  day,
  divRound,
  eur,
  FEE,
  int,
  isoDay,
  jsonFile,
  ledgerCsv,
  money,
  pick,
  POLICY,
  promptTail,
  range,
  sum,
  taskRng,
  unpaid,
  VAT_BP,
  VENDORS,
  type Band,
  type Invoice,
  type Json,
  type Task,
} from './ledger.ts';

/** The day late_fees assesses its fees, stated in its prompt. */
export const FEES_TODAY = '2026-10-15';

export function vatSplit(base: readonly Invoice[]): Task {
  const bandOf = new Map<string, Band>(VENDORS.map((v) => [v.name, v.band]));
  const net = (bands: readonly Band[]) =>
    sum(base.filter((i) => bands.includes(bandOf.get(i.vendor)!)));
  // VAT on the band's total net, rounded once (the prompt says so).
  const vat = (cents: number, band: Band) => divRound(cents * VAT_BP[band], 10000, `VAT ${band}`);
  const entry = (cents: number, band: Band) => ({ net: eur(cents), vat: eur(vat(cents, band)) });
  check(net(['zero']) > 0, 'vat_split needs invoices in the zero band');
  const totalVat = BANDS.reduce((s, b) => s + vat(net([b]), b), 0);
  // The trap: the zero band's vendors taxed at the standard rate, as if their band were unknown.
  const standard = net(['standard', 'zero']);
  const trapVat = vat(standard, 'standard') + vat(net(['reduced']), 'reduced');
  return {
    key: 'vat_split',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(base)],
      ['fixtures/policy_terms.json', jsonFile(POLICY)],
    ]),
    reference: {
      vat_bands: Object.fromEntries(BANDS.map((b) => [b, entry(net([b]), b)])),
      total_vat: eur(totalVat),
    },
    trap: {
      answer: {
        vat_bands: {
          standard: entry(standard, 'standard'),
          reduced: entry(net(['reduced']), 'reduced'),
        },
        total_vat: eur(trapVat),
      },
      note: 'the zero-rated band taxed at the standard rate',
    },
    phrase: 'What are the net total and the VAT of each band',
    reads: ['invoices.csv', 'policy_terms.json'],
    baselineTrapped: false,
  };
}

export function creditNotes(base: readonly Invoice[]): Task {
  const r = taskRng('credit_notes');
  const targets = [
    ...pick(
      r,
      base.filter((i) => i.status === 'open'),
      4,
    ),
    ...pick(
      r,
      base.filter((i) => i.status === 'paid'),
      1,
    ),
  ];
  const notes = targets.map((i) => ({
    invoice: i,
    cents: Math.round((i.cents * int(r, 5, 40)) / 100),
    date: i.date + int(r, 3, 20),
  }));
  notes.sort((x, y) => x.date - y.date || (x.invoice.no < y.invoice.no ? -1 : 1));
  const rows = notes.map((n, k) => [
    `CN-${String(k + 1).padStart(4, '0')}`,
    n.invoice.no,
    n.invoice.vendor,
    isoDay(n.date),
    money(n.cents),
  ]);
  const owed = (keep: (i: Invoice) => boolean) =>
    amounts(
      new Map(
        notes.filter((n) => keep(n.invoice)).map((n) => [n.invoice.no, n.invoice.cents - n.cents]),
      ),
    );
  return {
    key: 'credit_notes',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(base)],
      [
        'fixtures/credit_notes.csv',
        csv(['credit_note_no', 'invoice_no', 'vendor_name', 'issued_on', 'amount'], rows),
      ],
    ]),
    reference: { net_after_credits: owed(unpaid) },
    trap: {
      answer: { net_after_credits: owed(() => true) },
      note: 'the credit note on a paid invoice applied too',
    },
    phrase: 'what do we still owe after its credit notes?',
    reads: ['invoices.csv', 'credit_notes.csv'],
    baselineTrapped: true,
  };
}

export function currencyMix(base: readonly Invoice[]): Task {
  // EUR per unit, except SEK, which rates.json quotes the other way round.
  const quoted = { GBP: 1.1725, USD: 0.9184, SEK: 11.238 };
  type Quoted = keyof typeof quoted;
  const billing: Record<string, { currency: Quoted; perEur: number }> = {
    'Granite Office': { currency: 'GBP', perEur: 0.85 },
    'Fjord Software': { currency: 'USD', perEur: 1.09 },
    'Borealis Logistics': { currency: 'SEK', perEur: 11.2 },
  };
  const rows = copyLedger(base).map((i) => {
    const b = billing[i.vendor];
    return b ? { ...i, currency: b.currency, cents: Math.round(i.cents * b.perEur) } : i;
  });
  const inEur = (i: Invoice, invertSek: boolean): number => {
    if (i.currency === 'EUR') return i.cents;
    const rate = quoted[i.currency as Quoted];
    return i.currency === 'SEK' && invertSek ? i.cents / rate : i.cents * rate;
  };
  // Converted invoice by invoice, rounded once; the key's relative tolerance absorbs either order.
  const total = (invertSek: boolean) =>
    eur(Math.round(rows.filter(unpaid).reduce((s, i) => s + inEur(i, invertSek), 0)));
  check(
    rows.some((i) => unpaid(i) && i.currency === 'SEK'),
    'currency_mix needs an unpaid SEK invoice',
  );
  const rates: Json = {
    base_currency: 'EUR',
    quoted_on: '2026-09-30',
    convention: 'Each rate is the EUR value of one unit of the currency.',
    rates: quoted,
    notes: { SEK: 'Quoted the other way round, as the bank sends it: SEK per one EUR.' },
  };
  return {
    key: 'currency_mix',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['fixtures/rates.json', jsonFile(rates)],
    ]),
    reference: { total_eur: total(true) },
    trap: {
      answer: { total_eur: total(false) },
      note: 'the SEK rate used as EUR per SEK, against its note',
    },
    phrase: 'What do the invoices still due add up to in EUR?',
    reads: ['invoices.csv', 'rates.json'],
    baselineTrapped: true,
  };
}

export function missingPo(base: readonly Invoice[]): Task {
  const r = taskRng('missing_po');
  const withPo = base.filter((i) => i.po !== '');
  const unknown = new Set(pick(r, withPo, 3).map((i) => i.po));
  const listed = withPo
    .filter((i) => !unknown.has(i.po))
    .map((i) => [i.po, i.vendor, isoDay(i.date - int(r, 5, 40))]);
  // A few purchase orders no invoice uses yet, as a real list has.
  const taken = new Set(base.map((i) => i.po));
  const spare = range(1000, 9999).filter((n) => !taken.has(`PO-${n}`));
  for (const n of pick(r, spare, 4)) {
    const date = isoDay(day('2026-06-01') + int(r, 0, 100));
    listed.push([`PO-${n}`, VENDORS[int(r, 0, VENDORS.length - 1)]!.name, date]);
  }
  listed.sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
  const numbers = (keep: (i: Invoice) => boolean) =>
    base
      .filter(keep)
      .map((i) => i.no)
      .sort()
      .join(',');
  return {
    key: 'missing_po',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(base)],
      ['fixtures/purchase_orders.csv', csv(['po_number', 'vendor_name', 'raised_on'], listed)],
    ]),
    reference: { missing_po: numbers((i) => i.po === '' || unknown.has(i.po)) },
    trap: {
      answer: { missing_po: numbers((i) => i.po === '') },
      note: 'only the empty PO numbers listed',
    },
    phrase: 'Which invoices are not backed by a purchase order?',
    reads: ['invoices.csv', 'purchase_orders.csv'],
    baselineTrapped: false,
  };
}

export function lateFees(base: readonly Invoice[]): Task {
  const r = taskRng('late_fees');
  const rows = copyLedger(base);
  const today = day(FEES_TODAY);
  const inGrace = (i: Invoice) => i.due < today && today - i.due <= FEE.graceDays;
  if (!rows.some((i) => i.status === 'open' && inGrace(i))) {
    const late = pick(
      r,
      rows.filter((i) => i.status === 'open' && i.due < today),
      1,
    )[0]!;
    late.due = today - int(r, 3, FEE.graceDays);
    late.date = late.due - 30;
  }
  const open = rows.filter((i) => i.status === 'open' && i.due < today);
  const fees = new Map<string, number>();
  const naive = new Map<string, number>();
  for (const i of open) {
    const days = today - i.due;
    naive.set(i.no, Math.round((i.cents * FEE.dailyBp * days) / 10000));
    if (days <= FEE.graceDays) continue;
    const fee = divRound(i.cents * FEE.dailyBp * (days - FEE.graceDays), 10000, `fee ${i.no}`);
    fees.set(i.no, Math.min(FEE.capCents, fee));
  }
  check(
    [...fees.values()].includes(FEE.capCents) && open.some(inGrace),
    'late_fees needs an invoice at the cap and one inside the grace period',
  );
  const total = (m: Map<string, number>) => eur([...m.values()].reduce((s, f) => s + f, 0));
  const reference = { late_fees: amounts(fees), total_late_fees: total(fees) };
  const prompt =
    "Your working directory contains `invoices.csv`, our accounts-payable ledger, and `policy_terms.json`, our vendors' standard terms. Every amount is in EUR.\n\n" +
    `Today is ${FEES_TODAY}. Vendors charge late fees on \`open\` invoices we have not paid by their due date, under the late fee terms in \`policy_terms.json\`. \`disputed\` invoices are on hold and accrue no fee, and \`paid\` invoices are settled.\n\n` +
    'Which open invoices owe a late fee today, and how much do the fees come to? List only invoices whose fee is above zero, each fee rounded to the cent.\n\n' +
    promptTail('{ "late_fees": { "INV-00000000": 0.0 }, "total_late_fees": 0.0 }');
  return {
    key: 'late_fees',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['fixtures/policy_terms.json', jsonFile(POLICY)],
      ['prompt.md', prompt],
      ['verify/expected_fees.json', jsonFile({ late_fees: reference.late_fees })],
    ]),
    reference,
    trap: {
      answer: { late_fees: amounts(naive), total_late_fees: total(naive) },
      note: 'no grace period and no cap',
    },
    phrase: 'Which open invoices owe a late fee today',
    reads: ['invoices.csv', 'policy_terms.json'],
    baselineTrapped: true,
  };
}

export function partialPay(base: readonly Invoice[]): Task {
  const r = taskRng('partial_pay');
  const invoices = pick(
    r,
    base.filter((i) => i.status === 'open'),
    5,
  );
  // The first invoice is paid twice, two weeks apart; together the payments stay below its amount.
  const payments = invoices.flatMap((invoice, k) =>
    range(0, k === 0 ? 1 : 0).map((n) => ({
      invoice,
      cents: Math.round((invoice.cents * int(r, 15, 40)) / 100),
      date: invoice.date + int(r, 5, 25) + n * 14,
    })),
  );
  payments.sort((x, y) => x.date - y.date || (x.invoice.no < y.invoice.no ? -1 : 1));
  const balances = (lastOnly: boolean) => {
    const left = new Map<string, number>();
    for (const p of payments) {
      const before = lastOnly ? p.invoice.cents : (left.get(p.invoice.no) ?? p.invoice.cents);
      left.set(p.invoice.no, before - p.cents);
    }
    return amounts(left);
  };
  const rows = payments.map((p, k) => [
    `PAY-${String(k + 1).padStart(4, '0')}`,
    p.invoice.no,
    isoDay(p.date),
    money(p.cents),
  ]);
  return {
    key: 'partial_pay',
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(base)],
      ['fixtures/payments.csv', csv(['payment_id', 'invoice_no', 'paid_on', 'amount'], rows)],
    ]),
    reference: { balances: balances(false) },
    trap: {
      answer: { balances: balances(true) },
      note: 'only the last of two payments on one invoice applied',
    },
    phrase: 'what balance is left to pay after its payments?',
    reads: ['invoices.csv', 'payments.csv'],
    baselineTrapped: true,
  };
}
