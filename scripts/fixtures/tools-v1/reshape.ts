/**
 * tools-v1's reshape_json: a nested stock export (warehouses → bins →
 * items) turned into one entry per SKU. It builds the export, the expected
 * workspace, the verifier's expected values and the task's task.yaml (whose
 * primary schema holds every expected entry), and says how the mock plays
 * it (the construction of the trap is described in ../tools-v1.ts).
 */
import {
  check,
  codeMarker,
  firstPageLines,
  int,
  json,
  jsonFile,
  prompt,
  pythonCommand,
  shuffle,
  taskRng,
  termMarker,
  type Json,
  type JsonObject,
  type Rng,
  type ToolsTask,
} from './common.ts';

/** SKUs every warehouse may stock, and the ones only the last warehouse holds. */
export const SHARED_SKUS = 100;
export const DUB_ONLY_SKUS = 20;
export const WAREHOUSES = ['AMS', 'BCN', 'DUB'] as const;
const BINS = 20;
/** DUB's last bins hold the SKUs only DUB stocks. */
const DUB_ONLY_BINS = 4;
export const STOCK_FILE = 'stock_by_sku.json';

type Item = { sku: string; qty: number };
type Bin = { bin: string; items: Item[] };

/** One warehouse's bins: SKUs dealt from a shuffled deck of its pool, distinct within a bin. */
function fill(r: Rng, code: string, from: number, to: number, pool: readonly string[]): Bin[] {
  let deck: string[] = [];
  return Array.from({ length: to - from }, (_, b) => {
    const items: Item[] = [];
    for (let n = int(r, 6, 10); items.length < n;) {
      if (deck.length === 0) deck = shuffle(r, pool);
      const sku = deck.pop()!;
      if (items.some((i) => i.sku === sku)) continue;
      items.push({ sku, qty: int(r, 1, 40) });
    }
    return { bin: `${code}-${String(from + b + 1).padStart(2, '0')}`, items };
  });
}

type Stock = Map<string, { total: number; warehouses: Map<string, number> }>;

/** A JSON value as prettier prints a YAML flow mapping: `{ total: 7, warehouses: { AMS: 5 } }`. */
function flow(value: Json): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    check(typeof value === 'number', 'reshape_json: a schema value is not a number');
    return String(value);
  }
  const pairs = Object.entries(value).map(([k, v]) => {
    check(/^[A-Za-z][A-Za-z0-9-]*$/.test(k), `reshape_json: ${k} is not a plain YAML key`);
    return `${k}: ${flow(v)}`;
  });
  return `{ ${pairs.join(', ')} }`;
}

/**
 * reshape_json's task.yaml. The primary file_check's schema holds every
 * SKU's expected entry as a `const` (and refuses any other key), so a file
 * of the right shape with a wrong quantity fails the primary key, not only
 * the verifier: a sum the file tools make hard is what the experiment
 * compares. Written here because the schema is computed from inventory.json.
 */
function taskYaml(expected: JsonObject): string {
  const skus = Object.keys(expected);
  return [
    '# Written by scripts/fixtures/tools-v1.ts (tools-v1/reshape.ts), never by hand: the primary',
    "# file_check's schema holds every SKU's entry, computed from fixtures/inventory.json.",
    'summary: Reshape a nested stock export into one entry per SKU, written to a file',
    'limits:',
    '  max_turns: 20',
    '  run_budget_seconds: 300',
    '  toolsets_needed: [file]',
    'answer:',
    '  format: fenced_json',
    'verification:',
    '  - key: stock_file',
    '    type: file_check',
    '    primary: true',
    '    params:',
    `      path: ${STOCK_FILE}`,
    '      format: json',
    '      json_schema:',
    '        type: object',
    '        required:',
    ...skus.map((sku) => `          - ${sku}`),
    '        additionalProperties: false',
    '        properties:',
    ...skus.map((sku) => `          ${sku}: ${flow({ const: expected[sku]! })}`),
    '  - key: quantities',
    '    type: verifier_script',
    '    params: { script: check_stock.py, timeout_s: 30 }',
    'self_check:',
    '  expected_workspace: expected',
    '  negative_control: true',
    '',
  ].join('\n');
}

function add(stock: Stock, sku: string, warehouse: string, qty: number): void {
  const entry = stock.get(sku) ?? { total: 0, warehouses: new Map<string, number>() };
  entry.total += qty;
  entry.warehouses.set(warehouse, (entry.warehouses.get(warehouse) ?? 0) + qty);
  stock.set(sku, entry);
}

/** The output file's object: SKUs in order, each warehouse in WAREHOUSES order. */
const stockJson = (stock: Stock): JsonObject =>
  Object.fromEntries(
    [...stock.keys()].sort().map((sku) => {
      const entry = stock.get(sku)!;
      const warehouses = WAREHOUSES.filter((w) => entry.warehouses.has(w));
      return [
        sku,
        {
          total: entry.total,
          warehouses: Object.fromEntries(warehouses.map((w) => [w, entry.warehouses.get(w)!])),
        },
      ];
    }),
  );

export function reshapeJson(): ToolsTask {
  const key = 'reshape_json';
  const r = taskRng(key);
  const skus = shuffle(
    r,
    Array.from({ length: SHARED_SKUS + DUB_ONLY_SKUS }, (_, i) => `SKU-${10001 + i}`),
  );
  const shared = skus.slice(0, SHARED_SKUS);
  const dubOnly = skus.slice(SHARED_SKUS);
  const warehouses = WAREHOUSES.map((code) => ({
    code,
    bins:
      code === 'DUB'
        ? [
            ...fill(r, code, 0, BINS - DUB_ONLY_BINS, shared),
            ...fill(r, code, BINS - DUB_ONLY_BINS, BINS, dubOnly),
          ]
        : fill(r, code, 0, BINS, shared),
  }));
  const text = jsonFile({ exported_at: '2026-10-20T06:00:00Z', warehouses });

  // Each item's qty line, read back from the printed file, decides whether one read_file call shows it.
  const page = firstPageLines(text);
  const lines = text.split('\n');
  const all: Stock = new Map();
  const seen: Stock = new Map();
  let warehouse = '';
  let sku = '';
  lines.forEach((line, i) => {
    const field = /^\s*"(code|sku|qty)": "?([^",]+)"?,?$/.exec(line);
    if (!field) return;
    if (field[1] === 'code') warehouse = field[2]!;
    else if (field[1] === 'sku') sku = field[2]!;
    else {
      add(all, sku, warehouse, Number(field[2]));
      if (i + 1 <= page) add(seen, sku, warehouse, Number(field[2]));
    }
  });
  const items = warehouses.flatMap((w) => w.bins.flatMap((b) => b.items));
  check(
    all.size === skus.length &&
      items.reduce((s, i) => s + i.qty, 0) === [...all.values()].reduce((s, e) => s + e.total, 0),
    'reshape_json: the export does not read back as it was built',
  );
  const unseen = dubOnly.filter((s) => !seen.has(s));
  check(
    lines.length - 1 > page && unseen.length >= 10,
    'reshape_json: the first read must miss SKUs',
  );
  // A SKU in several bins of one warehouse: its quantities are summed, never overwritten.
  const repeated = [...all.keys()].filter((s) =>
    warehouses.some((w) => w.bins.filter((b) => b.items.some((i) => i.sku === s)).length > 1),
  );
  check(repeated.length >= 5, 'reshape_json needs SKUs held in several bins of one warehouse');

  const expected = stockJson(all);
  const python = (marker: string) =>
    [
      'import json',
      "with open('/workspace/inventory.json') as f:",
      '    export = json.load(f)',
      'stock = {}',
      "for warehouse in export['warehouses']:",
      "    for b in warehouse['bins']:",
      "        for item in b['items']:",
      "            entry = stock.setdefault(item['sku'], {'total': 0, 'warehouses': {}})",
      "            entry['total'] += item['qty']",
      "            held = entry['warehouses']",
      "            held[warehouse['code']] = held.get(warehouse['code'], 0) + item['qty']",
      `with open('/workspace/${STOCK_FILE}', 'w') as f:`,
      '    json.dump(dict(sorted(stock.items())), f, indent=2)',
      `print('${marker}%d:%d' % (len(stock), sum(e['total'] for e in stock.values())))`,
    ].join('\n');
  const units = [...all.values()].reduce((s, e) => s + e.total, 0);
  const trapFile = jsonFile(stockJson(seen));
  const body = `
Your working directory contains \`inventory.json\`, our stock export: a list of warehouses, each with its bins, and in each bin the items it holds, each a stock-keeping unit (\`sku\`) and a quantity (\`qty\`). One SKU can sit in several bins, of one warehouse or of several.

Write \`${STOCK_FILE}\` in the working directory: one JSON object with an entry for every SKU in \`inventory.json\`, keyed by the SKU exactly as the export writes it. Each entry is an object with exactly two keys:

- \`total\`: the SKU's quantity over every bin of every warehouse, as an integer;
- \`warehouses\`: an object with one key per warehouse that holds the SKU, its \`code\`, giving the SKU's quantity over all of that warehouse's bins.

For example, a SKU with 5 units in two bins of AMS and 2 in one bin of DUB:

\`\`\`json
${json({ 'SKU-00000': { total: 7, warehouses: { AMS: 5, DUB: 2 } } })}
\`\`\``;
  return {
    key,
    files: new Map([
      ['fixtures/inventory.json', text],
      ['task.yaml', taskYaml(expected)],
      [`expected/${STOCK_FILE}`, jsonFile(expected)],
      ['verify/expected_stock.json', jsonFile(expected)],
      [
        'prompt.md',
        prompt(
          key,
          body,
          `{ "stock_file": "${STOCK_FILE}", "skus": 0 }`,
          'End your reply with a fenced JSON block naming the file and its number of SKUs, exactly in this shape:',
        ),
      ],
    ]),
    reference: { stock_file: STOCK_FILE, skus: all.size },
    trap: {
      answer: { stock_file: STOCK_FILE, skus: seen.size },
      files: { [STOCK_FILE]: trapFile },
      note: `written from the first read_file page of inventory.json, so ${unseen.length} SKUs only DUB holds are missing`,
    },
    tools: {
      code: python(codeMarker(key)),
      command: pythonCommand(python(termMarker(key))),
      value: `${all.size}:${units}`,
    },
    fileOnly: {
      reads: ['inventory.json'],
      // The same content written compactly, which keeps the mock scripts small (MOCK_SCRIPTS is one variable).
      writes: { [STOCK_FILE]: `${JSON.stringify(stockJson(seen))}\n` },
      text: `I wrote ${STOCK_FILE} from the export as read_file showed it.`,
      answer: { stock_file: STOCK_FILE, skus: seen.size },
    },
  };
}
