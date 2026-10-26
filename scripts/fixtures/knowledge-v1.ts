/**
 * Fixture generator of suites/knowledge-v1 (plan 18.3 and 18.2 P6, Phase 6b
 * R2): every fixture and prompt of the eight tasks, every reference computed
 * from the written files, the reason-code table of the bx7-format skill, the
 * documents arm's files, and the mock scripts of the suite's experiment.
 * References are never typed by hand, and re-running this file reproduces
 * the same bytes.
 *
 *   node scripts/fixtures/knowledge-v1.ts                # rewrites the generated files in place
 *   node scripts/fixtures/knowledge-v1.ts --check        # exit 1 if a file on disk differs, or is stale
 *   node scripts/fixtures/knowledge-v1.ts --out <dir>    # the same files under <dir> instead of the repo
 *   node scripts/fixtures/knowledge-v1.ts --traps <file> # also writes each task's trap answer (the tests use it)
 *
 * Plain Node (25 strips the types): no enums, no parameter properties, no
 * dependency. One fixed seed (knowledge-v1/format.ts SEED) drives a small
 * PRNG mixed with each task's key, so changing one task leaves the others'
 * bytes alone. A construction a trap relies on is checked, and a seed that
 * breaks one is refused.
 *
 * The format, BX-7, is invented (samples/skills/bx7-format/SKILL.md): lines
 * of 64 characters, record types A, B, E, F and Z, a part column for
 * continuation lines, amounts in cents, a direction column (V adds, W
 * subtracts), reversals that repeat the reversed movement's direction and
 * move the balance the other way, and reason codes whose class only codes.md
 * gives. The decoy, BX-6 (samples/skills/bx6-format), has the same columns,
 * amounts in thousandths and the direction letters the other way round.
 * References are computed by the generator's own reader (format.ts
 * parseBx7) from the written text, never by the shipped bx7.py; the tests
 * check the two agree.
 *
 * Each task and its trap:
 *
 * - closing_balance: 32 movements; the account opens overdrawn (B shows W).
 *   Trap: the opening balance read as positive, its W ignored.
 * - record_counts: 38 movements and 4 reversals, several of them with
 *   continuation lines. Trap: lines counted as records.
 * - large_file: 5,000 records (4,850 movements, 147 reversals, some
 *   reversing half the amount) over a quarter. Trap: a hand-written reader
 *   that applies each reversal in the direction its letter shows.
 * - reason_codes: the fees K52 (the only fee SKILL.md lists), K55, K58 and
 *   X84 (a fee outside the K letter), beside K61 and K66 (K codes that are
 *   not fees). Trap: only the fee codes SKILL.md lists, codes.md never read.
 * - pick_version: `treasury_export.bx`, named like a BX-6 file and from "our
 *   old treasury system", whose header says BX07; no reversal and no
 *   continuation line, so BX-6's columns read it cleanly. Trap: the BX-6
 *   reading (thousandths, V as money out).
 * - house_summary: a month's statement to review in the house style
 *   (samples/skills/house-style). Trap: a plain review, its own title, ISO
 *   dates and amounts with the currency after them.
 * - prompt_override: the prompt says this export's direction letters mean
 *   the opposite, and the file is written that way: every letter (the
 *   opening balance's and each movement's) flipped, so receipts show W and
 *   payments, cards and tax V, as codes.md's classes confirm. Trap: the
 *   format's own letters followed, money in and money out swapped.
 * - unrelated: a plain CSV of expense claims over three months. Trap: every
 *   travel claim added, whatever its month. A control: no knowledge helps.
 *
 * Written by hand, never touched here: suite.yaml, the task.yaml files,
 * house_summary's rubric.md, and the skills' SKILL.md files, bx7.py and the
 * house style's template. The mock scripts are knowledge-v1/mock.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { jsonFile } from './invoices-v1/ledger.ts';
import { check } from './knowledge-v1/format.ts';
import { CODES_PATH, codesMd, documents, DOCUMENTS_DIR } from './knowledge-v1/knowledge.ts';
import { mockScripts } from './knowledge-v1/mock.ts';
import { houseSummary, unrelated } from './knowledge-v1/report-tasks.ts';
import {
  closingBalance,
  largeFile,
  pickVersion,
  promptOverride,
  reasonCodes,
  recordCounts,
  type Task,
} from './knowledge-v1/tasks.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const SUITE = 'suites/knowledge-v1';
const MOCK_SCRIPTS = 'scripts/phase6b-knowledge-v1-mock-scripts.json';

/** The eight tasks in suite.yaml order. */
const buildTasks = (): Task[] => [
  closingBalance(),
  recordCounts(),
  largeFile(),
  reasonCodes(),
  pickVersion(),
  houseSummary(),
  promptOverride(),
  unrelated(),
];

/** Every generated file, by its path from the repository root. */
function generate(tasks: readonly Task[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const task of tasks) {
    check(
      JSON.stringify(task.trap.answer) !== JSON.stringify(task.reference),
      `${task.key}: its trap changes nothing`,
    );
    for (const [path, content] of task.files) files.set(`${SUITE}/${task.key}/${path}`, content);
    files.set(`${SUITE}/${task.key}/reference.json`, jsonFile(task.reference));
  }
  const codes = codesMd();
  files.set(CODES_PATH, codes);
  for (const [doc, content] of documents(REPO, codes))
    files.set(`${DOCUMENTS_DIR}/${doc}`, content);
  files.set(MOCK_SCRIPTS, jsonFile(mockScripts(tasks)));
  return files;
}

/** Folders whose every file is the generator's: a file in them it does not write is stale. */
function ownedFolders(tasks: readonly Task[]): string[] {
  return [...tasks.map((t) => `${SUITE}/${t.key}/fixtures`), DOCUMENTS_DIR];
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** The paths that differ from what the generator writes, or that it would remove. */
function drift(root: string, tasks: readonly Task[], files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, content] of files) {
    const target = join(root, path);
    if (!existsSync(target)) problems.push(`${path} is missing`);
    else if (readFileSync(target, 'utf8') !== content) problems.push(`${path} differs`);
  }
  for (const folder of ownedFolders(tasks)) {
    for (const file of listFiles(join(root, folder))) {
      const path = relative(root, file);
      if (!files.has(path)) problems.push(`${path} is not generated (stale)`);
    }
  }
  return problems;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      traps: { type: 'string' },
      check: { type: 'boolean' },
    },
  });
  const root = resolve(values.out ?? REPO);
  const tasks = buildTasks();
  const files = generate(tasks);
  if (values.check) {
    const problems = drift(root, tasks, files);
    for (const p of problems) console.error(`knowledge-v1: ${p}`);
    return problems.length === 0 ? 0 : 1;
  }
  for (const folder of ownedFolders(tasks))
    rmSync(join(root, folder), { recursive: true, force: true });
  for (const [path, content] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (values.traps) {
    const traps = Object.fromEntries(
      tasks.map((t) => [t.key, { ...t.trap, phrase: t.phrase, file: t.file }]),
    );
    writeFileSync(resolve(values.traps), jsonFile(traps));
  }
  console.log(`knowledge-v1: ${tasks.length} tasks, ${files.size} files written under ${root}`);
  return 0;
}

process.exitCode = main();
