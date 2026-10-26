/**
 * What scripts/phase6-smoke.sh runs its own checks on (plan 18.5 step 3: the
 * platform additions reach the run): a temporary suite, a skill, and the
 * mock scripts that answer them. invoices-v1.ts writes the scripts into
 * scripts/phase6-mock-scripts.json before that suite's (plan 18.2 P6: one
 * mock-scripts file per phase); nothing in invoices-v1 holds these phrases
 * (apps/api/test/invoices-v1/mock-scripts.spec.ts checks it). The smoke
 * writes the suite and the skill with this file, so a phrase lives in one
 * place, and apps/api/test/phase6-smoke.spec.ts loads them and plays each
 * arm's requests against the scripts without a stack.
 *
 *   node scripts/fixtures/phase6-smoke.ts --suite <dir> --name <suite name> --skill <dir>
 *
 * The mock plays the n-th step of the first script whose phrase occurs in
 * the request, n being the tool results so far (apps/egress/src/mock-model.ts),
 * so a script listed first takes over once a tool result brings its phrase.
 * Every phrase here is one only these runs hold: each holds `smoke-phase6`,
 * which no other suite, sample or mock script holds, so where these scripts
 * stand in MOCK_SCRIPTS beside other phases' and suites' never matters
 * (Phase 6 #12, settled for Phase 6b; apps/api/test/phase6-smoke.spec.ts).
 *
 * - codeword (P5): its prompt's script calls skill_view, then answers
 *   "unknown". The skill's body phrase answers "heron" at any step: from the
 *   first call when the skill is preloaded (`-s` puts its body in the
 *   prompt), after skill_view when it is loaded on demand. With no skill,
 *   skill_view does not exist and the answer stays wrong.
 * - currency (P1): the seed phrase is in its USER.md seed; only with memory
 *   on is it in the prompt, and only then is the answer NOK.
 * - remember (P2): its script saves a preference with Hermes's memory tool,
 *   which exists only with memory on (the plan adds the `memory` toolset).
 * - vendors (P4): its script tries the server straight from the trial's
 *   terminal, calls list_vendors through egress's MCP gateway, then asks
 *   get_vendor for PROBE_VENDOR, a name the directory does not hold. The
 *   server's not-found reply echoes the name (`Error executing tool
 *   get_vendor: no vendor smoke-phase6-probe-vendor`, which Hermes hands
 *   back as `{"error": ...}`): text only vendor-directory writes, and only
 *   for this run's call. That reply answers with the on-hold vendors,
 *   computed from the generated directory. Without the server the calls
 *   fail with Hermes's own "does not exist", and the answer stays empty.
 * - ledger (P4): its script lists invoice-db's first page, then the second
 *   with the cursor the server's encoding gives, then lists the workspace
 *   (it holds no ledger), then asks get_invoice for PROBE_INVOICE, which
 *   invoice-db answers with `no invoice smoke-phase6-probe-invoice`; that
 *   reply answers with the invoice that opens the second page. The terminal
 *   step keeps the arm without invoice-db going: Hermes ends a run as
 *   partial after three turns in a row whose only call names a tool it
 *   lacks (agent/turn_tool_validation.py), and that arm must still answer.
 *
 * Why an echo: the mock matches one phrase, so a script that must answer
 * right only once a server answered needs a phrase only the server can put
 * in the request. Data the servers serve (vendor names, the ledger's
 * cursors) is in every run that reads the same data, mcp-v1's included,
 * and a phrase of it would make the order of MOCK_SCRIPTS decide who
 * answers; a name only this smoke sends, echoed back, is in no other run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { generate, INVOICE_PAGE_SIZE } from './sample-mcp.ts';
import type { Json } from './invoices-v1/ledger.ts';

/** The smoke skill: a fixed name, so the codeword script can open it with skill_view. */
export const SMOKE_SKILL = 'smoke-phase6-lookup';
/** In the smoke skill's SKILL.md body only (never in its description). */
export const SKILL_BODY_PHRASE = 'smoke-phase6-skill-body the code word is heron';
export const CODEWORD_PHRASE = 'smoke-phase6-codeword';
/** In the currency task's USER.md seed only. */
export const SEED_PHRASE = 'smoke-phase6-seed the user reports in NOK';
export const CURRENCY_PHRASE = 'smoke-phase6-currency';
export const REMEMBER_PHRASE = 'smoke-phase6-remember';
/** What the remember task's script saves to USER.md. */
export const SAVED_ENTRY = 'smoke-phase6-saved totals sorted largest first';
export const VENDORS_PHRASE = 'smoke-phase6-vendors';
/** The sample http MCP server's name, which Hermes's tool names carry. */
export const VENDOR_SERVER = 'vendor-directory';
export const LIST_VENDORS_TOOL = `mcp__${VENDOR_SERVER.replaceAll('-', '_')}__list_vendors`;
export const GET_VENDOR_TOOL = `mcp__${VENDOR_SERVER.replaceAll('-', '_')}__get_vendor`;
/** A vendor name vendor-directory does not hold: only the vendors script asks for it. */
export const PROBE_VENDOR = 'smoke-phase6-probe-vendor';
/** vendor-directory's not-found reply to get_vendor(PROBE_VENDOR) (docker/mcp/vendor-directory/server.py). */
export const VENDOR_PROBE_REPLY = `no vendor ${PROBE_VENDOR}`;
export const LEDGER_PHRASE = 'smoke-phase6-ledger';
/** The sample stdio MCP server's name, which the ledger script's tool name carries. */
export const INVOICE_SERVER = 'invoice-db';
export const LIST_INVOICES_TOOL = `mcp__${INVOICE_SERVER.replaceAll('-', '_')}__list_invoices`;
export const GET_INVOICE_TOOL = `mcp__${INVOICE_SERVER.replaceAll('-', '_')}__get_invoice`;
/** An invoice number invoice-db does not hold: only the ledger script asks for it. */
export const PROBE_INVOICE = 'smoke-phase6-probe-invoice';
/** invoice-db's not-found reply to get_invoice(PROBE_INVOICE) (docker/mcp/invoice-db/server.py). */
export const INVOICE_PROBE_REPLY = `no invoice ${PROBE_INVOICE}`;
/** Hermes's memory entry delimiter (tools/memory_tool_store.py ENTRY_DELIMITER). */
const DELIMITER = '\n§\n';

/** The vendors on hold in the generated directory, by name. */
export const onHoldVendors = (): string[] =>
  generate()
    .vendors.filter((v) => v.status === 'on_hold')
    .map((v) => v.name)
    .sort();

/**
 * list_invoices' cursor for the page at `offset` of the unfiltered listing:
 * docker/mcp/invoice-db/server.py's encode_cursor, base64url of
 * `[offset,null,null]` without padding.
 */
export const invoiceCursor = (offset: number): string =>
  Buffer.from(JSON.stringify([offset, null, null])).toString('base64url');

/** The invoice numbers on page `n` (from 1) of the unfiltered listing, in its order. */
export const invoicePage = (n: number): string[] =>
  generate()
    .invoices.map((i) => i.invoice_no)
    .sort()
    .slice((n - 1) * INVOICE_PAGE_SIZE, n * INVOICE_PAGE_SIZE);

const answer = (value: Json): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** The trial's reach check: straight at the server, then through egress's forward proxy. */
const REACH_CHECK =
  "curl -sS -m 5 -o /dev/null -w 'direct=%{http_code}\\n' --noproxy '*' http://vendor-directory:8000/mcp; " +
  "curl -sS -m 5 -o /dev/null -w 'proxy=%{http_code}\\n' http://vendor-directory:8000/mcp; echo REACH_DONE";
/**
 * Between the ledger's MCP calls: lists the run's own files (none, so its
 * answer can come only from invoice-db), and keeps the arm without
 * invoice-db short of three missing tools in a row, after which Hermes
 * would end it without an answer.
 */
export const WORKSPACE_CHECK = 'ls -A /workspace; echo WORKSPACE_LISTED';

export function phase6SmokeScripts(): Json[] {
  const onHold = onHoldVendors();
  const vendors = (final: Json) => ({ content: `The vendors on hold.\n\n${answer(final)}` });
  const ledger = (final: Json) => ({
    content: `The second page of the ledger.\n\n${answer(final)}`,
  });
  const heron = { content: `The skill gives the code word.\n\n${answer({ code: 'heron' })}` };
  return [
    // The servers' replies to the probes: once one is in a request, its run's answer is right.
    { match: INVOICE_PROBE_REPLY, steps: [ledger({ second_page_first: invoicePage(2)[0]! })] },
    {
      match: LEDGER_PHRASE,
      steps: [
        { tool: LIST_INVOICES_TOOL, arguments: {} },
        { tool: LIST_INVOICES_TOOL, arguments: { cursor: invoiceCursor(INVOICE_PAGE_SIZE) } },
        { tool: 'terminal', arguments: { command: WORKSPACE_CHECK } },
        { tool: GET_INVOICE_TOOL, arguments: { invoice_no: PROBE_INVOICE } },
        ledger({ second_page_first: 'unknown' }),
      ],
    },
    { match: SKILL_BODY_PHRASE, steps: [heron, heron] },
    {
      match: CODEWORD_PHRASE,
      steps: [
        { tool: 'skill_view', arguments: { name: SMOKE_SKILL } },
        { content: `I could not find the code word.\n\n${answer({ code: 'unknown' })}` },
      ],
    },
    {
      match: SEED_PHRASE,
      steps: [{ content: `Your usual currency.\n\n${answer({ currency: 'NOK' })}` }],
    },
    {
      match: CURRENCY_PHRASE,
      steps: [{ content: `I do not know your currency.\n\n${answer({ currency: 'unknown' })}` }],
    },
    {
      match: REMEMBER_PHRASE,
      steps: [
        { tool: 'memory', arguments: { action: 'add', target: 'user', content: SAVED_ENTRY } },
        { content: `Noted for next time.\n\n${answer({ saved: true })}` },
      ],
    },
    { match: VENDOR_PROBE_REPLY, steps: [vendors({ on_hold: onHold })] },
    {
      match: VENDORS_PHRASE,
      steps: [
        { tool: 'terminal', arguments: { command: REACH_CHECK } },
        { tool: LIST_VENDORS_TOOL, arguments: { status: 'on_hold' } },
        { tool: GET_VENDOR_TOOL, arguments: { name: PROBE_VENDOR } },
        vendors({ on_hold: [] }),
      ],
    },
  ];
}

const LIMITS = (toolsets: string) =>
  `limits:\n  max_turns: 6\n  run_budget_seconds: 120\n  toolsets_needed: [${toolsets}]\n`;
const FENCED = 'answer:\n  format: fenced_json\n';
const json = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`;
const reply = (value: Json): string =>
  `\nEnd your reply with a fenced JSON block:\n\n${answer(value)}\n`;

/** The temporary suite's files, by path under its directory. */
export function smokeSuiteFiles(name: string): Record<string, string> {
  const seedUser = `${SEED_PHRASE}.${DELIMITER}Prefers short answers.\n`;
  const rememberUser = 'Reports amounts with two decimals.\n';
  return {
    'suite.yaml':
      `name: ${name}\nversion_label: '0.1'\n` +
      'description: Temporary Phase 6 smoke suite (scripts/phase6-smoke.sh), graded against the scripted mock model.\n' +
      'tasks: [codeword, currency, remember, vendors, ledger]\n',

    'codeword/task.yaml':
      'summary: The code word the lookup skill holds\n' +
      LIMITS('file') +
      FENCED +
      'verification:\n' +
      '  - key: answer\n    type: exact_match\n    primary: true\n    params: { path: code }\n' +
      `  - key: opened\n    type: trajectory_match\n    params: { tool: skill_view, min_calls: 1 }\n`,
    'codeword/prompt.md': `${CODEWORD_PHRASE}. What is the code word?\n${reply({ code: '' })}`,
    'codeword/reference.json': json({ code: 'heron' }),

    'currency/task.yaml':
      'summary: The currency the user always reports in\n' +
      LIMITS('file') +
      FENCED +
      'verification:\n' +
      '  - key: answer\n    type: exact_match\n    primary: true\n    params: { path: currency }\n',
    'currency/prompt.md': `${CURRENCY_PHRASE}. Which currency do I usually report in?\n${reply({ currency: '' })}`,
    'currency/reference.json': json({ currency: 'NOK' }),
    'currency/home/memories/USER.md': seedUser,

    'remember/task.yaml':
      'summary: Save a lasting preference to memory\n' +
      LIMITS('file') +
      FENCED +
      'verification:\n' +
      '  - key: saved\n    type: file_check\n    primary: true\n' +
      `    params: { root: home, path: memories/USER.md, contains: ['${SAVED_ENTRY}'] }\n` +
      '  - key: used_memory\n    type: trajectory_match\n    params: { tool: memory, min_calls: 1 }\n' +
      'self_check:\n  expected_home: expected_home\n',
    'remember/prompt.md':
      `${REMEMBER_PHRASE}. From now on I want vendor totals sorted largest first. Remember that.\n` +
      reply({ saved: true }),
    'remember/reference.json': json({ saved: true }),
    'remember/home/memories/USER.md': rememberUser,
    'remember/expected_home/memories/USER.md': `${rememberUser.trimEnd()}${DELIMITER}${SAVED_ENTRY}\n`,

    'vendors/task.yaml':
      'summary: The vendors on hold in the vendor directory\n' +
      LIMITS('terminal') +
      FENCED +
      'verification:\n' +
      '  - key: answer\n    type: json_match\n    primary: true\n    params: { path: on_hold, unordered: true }\n' +
      `  - key: through_mcp\n    type: trajectory_match\n    params: { tool: ${LIST_VENDORS_TOOL}, min_calls: 1 }\n`,
    'vendors/prompt.md':
      `${VENDORS_PHRASE}. Which vendors are on hold in the vendor directory? ` +
      `Then ask it for the vendor ${PROBE_VENDOR}, which it does not hold.\n${reply({ on_hold: [] })}`,
    'vendors/reference.json': json({ on_hold: onHoldVendors() }),

    'ledger/task.yaml':
      'summary: The invoice that opens the second page of the invoice database\n' +
      LIMITS('terminal') +
      FENCED +
      'verification:\n' +
      '  - key: answer\n    type: exact_match\n    primary: true\n    params: { path: second_page_first }\n' +
      `  - key: paged\n    type: trajectory_match\n    params: { tool: ${LIST_INVOICES_TOOL}, args: { cursor: '${invoiceCursor(INVOICE_PAGE_SIZE)}' }, min_calls: 1 }\n`,
    'ledger/prompt.md':
      `${LEDGER_PHRASE}. List the invoice database page by page. Which invoice opens its second page? ` +
      `Then ask it for invoice ${PROBE_INVOICE}, which it does not hold.\n` +
      reply({ second_page_first: '' }),
    'ledger/reference.json': json({ second_page_first: invoicePage(2)[0]! }),
  };
}

/** The smoke skill's files, by path under its folder (zip them at the root to upload). */
export function smokeSkillFiles(): Record<string, string> {
  return {
    'SKILL.md':
      `---\nname: ${SMOKE_SKILL}\nversion: 1.0.0\n` +
      'description: Smoke-test skill. Look up the code word for the smoke codeword task.\n---\n\n' +
      `# Code word lookup\n\n${SKILL_BODY_PHRASE}.\n`,
  };
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string' },
      name: { type: 'string' },
      skill: { type: 'string' },
    },
  });
  if (values.suite) {
    if (!values.name) throw new Error('--suite needs --name, the suite name');
    writeAll(values.suite, smokeSuiteFiles(values.name));
  }
  if (values.skill) writeAll(values.skill, smokeSkillFiles());
  if (!values.suite && !values.skill) {
    console.error(
      'usage: node scripts/fixtures/phase6-smoke.ts --suite <dir> --name <name> --skill <dir>',
    );
    process.exit(2);
  }
}
