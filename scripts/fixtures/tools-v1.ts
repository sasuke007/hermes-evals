/**
 * Fixture generator of suites/tools-v1 (plan 18.3, Phase 6b): every fixture
 * of the six tasks, every prompt, every reference computed from the
 * fixtures, reshape_json's expected workspace and verifier data, and the
 * mock scripts of the recommended experiment. References are never typed by
 * hand, and re-running this file reproduces the same bytes.
 *
 *   node scripts/fixtures/tools-v1.ts                # rewrites the suite's generated files and the mock scripts
 *   node scripts/fixtures/tools-v1.ts --check        # exit 1 if a generated file on disk differs, or a stale one is left
 *   node scripts/fixtures/tools-v1.ts --out <dir>    # the same files under <dir> instead of the repo
 *   node scripts/fixtures/tools-v1.ts --traps <file> # also writes each task's trap answer (the tests use it)
 *
 * Plain Node (22.18 or newer strips the types): no enums, no parameter
 * properties, no dependency. One fixed seed (tools-v1/common.ts SEED) mixed
 * with each task's key drives a small PRNG, so changing one task leaves the
 * others' bytes alone. A construction a trap or a mock script relies on is
 * checked, and a seed that breaks one is refused.
 *
 * The suite measures toolsets (plan 18.3): the recommended arms are `file`,
 * `file` + `terminal`, and `file` + `terminal` + `code_execution`. What the
 * file tools alone cannot do in the pinned Hermes (v0.22.4): run code, and
 * see more of a file than one read_file call shows, at most 2,000 lines and
 * 100,000 characters (tools/file_tools.py; the agent pages on with
 * `offset`). Each task's trap, and how it is built:
 *
 * - big_csv: transactions.csv holds 20,000 rows (id, account, amount,
 *   status), 80 % settled. One read_file call shows lines 1 to 2,000 (checked:
 *   the line-numbered page stays under 100,000 characters), the header and
 *   1,999 rows. Trap: the settled total of those rows only.
 * - extract_ibans: payouts.log holds 300 lines; 24 valid IBANs (one or more
 *   per country of ten, each mentioned one to three times, four only in
 *   print format, in double quotes) and six IBAN-shaped strings that the
 *   prompt's definition rejects: five with one digit of the account part
 *   changed (the mod-97 check digits catch any single-digit change) and one
 *   German IBAN a digit short whose check digits pass (only the length rule
 *   catches it). No other line holds two capitals followed by two digits.
 *   Trap: every IBAN-shaped string, unvalidated.
 * - reshape_json: inventory.json nests 3 warehouses × 20 bins × 6 to 10 items
 *   (2,308 lines as printed); 100 SKUs may sit in any warehouse, 20
 *   only in DUB's last four bins, which lie past line 2,000; SKUs repeat
 *   across bins of one warehouse, so quantities must be summed. Trap:
 *   stock_by_sku.json written from the first read_file page, so at least
 *   ten DUB-only SKUs are missing. The primary file_check's schema holds
 *   every SKU's expected entry as a `const`, so a missing SKU and a
 *   quantity overwritten instead of summed both fail it; the verifier
 *   scores the share of right entries.
 * - checksum: export.csv (180 payments) beside SHA256SUMS, which lists the
 *   digest of the previous export (three rows fewer, one amount different),
 *   as the prompt says. Trap: that stale digest. With the file tools alone
 *   the honest answer is null, which fails too (plan 18.3).
 * - join_three: orders.csv (900 order lines), customers.csv (120 customers,
 *   about a fifth in ES) and prices.csv (60 SKUs; eight changed price and
 *   keep their old row with active = no, before or after the current one).
 *   Trap: the lines joined on sku alone, so a line of a changed product
 *   counts once at each price (at least three Spanish lines are affected).
 * - small_lookup (the control): catalog.csv lists 39 products in shelf
 *   order; the target code's refurbished variant, `<code>-R`, sits on the
 *   first shelf, so a search for the code finds it first. Trap: its bin.
 *
 * What it writes, per task folder: `fixtures/` and `expected/` (removed and
 * rewritten whole), `prompt.md`, `reference.json`, and reshape_json's
 * `task.yaml` (its schema is computed) and `verify/expected_stock.json`;
 * and scripts/phase6b-tools-v1-mock-scripts.json (tools-v1/mock-scripts.ts
 * says how the scripts make the arms differ only through the toolsets).
 * Written by hand, and never touched here: suite.yaml, the other five
 * task.yaml files and `verify/check_stock.py`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { jsonFile, type ToolsTask } from './tools-v1/common.ts';
import { bigCsv, joinThree, smallLookup } from './tools-v1/data-tasks.ts';
import { mockScripts } from './tools-v1/mock-scripts.ts';
import { reshapeJson } from './tools-v1/reshape.ts';
import { checksum, extractIbans } from './tools-v1/text-tasks.ts';

const SUITE = 'suites/tools-v1';
const MOCK_SCRIPTS = 'scripts/phase6b-tools-v1-mock-scripts.json';
/** Task subfolders the generator owns whole: a file in them it does not write is stale. */
const OWNED_DIRS = ['fixtures', 'expected'];

/** The six tasks in suite.yaml order. */
export function buildTasks(): ToolsTask[] {
  return [bigCsv, extractIbans, reshapeJson, checksum, joinThree, smallLookup].map((build) =>
    build(),
  );
}

/** Every file the generator writes, by path under the repository root. */
export function generatedFiles(tasks: readonly ToolsTask[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const task of tasks) {
    if (JSON.stringify(task.trap.answer) === JSON.stringify(task.reference)) {
      throw new Error(`tools-v1 generator: ${task.key}: its trap changes nothing`);
    }
    for (const [path, content] of task.files) files.set(`${SUITE}/${task.key}/${path}`, content);
    files.set(`${SUITE}/${task.key}/reference.json`, jsonFile(task.reference));
  }
  files.set(MOCK_SCRIPTS, jsonFile(mockScripts(tasks)));
  return files;
}

/** Files under a task's owned folders on disk, by path under the repository root. */
function ownedOnDisk(root: string, tasks: readonly ToolsTask[]): string[] {
  return tasks.flatMap((task) =>
    OWNED_DIRS.flatMap((dir) => {
      const folder = join(root, SUITE, task.key, dir);
      if (!existsSync(folder)) return [];
      return readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(root, join(e.parentPath, e.name)));
    }),
  );
}

function main(): number {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      traps: { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  const root = resolve(values.out ?? join(import.meta.dirname, '..', '..'));
  const tasks = buildTasks();
  const files = generatedFiles(tasks);
  if (values.check) {
    const differs = [...files].filter(([path, text]) => {
      const target = join(root, path);
      return !existsSync(target) || readFileSync(target, 'utf8') !== text;
    });
    const stale = ownedOnDisk(root, tasks).filter((path) => !files.has(path));
    for (const [path] of differs)
      console.error(`tools-v1: ${path} differs from what the generator writes`);
    for (const path of stale) console.error(`tools-v1: ${path} is not written by the generator`);
    return differs.length + stale.length === 0 ? 0 : 1;
  }
  for (const task of tasks) {
    for (const dir of OWNED_DIRS)
      rmSync(join(root, SUITE, task.key, dir), { recursive: true, force: true });
  }
  for (const [path, text] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (values.traps) {
    const traps = Object.fromEntries(
      tasks.map(({ key, trap }) => [
        key,
        { answer: trap.answer, note: trap.note, ...(trap.files ? { files: trap.files } : {}) },
      ]),
    );
    writeFileSync(resolve(values.traps), jsonFile(traps));
  }
  return 0;
}

if (import.meta.main) process.exitCode = main();
