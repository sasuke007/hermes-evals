/**
 * The five memory-v1 tasks that read a ledger and one fact from memory:
 * usual_currency, prompt_wins, vendor_alias, standing_exclusion and
 * data_wins. Each writes its fixtures, its seed (the persona and the task's
 * own entry, carrying the seed marker) and its prompt (carrying the prompt
 * marker), and computes its reference and its trap answer. How each trap
 * is built is described in ../memory-v1.ts.
 */
import {
  answerStep,
  check,
  csv,
  day,
  ensure,
  int,
  invoicesOf,
  isoDay,
  jsonFile,
  ledgerCsv,
  numbering,
  owedBy,
  pick,
  promptMarker,
  promptTail,
  reads,
  seeds,
  shuffle,
  taskRng,
  unpaid,
  VENDORS,
  withSeedMarker,
  type Invoice,
  type Json,
  type MemoryTask,
  type TaskKey,
} from './common.ts';

const EUR_LEDGER = 'Every amount is in EUR. An invoice is unpaid when its `status` is `open`.';

// ---------------------------------------------------------------------------
// usual_currency and prompt_wins: the ledger in three currencies
// ---------------------------------------------------------------------------

/** Units of each currency one GBP buys, times 10,000 (rates.json, exactly). */
const RATES = { GBP: 10000n, EUR: 11532n, USD: 13287n } as const;
type Currency = keyof typeof RATES;
const BILLING: Record<(typeof VENDORS)[number], Currency> = {
  'Ardent Couriers': 'GBP',
  'Brackenfield Paper': 'GBP',
  'Cindervale Software': 'USD',
  'Dunmore Catering': 'GBP',
  'Elmshade Cleaning': 'GBP',
  'Fennick Electrical': 'EUR',
  'Gorsebank Freight': 'EUR',
  'Hollin Print Works': 'GBP',
};
const RATES_JSON: Json = {
  base_currency: 'GBP',
  quoted_on: '2026-10-20',
  convention: 'Each rate is how many units of the currency one GBP buys.',
  rates: Object.fromEntries(Object.entries(RATES).map(([c, v]) => [c, Number(v) / 10000])),
};

/**
 * The unpaid invoices converted one by one into `to` at RATES and added up
 * exactly (as fractions), then rounded once to the cent; an exact half cent
 * is refused, so no rounding convention can decide the reference.
 */
function unpaidIn(rows: readonly Invoice[], to: Currency): number {
  const den = RATES.GBP * RATES.EUR * RATES.USD;
  let num = 0n;
  for (const i of rows.filter(unpaid)) {
    num += (BigInt(i.cents) * RATES[to] * den) / RATES[i.currency as Currency];
  }
  const cents = num / den;
  const rest = num % den;
  check(rest * 2n !== den, `the ${to} total is exactly half a cent`);
  return Number(rest * 2n > den ? cents + 1n : cents) / 100;
}

function currencyLedger(key: TaskKey): Invoice[] {
  const r = taskRng(key);
  const next = numbering(key);
  const rows = VENDORS.flatMap((v) => invoicesOf(r, v, int(r, 2, 4), next, BILLING[v]));
  // Every currency has an unpaid invoice, so every conversion matters.
  for (const c of ['GBP', 'EUR', 'USD'] as const) {
    if (!rows.some((i) => unpaid(i) && i.currency === c)) {
      ensure(
        rows.filter((i) => i.currency === c),
        1,
      );
    }
  }
  return rows;
}

const CURRENCY_FILES =
  'Your working directory contains `invoices.csv`, our accounts-payable ledger, in which each invoice is in its own currency, and `rates.json`, the exchange rates on 2026-10-20: how many units of each currency one GBP buys.\n\n' +
  'An invoice is unpaid when its `status` is `open`.';
const CONVERT =
  'Convert each unpaid invoice at the rates in `rates.json`, add them up, and round the total once, to the cent.';
/** USER.md's reporting preference, as usual_currency and prompt_wins seed it. */
const REPORTS_IN_EUR =
  "Ines reports every total in EUR, the group's reporting currency, whatever currency the books are kept in.";

export function usualCurrency(): MemoryTask {
  const key = 'usual_currency';
  const rows = currencyLedger(key);
  const prompt =
    `${promptMarker(key)}.\n\n${CURRENCY_FILES}\n\n` +
    `What do we owe in total on unpaid invoices, in my usual reporting currency? ${CONVERT}\n\n` +
    promptTail('{ "currency": "XXX", "total": 0.0 }');
  const reference = { currency: 'EUR', total: unpaidIn(rows, 'EUR') };
  const gbp = { currency: 'GBP', total: unpaidIn(rows, 'GBP') };
  return {
    key,
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['fixtures/rates.json', jsonFile(RATES_JSON)],
      ['prompt.md', prompt],
      ...seeds([withSeedMarker(key, REPORTS_IN_EUR)], []),
    ]),
    reference,
    trap: {
      answer: gbp,
      note: 'no usual currency known, so the total stays in GBP, the base of the rates',
    },
    onSteps: [
      ...reads('invoices.csv', 'rates.json'),
      answerStep('You report in EUR, so I converted every unpaid invoice into EUR.', reference),
    ],
    offSteps: [
      ...reads('invoices.csv', 'rates.json'),
      answerStep(
        'I do not know your usual currency, so here is the total in GBP, the base of the rates.',
        gbp,
      ),
    ],
    offPasses: false,
  };
}

export function promptWins(): MemoryTask {
  const key = 'prompt_wins';
  const rows = currencyLedger(key);
  const prompt =
    `${promptMarker(key)}.\n\n${CURRENCY_FILES}\n\n` +
    'This figure is for our US auditors, so this time I need it in USD, whatever I usually report in. ' +
    `What do we owe in total on unpaid invoices, in USD? ${CONVERT}\n\n` +
    promptTail('{ "currency": "USD", "total": 0.0 }');
  const reference = { currency: 'USD', total: unpaidIn(rows, 'USD') };
  const eurTotal = { currency: 'EUR', total: unpaidIn(rows, 'EUR') };
  return {
    key,
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['fixtures/rates.json', jsonFile(RATES_JSON)],
      ['prompt.md', prompt],
      ...seeds([withSeedMarker(key, REPORTS_IN_EUR)], []),
    ]),
    reference,
    trap: {
      answer: eurTotal,
      note: 'the usual EUR from memory, against the prompt asking for USD',
    },
    onSteps: [
      ...reads('invoices.csv', 'rates.json'),
      answerStep(
        'You usually report in EUR, but this figure is for the US auditors, so it is in USD.',
        reference,
      ),
    ],
    offSteps: [...reads('invoices.csv', 'rates.json'), answerStep('The total in USD.', reference)],
    offPasses: true,
  };
}

// ---------------------------------------------------------------------------
// vendor_alias and standing_exclusion: one EUR ledger fact from memory
// ---------------------------------------------------------------------------

export const ALIAS = { name: 'Northmoor Trading Ltd', of: 'Brackenfield Paper' } as const;
const COUNTRIES = ['GB', 'NL', 'IE', 'NL', 'BE', 'NL', 'GB', 'DE'];

export function vendorAlias(): MemoryTask {
  const key = 'vendor_alias';
  const r = taskRng(key);
  const next = numbering(key);
  const rows = VENDORS.flatMap((v) => invoicesOf(r, v, int(r, 2, 4), next));
  const own = rows.filter((i) => i.vendor === ALIAS.of);
  ensure(own, 1);
  const aliased = invoicesOf(r, ALIAS.name, 3, next);
  ensure(aliased, 2);
  rows.push(...aliased);
  const accounts = VENDORS.map((name, k) => [`V-${1001 + k}`, name, COUNTRIES[k]!]);
  const prompt =
    `${promptMarker(key)}.\n\n` +
    'Your working directory contains `invoices.csv`, our accounts-payable ledger, and `vendors.csv`, our vendor accounts. ' +
    `${EUR_LEDGER}\n\n` +
    'A vendor may bill us under more than one name; every invoice it sends counts toward its one account.\n\n' +
    'How much do we owe each vendor account on unpaid invoices? Give one entry per account in `vendors.csv` with at least one unpaid invoice, keyed by the account name there, each amount rounded to the cent.\n\n' +
    promptTail('{ "outstanding_by_vendor": { "Vendor name": 0.0 } }');
  const reference = {
    outstanding_by_vendor: owedBy(rows, (i) => (i.vendor === ALIAS.name ? ALIAS.of : i.vendor)),
  };
  const split = { outstanding_by_vendor: owedBy(rows, (i) => i.vendor) };
  const fact =
    `${ALIAS.name} is the name ${ALIAS.of} has billed under since its 2025 merger; ` +
    `invoices under either name belong to ${ALIAS.of}'s one vendor account.`;
  return {
    key,
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['fixtures/vendors.csv', csv(['account_id', 'name', 'country'], accounts)],
      ['prompt.md', prompt],
      ...seeds([], [withSeedMarker(key, fact)]),
    ]),
    reference,
    trap: { answer: split, note: `${ALIAS.name} kept as a vendor of its own` },
    onSteps: [
      ...reads('invoices.csv', 'vendors.csv'),
      answerStep(
        `${ALIAS.name} is ${ALIAS.of}'s other name, so its invoices count there.`,
        reference,
      ),
    ],
    offSteps: [
      ...reads('invoices.csv', 'vendors.csv'),
      answerStep(
        `${ALIAS.name} is in no account of vendors.csv, so it has an entry of its own.`,
        split,
      ),
    ],
    offPasses: false,
  };
}

export const INTERCOMPANY = 'Quellbrook Labs GmbH';

export function standingExclusion(): MemoryTask {
  const key = 'standing_exclusion';
  const r = taskRng(key);
  const next = numbering(key);
  const vendors = shuffle(r, [...VENDORS, INTERCOMPANY]);
  const rows = vendors.flatMap((v) => invoicesOf(r, v, int(r, 2, 4), next));
  ensure(
    rows.filter((i) => i.vendor === INTERCOMPANY),
    2,
  );
  const prompt =
    `${promptMarker(key)}.\n\n` +
    `Your working directory contains \`invoices.csv\`, our accounts-payable ledger. ${EUR_LEDGER}\n\n` +
    "I am putting together my payables report. Give me its vendor table: what we owe each vendor on unpaid invoices, one entry per vendor with at least one unpaid invoice, keyed by the vendor's name, each amount rounded to the cent, following my usual conventions for this report.\n\n" +
    promptTail('{ "payables": { "Vendor name": 0.0 } }');
  const reference = {
    payables: owedBy(
      rows.filter((i) => i.vendor !== INTERCOMPANY),
      (i) => i.vendor,
    ),
  };
  const all = { payables: owedBy(rows, (i) => i.vendor) };
  const preference =
    `Ines leaves ${INTERCOMPANY}, our sister company, out of her payables reports, ` +
    'since group treasury settles intercompany invoices.';
  return {
    key,
    files: new Map([
      ['fixtures/invoices.csv', ledgerCsv(rows)],
      ['prompt.md', prompt],
      ...seeds([withSeedMarker(key, preference)], []),
    ]),
    reference,
    trap: { answer: all, note: `${INTERCOMPANY}, the intercompany vendor, left in the report` },
    onSteps: [
      ...reads('invoices.csv'),
      answerStep(`As usual, ${INTERCOMPANY} is left out: group treasury settles it.`, reference),
    ],
    offSteps: [...reads('invoices.csv'), answerStep('Every vendor with unpaid invoices.', all)],
    offPasses: false,
  };
}

// ---------------------------------------------------------------------------
// data_wins: last year's VAT rate in memory, this year's in the fixture
// ---------------------------------------------------------------------------

const VESSLAND = ['Brennholt Components', 'Marsk Tooling', 'Ulvsund Glassworks', 'Velgren Optics'];
/** The standard rate in basis points: what memory holds (last year's) and what applies now. */
const VAT = { remembered: 1900, current: 2200 };

/** cents × bp / 10,000 rounded to the cent; an exact half cent is refused. */
function vatOf(cents: number, bp: number): number {
  const num = cents * bp;
  const q = Math.floor(num / 10000);
  const rest = num - q * 10000;
  check(rest * 2 !== 10000, 'a VAT total is exactly half a cent');
  return (rest * 2 > 10000 ? q + 1 : q) / 100;
}

export function dataWins(): MemoryTask {
  const key = 'data_wins';
  const r = taskRng(key);
  const next = numbering(key);
  const rows = Array.from({ length: 12 }, () => ({
    no: next(),
    vendor: pick(r, VESSLAND, 1)[0]!,
    date: day('2026-07-01') + int(r, 0, 91),
    cents: int(r, 40000, 1200000),
  })).sort((a, b) => a.date - b.date || (a.no < b.no ? -1 : 1));
  const net = rows.reduce((s, i) => s + i.cents, 0);
  const invoices = csv(
    ['invoice_no', 'vendor_name', 'invoice_date', 'net_amount', 'currency'],
    rows.map((i) => [i.no, i.vendor, isoDay(i.date), (i.cents / 100).toFixed(2), 'EUR']),
  );
  const rates: Json = {
    country: 'Vessland',
    tax: 'standard VAT rate',
    published_by: 'Vessland tax office',
    rates: [
      { applies_from: '2024-01-01', rate: VAT.remembered / 10000 },
      { applies_from: '2026-01-01', rate: VAT.current / 10000 },
    ],
  };
  const prompt =
    `${promptMarker(key)}.\n\n` +
    "Your working directory contains `invoices.csv`, this quarter's invoices from our vendors in Vessland with their net amounts in EUR, and `vat_rates.json`, the Vessland tax office's table of the standard VAT rate and the day each rate applies from.\n\n" +
    'Every invoice carries VAT at the standard rate in force on its invoice date.\n\n' +
    'How much VAT do these invoices carry in total? Round the total once, to the cent.\n\n' +
    promptTail('{ "vat_total": 0.0 }');
  const reference = { vat_total: vatOf(net, VAT.current) };
  const remembered = { vat_total: vatOf(net, VAT.remembered) };
  const fact = `Vessland's standard VAT rate is ${VAT.remembered / 100} %, as the Vessland tax office's table showed when checked in January 2025.`;
  return {
    key,
    files: new Map([
      ['fixtures/invoices.csv', invoices],
      ['fixtures/vat_rates.json', jsonFile(rates)],
      ['prompt.md', prompt],
      ...seeds([], [withSeedMarker(key, fact)]),
    ]),
    reference,
    trap: {
      answer: remembered,
      note: `last year's ${VAT.remembered / 100} % from memory instead of the table`,
    },
    onSteps: [
      ...reads('invoices.csv', 'vat_rates.json'),
      answerStep(
        `My notes say ${VAT.remembered / 100} %, but the table puts the rate at ${VAT.current / 100} % from 2026-01-01, which covers every invoice here.`,
        reference,
      ),
    ],
    offSteps: [
      ...reads('invoices.csv', 'vat_rates.json'),
      answerStep(`Every invoice is from 2026, at ${VAT.current / 100} %.`, reference),
    ],
    offPasses: true,
  };
}
