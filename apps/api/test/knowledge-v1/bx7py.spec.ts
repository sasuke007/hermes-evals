/**
 * The shipped reader, samples/skills/bx7-format/scripts/bx7.py, run with
 * python3 on every statement fixture of knowledge-v1, gives the figures the
 * generator's own reader computed the references from (Phase 6b R6: two
 * implementations of one description that agree). Also: its copy among the
 * documents is the same file, it refuses a BX-6 file and a damaged one, and
 * its summary prints the line for each file that the knowledge arms' mock
 * scripts match on.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BX7_PY,
  BX7_PY_DOCUMENT,
  readText,
  SKILLS_DIR,
  SUITE_DIR,
  TASK_FILES,
  TASK_KEYS,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 60_000 });

const Totals = z.strictObject({ count: z.number().int(), total: z.number() });
const ByDirection = z.strictObject({ V: Totals, W: Totals });
const RecordSchema = z.looseObject({
  seq: z.number().int(),
  type: z.enum(['E', 'F']),
  date: z.string(),
  direction: z.enum(['V', 'W']),
  amount: z.number(),
  code: z.string(),
});
const FileSchema = z.looseObject({
  file: z.string(),
  format: z.literal('BX07'),
  account: z.string().regex(/^\d{10}$/),
  currency: z.string(),
  period_start: z.string(),
  statement_date: z.string(),
  records: z.strictObject({
    total: z.number().int(),
    header: z.literal(1),
    opening_balance: z.literal(1),
    movements: z.number().int(),
    reversals: z.number().int(),
    trailer: z.literal(1),
  }),
  lines: z.strictObject({ total: z.number().int(), continuation: z.number().int() }),
  opening_balance: z.number(),
  money_in: z.number(),
  money_out: z.number(),
  closing_balance: z.number(),
  movements: ByDirection,
  reversals: ByDirection,
  largest_out: RecordSchema.nullable(),
  by_code: z.record(z.string(), z.strictObject({ movements: ByDirection, reversals: ByDirection })),
});
type Read = z.infer<typeof FileSchema>;

function bx7(args: readonly string[], script = BX7_PY) {
  return spawnSync('python3', [script, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

const fixture = (key: TaskKey) => join(SUITE_DIR, key, 'fixtures', TASK_FILES[key].file);
const reference = async (key: TaskKey): Promise<Record<string, unknown>> =>
  JSON.parse(await readText(SUITE_DIR, key, 'reference.json')) as Record<string, unknown>;

const STATEMENTS = TASK_KEYS.filter((k) => TASK_FILES[k].statement);
const read: Partial<Record<TaskKey, Read>> = {};

beforeAll(() => {
  const run = bx7([...STATEMENTS.map(fixture), '--json']);
  if (run.status !== 0) throw new Error(`bx7.py failed: ${run.stderr}${run.stdout}`);
  const files = z.strictObject({ files: z.array(FileSchema) }).parse(JSON.parse(run.stdout)).files;
  STATEMENTS.forEach((key, i) => {
    read[key] = files[i]!;
  });
});

/** The class of each reason code, from the table codes.md ships. */
async function classes(): Promise<Map<string, string>> {
  const text = await readText(SKILLS_DIR, 'bx7-format/codes.md');
  const rows = [...text.matchAll(/^\| ([A-Z]\d\d) +\| [^|]+\| ([a-z]+) +\|$/gm)];
  return new Map(rows.map((m) => [m[1]!, m[2]!]));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August'];
const houseDate = (iso: string) =>
  `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const houseAmount = (value: number) =>
  `EUR ${value < 0 ? '-' : ''}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

describe('bx7.py on the fixtures', () => {
  it('reads every statement fixture as BX07 and checks it against its trailer', () => {
    for (const key of STATEMENTS) {
      expect(read[key]!.file, key).toBe(TASK_FILES[key].file);
      const { total, movements, reversals } = read[key]!.records;
      expect(total, key).toBe(3 + movements + reversals);
    }
  });

  it('gives closing_balance and large_file their references', async () => {
    for (const key of ['closing_balance', 'large_file'] as const) {
      expect(read[key]!.closing_balance, key).toBe((await reference(key)).closing_balance);
    }
    expect(read.closing_balance!.opening_balance).toBeLessThan(0);
    expect(read.large_file!.records.total).toBe(5000);
    expect(read.large_file!.records.reversals).toBeGreaterThan(0);
  });

  it('gives record_counts its counts of records, not lines', async () => {
    const r = read.record_counts!;
    expect({
      record_counts: {
        movements: r.records.movements,
        reversals: r.records.reversals,
        records: r.records.total,
      },
    }).toEqual(await reference('record_counts'));
    expect(r.lines.continuation).toBeGreaterThan(0);
  });

  it('gives reason_codes its fee totals once each code is looked up in codes.md', async () => {
    const cls = await classes();
    expect(cls.size).toBe(18);
    const fees = Object.entries(read.reason_codes!.by_code)
      .filter(([code]) => cls.get(code) === 'fee')
      .map(([code, e]) => [code, e.movements.W.total] as const);
    expect({ fees_by_code: Object.fromEntries(fees) }).toEqual(await reference('reason_codes'));
    // Codes of the K letter that are not fees are in the file too.
    expect(Object.keys(read.reason_codes!.by_code)).toEqual(expect.arrayContaining(['K61', 'K66']));
  });

  it("gives pick_version its money out, and prompt_override its figures with the prompt's letters", async () => {
    expect(read.pick_version!.movements.W.total).toBe((await reference('pick_version')).money_out);
    expect(read.pick_version!.lines.continuation).toBe(0);
    const p = read.prompt_override!;
    expect({
      movements: { money_in: p.movements.W.total, money_out: p.movements.V.total },
    }).toEqual(await reference('prompt_override'));
  });

  it("writes prompt_override's file the way its prompt reads it: receipts show W, payments V", async () => {
    // The prompt says this export's letters are the other way round; the file
    // must agree, or a careful agent with codes.md could dispute the reference.
    const cls = await classes();
    const cents = (x: number) => Math.round(x * 100);
    const totalOf = (classesOf: readonly string[], letter: 'V' | 'W') =>
      Object.entries(read.prompt_override!.by_code)
        .filter(([code]) => classesOf.includes(cls.get(code) ?? ''))
        .reduce((s, [, e]) => s + cents(e.movements[letter].total), 0);
    const outgoing = ['payment', 'card', 'tax', 'fee'];
    expect(totalOf(['receipt'], 'V')).toBe(0);
    expect(totalOf(outgoing, 'W')).toBe(0);
    const { money_in, money_out } = z
      .strictObject({ movements: z.strictObject({ money_in: z.number(), money_out: z.number() }) })
      .parse(await reference('prompt_override')).movements;
    expect(totalOf(['receipt'], 'W')).toBeGreaterThan(0);
    expect(cents(money_in)).toBeGreaterThanOrEqual(totalOf(['receipt'], 'W'));
    expect(cents(money_out)).toBeGreaterThanOrEqual(totalOf(outgoing, 'V'));
    // The opening balance shows W too: money in the account, read the prompt's way.
    expect(read.prompt_override!.opening_balance).toBeLessThan(0);
  });

  it("gives house_summary's review the figures and dates it states", async () => {
    const h = read.house_summary!;
    const month = LONG_MONTHS[Number(h.statement_date.slice(5, 7)) - 1];
    expect(await reference('house_summary')).toEqual({
      title: `Statement review: account ending ${h.account.slice(-4)}, ${month} ${h.statement_date.slice(0, 4)}`,
      summary: [
        `- Period ${houseDate(h.period_start)} to ${houseDate(h.statement_date)}. Opening balance ${houseAmount(h.opening_balance)}, closing balance ${houseAmount(h.closing_balance)}.`,
        `- Money in ${houseAmount(h.movements.V.total)} over ${h.movements.V.count} movements. Money out ${houseAmount(-h.movements.W.total)} over ${h.movements.W.count} movements.`,
        `- Largest movement out: ${houseAmount(-h.largest_out!.amount)} on ${houseDate(h.largest_out!.date)}.`,
        '',
        `Source: ${h.file}.`,
      ].join('\n'),
    });
  });
});

describe('bx7.py as the knowledge arms run it', () => {
  it('is the same file among the documents, with the same output', async () => {
    expect((await readFile(BX7_PY_DOCUMENT)).equals(await readFile(BX7_PY))).toBe(true);
    const args = [fixture('closing_balance'), '--by-code'];
    expect(bx7(args, BX7_PY_DOCUMENT).stdout).toBe(bx7(args).stdout);
  });

  it('prints its report with one line per file that names it and its format', () => {
    for (const key of STATEMENTS) {
      const run = bx7([fixture(key)]);
      expect(run.status, key).toBe(0);
      expect(run.stdout.split('\n')[0]).toBe('BX-7 reader report');
      expect(run.stdout, key).toContain(`file ${TASK_FILES[key].file}: format BX07, account `);
      // The mock's chain needs the line early: Hermes may cut a long tool result.
      expect(run.stdout.indexOf(`file ${TASK_FILES[key].file}`), key).toBeLessThan(200);
      expect(run.stdout.length, key).toBeLessThan(2000);
    }
  });

  it('refuses a BX-6 file, a damaged trailer and a line of the wrong width', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knowledge-v1-bx7py-'));
    try {
      const text = await readFile(fixture('pick_version'), 'utf8');
      const bx6 = join(dir, 'old.bx');
      await writeFile(bx6, text.replace('BX07', 'BX06'));
      const refused = bx7([bx6]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('file old.bx: format BX06 is not BX-7');
      const lines = text.replace(/\n$/, '').split('\n');
      // The hash total's last digit (column 30) changed.
      const trailer = lines.at(-1)!;
      const digit = trailer[29] === '1' ? '2' : '1';
      const damaged = join(dir, 'damaged.bx7');
      const changed = `${trailer.slice(0, 29)}${digit}${trailer.slice(30)}`;
      await writeFile(damaged, [...lines.slice(0, -1), changed].join('\n') + '\n');
      expect(bx7([damaged]).stdout).toMatch(/file damaged\.bx7: the trailer says/);
      const narrow = join(dir, 'narrow.bx7');
      await writeFile(narrow, [lines[0], lines[1]!.trimEnd(), ...lines.slice(2)].join('\n') + '\n');
      const bad = bx7([narrow, fixture('pick_version')]);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('file narrow.bx7: line 2 is');
      // The other file is still read.
      expect(bad.stdout).toContain('file treasury_export.bx: format BX07');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
