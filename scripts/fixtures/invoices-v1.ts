/**
 * Fixture generator of suites/invoices-v1 (plan 18.1 and 18.2 P6): every
 * fixture of the twelve tasks, every reference computed from them, and the
 * mock scripts of the with-skill experiment. References are never typed by
 * hand, and re-running this file reproduces the same bytes.
 *
 *   node scripts/fixtures/invoices-v1.ts                # rewrites the suite and the mock scripts in place
 *   node scripts/fixtures/invoices-v1.ts --out <dir>    # the same files under <dir> instead of the repo
 *   node scripts/fixtures/invoices-v1.ts --traps <file> # also writes each task's trap answer (the tests use it)
 *
 * Plain Node (25 strips the types): no enums, no parameter properties, no
 * dependency. One fixed seed (invoices-v1/ledger.ts SEED) drives a small
 * PRNG; the base ledger draws from the seed itself and each task from the
 * seed mixed with its key, so changing one task leaves the others' bytes
 * alone. A construction a trap relies on is checked, and a seed that breaks
 * one is refused, as is an exact half cent in a reference.
 *
 * What it writes, per task folder: `fixtures/` and `expected/` (removed and
 * rewritten whole), `reference.json`, `verify/expected_*.json` where a
 * verifier compares with computed values, and `prompt.md` for the two tasks
 * whose prompt states the day the fixtures are built around. Written by
 * hand, and never touched here: suite.yaml, task.yaml, the other prompts,
 * the verifier scripts and disputed's rubric; but for one key of task.yaml,
 * `self_check.answers_from_fixtures: true`, which the three tasks whose
 * answer is picked from the ledger (overdue_list, dup_invoices, per_vendor)
 * get (../answers-from-fixtures.ts): their task.yaml is written too.
 *
 * The base ledger (ledger.ts baseLedger): 48 invoices, six for each of
 * eight vendors, in EUR. Each task copies it and plants one trap:
 *
 * - total_due: none planted; paid rows are in the ledger and must be left out.
 * - overdue_list: two open invoices are made due exactly on the cutoff day
 *   (2026-09-01), which is not overdue yet.
 * - dup_invoices: two invoices are overwritten with copies of two others
 *   (vendor, dates, amount, PO) under their own invoice numbers, and a decoy
 *   bills one vendor the same amount in two different months.
 * - vat_split: Borealis Logistics is in the zero-rated band of
 *   policy_terms.json; its net still counts, with zero VAT.
 * - credit_notes: four open invoices get a credit note each, and one paid
 *   invoice gets one too, which changes nothing that is still owed.
 * - currency_mix: three vendors bill in GBP, USD and SEK; rates.json quotes
 *   GBP and USD as EUR per unit and SEK the other way round, with a note.
 * - missing_po: three PO numbers on invoices are missing from
 *   purchase_orders.csv, beside the ten invoices with no PO number at all.
 * - late_fees: policy_terms.json has a 15-day grace period and a 75 EUR cap
 *   per invoice; at least one open invoice is late but inside the grace
 *   period, and the cap binds on others.
 * - per_vendor: one unpaid row and one other row of three vendors carry one
 *   or two trailing spaces in the vendor name.
 * - disputed: none planted; the average of the payment run must leave the
 *   disputed rows out of the count, not keep them at zero.
 * - partial_pay: five open invoices have part payments, one of them two.
 * - summary_file: every invoice of one vendor is paid, so a summary built
 *   from the unpaid rows alone has no row for it.
 *
 * The mock scripts (scripts/phase6-mock-scripts.json, plan 18.5 step 3) are
 * written from the same tasks: the judge's two answers for disputed, then
 * the with-skill script, matched by a sentence only the skill's SKILL.md
 * holds, which reads invoices.csv, writes the expected summary.csv and
 * answers every task right in one answer object (each task's keys read
 * their own paths), then one baseline script per task, matched by a phrase
 * of its prompt, which prints the files and answers with the trap answer
 * where `baselineTrapped` is set, else with the reference.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { markedTaskYaml } from './answers-from-fixtures.ts';
import {
  creditNotes,
  currencyMix,
  lateFees,
  missingPo,
  partialPay,
  vatSplit,
} from './invoices-v1/file-tasks.ts';
import {
  disputed,
  dupInvoices,
  overdueList,
  perVendor,
  summaryFile,
  totalDue,
} from './invoices-v1/ledger-tasks.ts';
import { baseLedger, check, jsonFile, type Json, type Task } from './invoices-v1/ledger.ts';
import { phase6SmokeScripts } from './phase6-smoke.ts';

const SUITE = 'suites/invoices-v1';
const MOCK_SCRIPTS = 'scripts/phase6-mock-scripts.json';
/** In samples/skills/invoice-method/SKILL.md and nowhere else: the with-skill script's `match`. */
const SKILL_PHRASE = 'Reconcile the whole ledger before you report any figure.';
/** In the with-skill answer and the trapped disputed answer only: the judge scripts' `match`. */
const JUDGE_RIGHT = 'Disputed invoices sit outside the payment run entirely';
const JUDGE_WRONG = 'Disputed invoices stay in the run at zero';
/**
 * The other Phase 6 checks' mock scripts (scripts/phase6-smoke.sh's, from
 * phase6-smoke.ts): written as they are, before invoices-v1's, into
 * the same phase file (plan 18.2 P6: one mock-scripts file per phase). Their
 * phrases must occur in no invoices-v1 prompt or fixture, or they would
 * answer this suite's requests.
 */
const OTHER_PHASE6_SCRIPTS: Json[] = phase6SmokeScripts();

type Step = { tool: string; arguments: { [key: string]: Json } } | { content: string };

/** The twelve tasks in suite.yaml order. */
function buildTasks(): Task[] {
  const base = baseLedger();
  return [
    totalDue,
    overdueList,
    dupInvoices,
    vatSplit,
    creditNotes,
    currencyMix,
    missingPo,
    lateFees,
    perVendor,
    disputed,
    partialPay,
    summaryFile,
  ].map((build) => build(base));
}

const answerBlock = (value: Json): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function mockScripts(tasks: readonly Task[]): Json {
  const combined: { [key: string]: Json } = Object.assign({}, ...tasks.map((t) => t.reference));
  check(
    Object.keys(combined).length === tasks.reduce((n, t) => n + Object.keys(t.reference).length, 0),
    'two tasks share an answer key, so one combined answer cannot serve both',
  );
  const summary = tasks.find((t) => t.key === 'summary_file')!.files.get('expected/summary.csv')!;
  const judge = (match: string, score: number, comment: string) => ({
    match,
    steps: [{ content: JSON.stringify({ score, comment }) }],
  });
  const withSkill: Step[] = [
    { tool: 'read_file', arguments: { path: '/workspace/invoices.csv' } },
    { tool: 'write_file', arguments: { path: '/workspace/summary.csv', content: summary } },
    {
      content: `I reconciled the ledger with every file beside it, followed the task's own definition of what is due, trimmed the vendor names and applied every credit note and payment. ${JUDGE_RIGHT}: they count in neither the total nor the number of invoices.\n\n${answerBlock(combined)}`,
    },
  ];
  const baseline = tasks.map((t) => {
    const steps: Step[] = [
      {
        tool: 'terminal',
        arguments: { command: `cat ${t.reads.map((f) => `/workspace/${f}`).join(' ')}` },
      },
    ];
    for (const [path, content] of Object.entries(t.baselineTrapped ? (t.trap.files ?? {}) : {})) {
      steps.push({ tool: 'write_file', arguments: { path: `/workspace/${path}`, content } });
    }
    const note =
      t.key === 'disputed' && t.baselineTrapped
        ? ` ${JUDGE_WRONG}, so the average covers them too.`
        : '';
    const answer = t.baselineTrapped ? t.trap.answer : t.reference;
    steps.push({ content: `Here is the result from the files.${note}\n\n${answerBlock(answer)}` });
    return { match: t.phrase, steps };
  });
  return [
    ...OTHER_PHASE6_SCRIPTS,
    judge(JUDGE_RIGHT, 0.9, 'Counts the open invoices only; disputed ones are out of the count.'),
    judge(JUDGE_WRONG, 0.2, 'Keeps disputed invoices in the count at zero, lowering the average.'),
    { match: SKILL_PHRASE, steps: withSkill },
    ...baseline,
  ];
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function main(): void {
  const { values } = parseArgs({ options: { out: { type: 'string' }, traps: { type: 'string' } } });
  const root = resolve(values.out ?? join(import.meta.dirname, '..', '..'));
  const tasks = buildTasks();
  for (const task of tasks) {
    check(
      JSON.stringify(task.trap.answer) !== JSON.stringify(task.reference),
      `${task.key}: its trap changes nothing`,
    );
    const folder = join(root, SUITE, task.key);
    for (const dir of ['fixtures', 'expected']) {
      rmSync(join(folder, dir), { recursive: true, force: true });
    }
    for (const [path, content] of task.files) write(folder, path, content);
    write(folder, 'reference.json', jsonFile(task.reference));
    if (task.answersFromFixtures) write(folder, 'task.yaml', markedTaskYaml(SUITE, task.key));
  }
  write(root, MOCK_SCRIPTS, jsonFile(mockScripts(tasks)));
  if (values.traps) {
    const traps = Object.fromEntries(
      tasks.map((t) => [
        t.key,
        { ...t.trap, phrase: t.phrase, baseline_trapped: t.baselineTrapped },
      ]),
    );
    writeFileSync(resolve(values.traps), jsonFile(traps));
  }
}

main();
