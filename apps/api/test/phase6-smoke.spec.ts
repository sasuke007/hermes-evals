/**
 * scripts/phase6-smoke.sh's own checks, without a stack: the temporary suite
 * and skill that scripts/fixtures/phase6-smoke.ts writes load valid through
 * the real loader (every self-check passing, the home check's negative
 * control failing), and each arm's run is played against
 * scripts/phase6-mock-scripts.json with the mock's own rule, its answer
 * graded by the real scorers. The mock plays the n-th step of the first
 * script whose `match` occurs in the request's messages, n being the tool
 * results so far (apps/egress/src/mock-model.ts).
 *
 * Each request is built as Hermes v0.22.4 builds it, the sample servers'
 * answers computed from the data files they serve, and a run without a tool
 * stops where Hermes would stop it (support/sample-mcp-requests.ts).
 *
 * Phase 6 #12: every smoke phrase holds `smoke-phase6`, which nothing else
 * in the repository holds, and no other mock script's phrase occurs in a
 * smoke request, so the order of MOCK_SCRIPTS never decides who answers.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { SuiteReloadResultSchema, type JsonValue } from '@hermes-evals/shared';
import { tasks } from '../src/database/schema/index.js';
import { scoreAnswer } from '../src/scoring/answer.js';
import { extractAnswer } from '../src/scoring/extraction.js';
import { parseVerificationEntry } from '../src/scoring/registry.js';
import { BlobStore } from '../src/storage/blob-store.js';
import { SuiteLoader, type LoaderLogger } from '../src/suites/loader/suite-loader.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  loadSampleMcpRows,
  missingToolMessage,
  MISSING_TOOL_STRIKES,
  sampleCursor as cursor,
  sampleMcpMessage,
  type SampleMcpRows,
} from './support/sample-mcp-requests.js';
import {
  listFiles,
  MOCK_SCRIPTS,
  MockScriptsSchema,
  REPO,
  readText,
  type MockScript,
} from './invoices-v1/support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const GENERATOR = join(REPO, 'scripts/fixtures/phase6-smoke.ts');
const NAME = 'zz-smoke-p6-spec';
const MARK = 'smoke-phase6';
const silent = { info: () => {}, warn: () => {}, error: () => {} } as unknown as LoaderLogger;
/** The servers' replies to the probes (phase6-smoke.ts VENDOR_PROBE_REPLY, INVOICE_PROBE_REPLY). */
const VENDOR_PROBE_REPLY = 'no vendor smoke-phase6-probe-vendor';
const INVOICE_PROBE_REPLY = 'no invoice smoke-phase6-probe-invoice';
const TERMINAL_OUTPUT: Record<string, string> = {
  REACH_DONE: 'direct=000\nproxy=403\nREACH_DONE',
  WORKSPACE_LISTED: 'WORKSPACE_LISTED',
};

type Step = MockScript['steps'][number];
type Call = Extract<Step, { tool: string }>;
type Row = typeof tasks.$inferSelect;

/** A string argument or field, or '' for anything else. */
const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');

let root = '';
let db: TestDatabase;
let scripts: MockScript[];
/** The smoke's own scripts: those before invoices-v1's judge replies. */
let smoke: MockScript[];
/** Every other script of every scripts/*mock-scripts.json, with its file. */
let others: { file: string; script: MockScript }[];
let rows: Map<string, Row>;
let data: SampleMcpRows;
const files: Record<string, string> = {};
const read = (path: string) => files[path] ?? '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'phase6-smoke-'));
  const suiteDir = join(root, 'suites', NAME);
  const run = spawnSync(
    process.execPath,
    [GENERATOR, '--suite', suiteDir, '--name', NAME, '--skill', join(root, 'skill')],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`the smoke generator failed: ${run.stderr}`);
  for (const path of await listFiles(suiteDir)) files[path] = await readText(suiteDir, path);
  files['SKILL.md'] = await readFile(join(root, 'skill', 'SKILL.md'), 'utf8');

  scripts = MockScriptsSchema.parse(JSON.parse(await readText(REPO, MOCK_SCRIPTS)));
  smoke = scripts.slice(
    0,
    scripts.findIndex((s) => s.match.startsWith('Disputed')),
  );
  others = scripts.slice(smoke.length).map((script) => ({ file: MOCK_SCRIPTS, script }));
  for (const name of (await readdir(join(REPO, 'scripts'))).sort()) {
    if (!name.endsWith('mock-scripts.json') || `scripts/${name}` === MOCK_SCRIPTS) continue;
    const parsed = MockScriptsSchema.parse(JSON.parse(await readText(REPO, 'scripts', name)));
    others.push(...parsed.map((script) => ({ file: `scripts/${name}`, script })));
  }

  data = await loadSampleMcpRows(REPO);

  db = await createTestDatabase();
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: join(root, 'suites'),
    logger: silent,
  });
  const result = SuiteReloadResultSchema.parse(await loader.loadOne(NAME));
  const loaded = await db.db
    .select()
    .from(tasks)
    .where(eq(tasks.suiteId, result.suites[0]!.suiteId!))
    .orderBy(asc(tasks.position));
  rows = new Map(loaded.map((r) => [r.key, r]));
});

afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});

// --- The runs, as the mock plays them ---------------------------------------------

/** One arm of a smoke experiment: what its system prompt holds, and which tools it has. */
interface Arm {
  context: string[];
  has: (tool: string) => boolean;
}

/** The tools every smoke configuration has (`file` and `terminal`). */
const BASE = ['read_file', 'write_file', 'patch', 'search_files', 'terminal'];
/** An arm with `context` in its system prompt and the tools named in `extra` (or by prefix). */
const arm = (context: string[], ...extra: string[]): Arm => ({
  context,
  has: (tool) => BASE.includes(tool) || extra.some((e) => tool === e || tool.startsWith(e)),
});

/** What a tool the arm has answers. */
function answer(call: Call): string {
  if (call.tool.startsWith('mcp__')) return sampleMcpMessage(data, call);
  if (call.tool === 'skill_view')
    return JSON.stringify({ success: true, content: read('SKILL.md') });
  if (call.tool === 'memory') return JSON.stringify({ success: true, message: 'Entry added.' });
  if (call.tool === 'terminal') {
    const command = text(call.arguments.command);
    const output = Object.entries(TERMINAL_OUTPUT).find(([end]) => command.endsWith(end))?.[1];
    return JSON.stringify({ output: output ?? '', exit_code: 0, error: null });
  }
  throw new Error(`no emulation of ${call.tool}`);
}

interface Played {
  /** The text of each request the run sent, in order. */
  requests: string[];
  /** The phrase of the script that answered each request. */
  picks: string[];
  calls: Call[];
  final: Step;
}

/** The run of one arm against `pool`, with the mock's rule and Hermes's three-strike stop. */
function converse(prompt: string, arm: Arm, pool: readonly MockScript[] = scripts): Played {
  const texts = [...arm.context, prompt];
  const played: Played = { requests: [], picks: [], calls: [], final: { content: '' } };
  let strikes = 0;
  for (let n = 0; n < 12; n += 1) {
    const text = texts.join('\n');
    const script = pool.find((s) => text.includes(s.match));
    if (!script) throw new Error(`no script answers request ${n}`);
    played.requests.push(text);
    played.picks.push(script.match);
    const step = script.steps[Math.min(n, script.steps.length - 1)]!;
    if ('content' in step) return { ...played, final: step };
    played.calls.push(step);
    strikes = arm.has(step.tool) ? 0 : strikes + 1;
    if (strikes === MISSING_TOOL_STRIKES) {
      throw new Error(`Hermes ends the run: ${step.tool} is the third missing tool in a row`);
    }
    const reply = arm.has(step.tool) ? answer(step) : missingToolMessage(step.tool, BASE);
    texts.push(JSON.stringify(step.arguments), reply);
  }
  throw new Error('the run never answered');
}

/** Each task's arms, as phase6-smoke.sh configures them. */
const ARMS = (): Record<string, Record<string, Arm>> => ({
  codeword: {
    none: arm([]),
    preload: arm([read('SKILL.md')]),
    on_demand: arm([read('SKILL.md').split('\n---\n')[0]!], 'skill_view'),
  },
  currency: { off: arm([]), on: arm([read('currency/home/memories/USER.md')], 'memory') },
  remember: { off: arm([]), on: arm([read('remember/home/memories/USER.md')], 'memory') },
  vendors: { none: arm([]), mcp: arm([], 'mcp__vendor_directory__') },
  ledger: { none: arm([]), mcp: arm([], 'mcp__invoice_db__') },
});
const run = (task: string, which: string, pool?: readonly MockScript[]) =>
  converse(read(`${task}/prompt.md`), ARMS()[task]![which]!, pool);

/** The status the task's primary answer key gives a final reply. */
function grade(key: string, step: Step): string {
  if (!('content' in step)) throw new Error(`${key}: the step is not an answer`);
  const row = rows.get(key)!;
  const parsed = parseVerificationEntry(row.verification.find((v) => v.primary)!);
  if (!parsed.success) throw parsed.error;
  const check = parsed.data;
  if (check.type !== 'exact_match' && check.type !== 'json_match') throw new Error(check.type);
  return scoreAnswer(check, extractAnswer(step.content), (row.reference ?? null) as JsonValue)
    .status;
}

// --- The checks -------------------------------------------------------------------

describe('the smoke suite', () => {
  it('loads its five tasks valid, every self-check passing', () => {
    expect([...rows.keys()]).toEqual(['codeword', 'currency', 'remember', 'vendors', 'ledger']);
    for (const row of rows.values()) {
      expect(row.valid, row.key).toBe(true);
      expect(row.selfCheck.status, row.key).toBe('passed');
      expect(
        row.loadIssues.filter((i) => i.severity === 'error'),
        row.key,
      ).toEqual([]);
    }
    // The home check passes on the expected home and fails on the seed alone.
    const saved = rows.get('remember')!.selfCheck.results.filter((r) => r.key === 'saved');
    expect(saved.map((r) => [r.mode, r.expect ?? 'pass', r.status])).toEqual([
      ['home', 'pass', 'passed'],
      ['home', 'fail', 'failed'],
    ]);
  });
});

describe('the smoke scripts, arm by arm', () => {
  it('codeword: only a skill, preloaded or opened on demand, gives the code word', () => {
    expect(run('codeword', 'preload').calls).toEqual([]);
    expect(grade('codeword', run('codeword', 'preload').final)).toBe('passed');
    const onDemand = run('codeword', 'on_demand');
    expect(onDemand.calls).toEqual([
      { tool: 'skill_view', arguments: { name: 'smoke-phase6-lookup' } },
    ]);
    expect(grade('codeword', onDemand.final)).toBe('passed');
    // No skill: skill_view does not exist, and the answer stays wrong.
    expect(grade('codeword', run('codeword', 'none').final)).toBe('failed');
  });

  it('currency: the seed answers only when memory puts it in the prompt', () => {
    expect(grade('currency', run('currency', 'on').final)).toBe('passed');
    expect(grade('currency', run('currency', 'off').final)).toBe('failed');
  });

  it('remember: saves what the expected home holds, with the memory tool', () => {
    const { calls } = run('remember', 'on');
    expect(calls).toEqual([
      { tool: 'memory', arguments: { action: 'add', target: 'user', content: expect.any(String) } },
    ]);
    const saved = text(calls[0]!.arguments.content);
    expect(read('remember/expected_home/memories/USER.md')).toContain(saved);
    expect(read('remember/home/memories/USER.md')).not.toContain(saved);
  });

  it("vendors: the answer comes only after vendor-directory's own reply to the probe", () => {
    const played = run('vendors', 'mcp');
    expect(played.calls.map((c) => [c.tool, c.arguments])).toEqual([
      ['terminal', { command: expect.stringContaining('http://vendor-directory:8000/mcp') }],
      ['mcp__vendor_directory__list_vendors', { status: 'on_hold' }],
      ['mcp__vendor_directory__get_vendor', { name: 'smoke-phase6-probe-vendor' }],
    ]);
    // The on-hold vendors arrive with list_vendors, but only the probe's reply takes over.
    const onHold = data.vendors.filter((v) => v.status === 'on_hold').map((v) => text(v.name));
    for (const name of onHold) expect(played.requests[2]).toContain(name);
    expect(played.picks).toEqual([...Array(3).fill('smoke-phase6-vendors'), VENDOR_PROBE_REPLY]);
    expect(played.requests[3]).toContain(`Error executing tool get_vendor: ${VENDOR_PROBE_REPLY}`);
    expect(grade('vendors', played.final)).toBe('passed');
    // Without the server (no MCP in the arm), the calls fail and so does the answer.
    const without = run('vendors', 'none');
    expect(without.picks.every((p) => p === 'smoke-phase6-vendors')).toBe(true);
    expect(grade('vendors', without.final)).toBe('failed');
  });

  it("ledger: two pages with the server's cursor, then invoice-db's own reply to the probe", () => {
    const played = run('ledger', 'mcp');
    const second = cursor(20, [null, null]);
    expect(second).toBe('WzIwLG51bGwsbnVsbF0');
    expect(played.calls.map((c) => [c.tool, c.arguments])).toEqual([
      ['mcp__invoice_db__list_invoices', {}],
      ['mcp__invoice_db__list_invoices', { cursor: second }],
      ['terminal', { command: 'ls -A /workspace; echo WORKSPACE_LISTED' }],
      ['mcp__invoice_db__get_invoice', { invoice_no: 'smoke-phase6-probe-invoice' }],
    ]);
    // Page 1 hands over the cursor the script sends; page 2 opens with the answer.
    expect(played.requests[1]).toContain(`\\"next_cursor\\": \\"${second}\\"`);
    expect(played.requests[2]).toContain('\\"invoice_no\\": \\"INV-1021\\"');
    expect(played.requests[2]).toContain(cursor(40, [null, null]));
    expect(played.picks).toEqual([...Array(4).fill('smoke-phase6-ledger'), INVOICE_PROBE_REPLY]);
    expect(grade('ledger', played.final)).toBe('passed');
    const without = run('ledger', 'none');
    expect(without.picks.every((p) => p === 'smoke-phase6-ledger')).toBe(true);
    expect(grade('ledger', without.final)).toBe('failed');
  });

  it('never calls three tools in a row that an arm without them lacks', () => {
    for (const s of smoke) {
      let row = 0;
      for (const step of s.steps) {
        row = 'tool' in step && /^(mcp__|skill_view$|memory$)/.test(step.tool) ? row + 1 : 0;
        expect(row, s.match).toBeLessThan(3);
      }
    }
  });
});

describe('the order of MOCK_SCRIPTS never matters (Phase 6 #12)', () => {
  const runs = () =>
    Object.entries(ARMS()).flatMap(([task, arms]) =>
      Object.keys(arms).map((a) => [task, a] as const),
    );

  it('gives every smoke phrase the smoke mark, and each task its own script', () => {
    expect(smoke).toHaveLength(9);
    for (const s of smoke) expect(s.match, s.match).toContain(MARK);
    for (const task of rows.keys()) {
      expect(run(task, Object.keys(ARMS()[task]!)[0]!).picks[0], task).toBe(`${MARK}-${task}`);
    }
  });

  it('puts a probe reply in no request before the server has answered the probe', () => {
    for (const [task, which] of runs()) {
      const { requests, calls } = run(task, which);
      const has = ARMS()[task]![which]!.has;
      for (const [n, text] of requests.entries()) {
        // Request n follows the results of calls 0 to n-1.
        const answered = calls
          .slice(0, n)
          .some((c) => /__get_(vendor|invoice)$/.test(c.tool) && has(c.tool));
        const replied = text.includes(VENDOR_PROBE_REPLY) || text.includes(INVOICE_PROBE_REPLY);
        expect(replied, `${task} (${which}) request ${n}`).toBe(answered);
      }
    }
  });

  it('holds the smoke mark nowhere else: no suite, sample, server data or other script', async () => {
    const roots = ['suites', 'samples', 'docker/mcp'];
    for (const dir of roots) {
      // A smoke run's own temporary suite (suites/zz-smoke-p6-<stamp>) holds the mark, rightly.
      const paths = (await listFiles(join(REPO, dir))).filter((p) => !p.startsWith('zz-smoke-'));
      for (const path of paths) {
        const content = await readFile(join(REPO, dir, path), 'utf8');
        expect(content.includes(MARK), `${dir}/${path}`).toBe(false);
      }
    }
    for (const { file, script } of others) {
      expect(JSON.stringify(script).includes(MARK), `${file}: ${script.match}`).toBe(false);
    }
  });

  it('lets no other script answer a smoke request, whichever file comes first', () => {
    for (const [task, which] of runs()) {
      const { requests, picks } = run(task, which);
      for (const { file, script } of others) {
        const hit = requests.findIndex((text) => text.includes(script.match));
        expect(hit, `${file}: "${script.match}" occurs in ${task} (${which}) request ${hit}`).toBe(
          -1,
        );
      }
      const last = run(task, which, [...others.map((o) => o.script), ...smoke]);
      expect(last.picks, `${task} ${which}`).toEqual(picks);
    }
  });
});
