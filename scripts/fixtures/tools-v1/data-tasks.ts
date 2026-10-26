/**
 * The three tools-v1 tasks over CSV files: big_csv (20,000 rows), join_three
 * (three files joined) and small_lookup (the control). Each builds its
 * fixtures, computes its reference and its trap answer, and says how the
 * mock plays it (the construction of each trap is described in ../tools-v1.ts).
 */
import {
  check,
  codeMarker,
  csv,
  eur,
  firstPageLines,
  int,
  money,
  pickOne,
  prompt,
  pythonCommand,
  READ_FILE_LINES,
  shuffle,
  taskRng,
  termMarker,
  type ToolsTask,
} from './common.ts';

/** big_csv's size (plan 18.3). */
export const BIG_CSV_ROWS = 20_000;

export function bigCsv(): ToolsTask {
  const key = 'big_csv';
  const r = taskRng(key);
  const rows = Array.from({ length: BIG_CSV_ROWS }, (_, i) => {
    const roll = r();
    return {
      id: `T${String(i + 1).padStart(5, '0')}`,
      account: `A-${int(r, 1000, 1999)}`,
      cents: int(r, 50, 250_000),
      status: roll < 0.8 ? 'settled' : roll < 0.92 ? 'pending' : 'reversed',
    };
  });
  const text = csv(
    ['id', 'account', 'amount', 'status'],
    rows.map((t) => [t.id, t.account, money(t.cents), t.status]),
  );
  // One read_file call shows lines 1 to 2,000: the header and the first 1,999 rows.
  check(firstPageLines(text) === READ_FILE_LINES, 'big_csv: a first read must show 2,000 lines');
  const settled = (upTo: number) =>
    rows.slice(0, upTo).reduce((s, t) => s + (t.status === 'settled' ? t.cents : 0), 0);
  const firstPage = settled(READ_FILE_LINES - 1);
  const total = settled(rows.length);
  const python = (marker: string) =>
    [
      'import csv',
      "with open('/workspace/transactions.csv', newline='') as f:",
      "    cents = sum(round(float(r['amount']) * 100) for r in csv.DictReader(f) if r['status'] == 'settled')",
      `print('${marker}%d.%02d' % divmod(cents, 100))`,
    ].join('\n');
  const body = `
Your working directory contains \`transactions.csv\`, a card-payments export with one transaction per row after the header: ${BIG_CSV_ROWS.toLocaleString('en-US')} rows, with the columns \`id\`, \`account\`, \`amount\` (in EUR, two decimals) and \`status\` (\`settled\`, \`pending\` or \`reversed\`).

What is the total \`amount\` of the transactions whose \`status\` is \`settled\`, over every row of the file, in EUR, rounded to the cent?`;
  return {
    key,
    files: new Map([
      ['fixtures/transactions.csv', text],
      ['prompt.md', prompt(key, body, '{ "settled_total": 0.0 }')],
    ]),
    reference: { settled_total: eur(total) },
    trap: {
      answer: { settled_total: eur(firstPage) },
      note: 'only the 1,999 rows of the first read_file page summed',
    },
    tools: {
      code: python(codeMarker(key)),
      command: `awk -F, 'NR > 1 && $4 == "settled" { s += $3 } END { printf "${termMarker(key)}%.2f\\n", s }' /workspace/transactions.csv`,
      value: money(total),
    },
    fileOnly: {
      reads: ['transactions.csv'],
      text: 'I read transactions.csv with read_file and added up the settled rows it showed.',
      answer: { settled_total: eur(firstPage) },
    },
  };
}

const COUNTRIES = ['ES', 'PT', 'FR', 'DE', 'IT', 'NL'] as const;
const NAME_PARTS = {
  first: ['Alba', 'Brisa', 'Cumbre', 'Duna', 'Estela', 'Faro', 'Garza', 'Hiedra', 'Isla', 'Jara'],
  second: ['Foods', 'Retail', 'Hotels', 'Labs', 'Studio', 'Market', 'Partners', 'Works'],
};

export function joinThree(): ToolsTask {
  const key = 'join_three';
  const r = taskRng(key);
  const customers = Array.from({ length: 120 }, (_, i) => ({
    id: `C-${1001 + i}`,
    name: `${pickOne(r, NAME_PARTS.first)} ${pickOne(r, NAME_PARTS.second)}`,
    country: r() < 0.22 ? 'ES' : pickOne(r, COUNTRIES.slice(1)),
  }));
  const products = Array.from({ length: 60 }, (_, i) => ({
    sku: `P-${3001 + i}`,
    cents: int(r, 250, 48_000),
  }));
  // Eight products changed price: the old row stays in prices.csv with active = no.
  const changed = new Set(
    shuffle(r, products)
      .slice(0, 8)
      .map((p) => p.sku),
  );
  const priceRows = products.flatMap((p) => {
    const current = [p.sku, money(p.cents), 'yes'];
    if (!changed.has(p.sku)) return [current];
    const old = [p.sku, money(Math.round((p.cents * int(r, 80, 95)) / 100)), 'no'];
    return r() < 0.5 ? [old, current] : [current, old];
  });
  const lines: { order: string; customer: string; sku: string; qty: number }[] = [];
  for (let n = 0; lines.length < 900; n++) {
    const customer = pickOne(r, customers).id;
    const order = `O-${50001 + n}`;
    for (let k = int(r, 1, 4); k > 0 && lines.length < 900; k--) {
      lines.push({ order, customer, sku: pickOne(r, products).sku, qty: int(r, 1, 24) });
    }
  }
  const countryOf = new Map(customers.map((c) => [c.id, c.country]));
  const priceOf = new Map(products.map((p) => [p.sku, p.cents]));
  const rowsOf = (sku: string) => priceRows.filter((row) => row[0] === sku);
  const spanish = lines.filter((l) => countryOf.get(l.customer) === 'ES');
  check(
    spanish.filter((l) => changed.has(l.sku)).length >= 3,
    'join_three needs Spanish order lines of products that changed price',
  );
  const total = spanish.reduce((s, l) => s + l.qty * priceOf.get(l.sku)!, 0);
  // The trap: joined on sku alone, each line counts once per price row of its product.
  const fanOut = spanish.reduce(
    (s, l) => s + rowsOf(l.sku).reduce((t, row) => t + l.qty * Math.round(Number(row[1]) * 100), 0),
    0,
  );
  const python = (marker: string) =>
    [
      'import csv',
      'def rows(name):',
      "    with open('/workspace/' + name, newline='') as f:",
      '        return list(csv.DictReader(f))',
      "country = {c['customer_id']: c['country'] for c in rows('customers.csv')}",
      "price = {p['sku']: round(float(p['unit_price']) * 100) for p in rows('prices.csv') if p['active'] == 'yes'}",
      "cents = sum(int(o['quantity']) * price[o['sku']] for o in rows('orders.csv') if country[o['customer_id']] == 'ES')",
      `print('${marker}%d.%02d' % divmod(cents, 100))`,
    ].join('\n');
  const body = `
Your working directory contains three files from our order system:

- \`orders.csv\`: order lines, with \`order_id\`, \`customer_id\`, \`sku\` and \`quantity\`;
- \`customers.csv\`: our customers, with \`customer_id\`, \`name\` and \`country\` (a two-letter country code);
- \`prices.csv\`: unit prices in EUR, with \`sku\`, \`unit_price\` and \`active\`. When a price changes, the old row stays in the file with \`active\` set to \`no\`; the current price is the row whose \`active\` is \`yes\`, and every SKU has exactly one.

What is the total value of the order lines placed by customers whose \`country\` is \`ES\`, in EUR, rounded to the cent? An order line's value is its \`quantity\` times the current unit price of its \`sku\`.`;
  return {
    key,
    files: new Map([
      [
        'fixtures/orders.csv',
        csv(
          ['order_id', 'customer_id', 'sku', 'quantity'],
          lines.map((l) => [l.order, l.customer, l.sku, String(l.qty)]),
        ),
      ],
      [
        'fixtures/customers.csv',
        csv(
          ['customer_id', 'name', 'country'],
          customers.map((c) => [c.id, c.name, c.country]),
        ),
      ],
      ['fixtures/prices.csv', csv(['sku', 'unit_price', 'active'], priceRows)],
      ['prompt.md', prompt(key, body, '{ "total_eur": 0.0 }')],
    ]),
    reference: { total_eur: eur(total) },
    trap: {
      answer: { total_eur: eur(fanOut) },
      note: 'joined on sku alone, so a line of a product that changed price counts at both prices',
    },
    tools: {
      code: python(codeMarker(key)),
      command: pythonCommand(python(termMarker(key))),
      value: money(total),
    },
    fileOnly: {
      reads: ['orders.csv', 'customers.csv', 'prices.csv'],
      text: 'I joined the three files by hand: each Spanish order line with the prices of its SKU.',
      answer: { total_eur: eur(fanOut) },
    },
  };
}

const ITEMS = [
  'Desk lamp',
  'Monitor arm',
  'Cable tray',
  'Footrest',
  'Whiteboard',
  'Paper shredder',
  'Label printer',
  'Headset',
  'Webcam',
  'Laptop stand',
  'Filing cabinet',
  'Task chair',
];
const UNITS = ['each', 'pack of 10', 'box of 5', 'pair'];

export function smallLookup(): ToolsTask {
  const key = 'small_lookup';
  const r = taskRng(key);
  const codes = shuffle(
    r,
    Array.from({ length: 9000 }, (_, i) => `PX-${1000 + i}`),
  ).slice(0, 38);
  // Shelves A-01-1 to H-24-6; A-01-1, the first in shelf order, is the decoy's.
  const shelves = [...'ABCDEFGH'].flatMap((aisle) =>
    Array.from({ length: 24 * 6 }, (_, i) =>
      [aisle, String(Math.floor(i / 6) + 1).padStart(2, '0'), String((i % 6) + 1)].join('-'),
    ),
  );
  const bins = shuffle(r, shelves.slice(1));
  const target = codes[0]!;
  const rows = codes.map((code, i) => ({
    code,
    name: pickOne(r, ITEMS),
    unit: pickOne(r, UNITS),
    bin: bins[i]!,
  }));
  const own = rows[0]!;
  // The refurbished variant: the same code with -R, listed first, as the catalog is in shelf order.
  const decoy = { ...own, code: `${target}-R`, name: `${own.name} refurbished`, bin: shelves[0]! };
  const listed = [...rows, decoy].sort((a, b) => (a.bin < b.bin ? -1 : 1));
  check(listed[0] === decoy, 'small_lookup: the decoy must be the first row');
  const line = (x: typeof own) => [x.code, x.name, x.unit, x.bin];
  const body = `
Your working directory contains \`catalog.csv\`, our product catalog, with the columns \`code\`, \`name\`, \`unit\` and \`bin\` (the shelf where the product is stored in the warehouse).

In which bin is the product whose code is exactly \`${target}\` stored? Give the bin as \`catalog.csv\` writes it.`;
  return {
    key,
    files: new Map([
      ['fixtures/catalog.csv', csv(['code', 'name', 'unit', 'bin'], listed.map(line))],
      ['prompt.md', prompt(key, body, '{ "bin": "A-00-0" }')],
    ]),
    reference: { bin: own.bin },
    trap: {
      answer: { bin: decoy.bin },
      note: `the bin of ${decoy.code}, the first row a search for ${target} finds`,
    },
    tools: null,
    fileOnly: {
      reads: ['catalog.csv'],
      text: `I could not find ${target} in the catalog.`,
      answer: { bin: null },
    },
    readPhrase: line(own).join(','),
  };
}
