/**
 * scripts/phase6-smoke.sh's own checks, without a stack: the temporary suite
 * and skill that scripts/fixtures/phase6-smoke.ts writes load valid through
 * the real loader (every self-check passing, the home check's negative
 * control failing), and each arm's requests pick the mock script meant for
 * them in scripts/phase6-mock-scripts.json, with the answer each arm should
 * end on graded by the real scorers. The mock plays the n-th step of the
 * first script whose `match` occurs in the request's messages, n being the
 * tool results so far (apps/egress/src/mock-model.ts); the texts below are
 * what each request holds by then, built from the generated files.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  MOCK_SCRIPTS,
  MockScriptsSchema,
  REPO,
  readText,
  type MockScript,
} from './invoices-v1/support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const GENERATOR = join(REPO, 'scripts/fixtures/phase6-smoke.ts');
const NAME = 'zz-smoke-p6-spec';
const silent = { info: () => {}, warn: () => {}, error: () => {} } as unknown as LoaderLogger;

type Step = MockScript['steps'][number];
type Row = typeof tasks.$inferSelect;

let root = '';
let db: TestDatabase;
let scripts: MockScript[];
let rows: Map<string, Row>;
const files: Record<string, string> = {};

const read = (path: string) => files[path] ?? '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'phase6-smoke-'));
  const run = spawnSync(
    process.execPath,
    [
      GENERATOR,
      '--suite',
      join(root, 'suites', NAME),
      '--name',
      NAME,
      '--skill',
      join(root, 'skill'),
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`the smoke generator failed: ${run.stderr}`);
  for (const path of [
    'codeword/prompt.md',
    'currency/prompt.md',
    'currency/home/memories/USER.md',
    'remember/prompt.md',
    'remember/home/memories/USER.md',
    'remember/expected_home/memories/USER.md',
    'vendors/prompt.md',
    'ledger/prompt.md',
  ]) {
    files[path] = await readFile(join(root, 'suites', NAME, path), 'utf8');
  }
  files['SKILL.md'] = await readFile(join(root, 'skill', 'SKILL.md'), 'utf8');
  scripts = MockScriptsSchema.parse(JSON.parse(await readText(REPO, MOCK_SCRIPTS)));

  db = await createTestDatabase();
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: join(root, 'suites'),
    logger: silent,
  });
  const result = SuiteReloadResultSchema.parse(await loader.loadOne(NAME));
  const suiteId = result.suites[0]!.suiteId!;
  const loaded = await db.db
    .select()
    .from(tasks)
    .where(eq(tasks.suiteId, suiteId))
    .orderBy(asc(tasks.position));
  rows = new Map(loaded.map((r) => [r.key, r]));
});

afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});

/** The step the mock plays for a request holding `text` after `n` tool results. */
function play(text: string, n: number): { match: string | null; step: Step | undefined } {
  const script = scripts.find((s) => text.includes(s.match));
  return {
    match: script?.match ?? null,
    step: script?.steps[Math.min(n, script.steps.length - 1)],
  };
}

/** The status the task's primary answer key gives a final reply. */
function grade(key: string, step: Step | undefined): string {
  if (!step || !('content' in step)) throw new Error(`${key}: the step is not an answer`);
  const row = rows.get(key)!;
  const parsed = parseVerificationEntry(row.verification.find((v) => v.primary)!);
  if (!parsed.success) throw parsed.error;
  const check = parsed.data;
  if (check.type !== 'exact_match' && check.type !== 'json_match') throw new Error(check.type);
  return scoreAnswer(check, extractAnswer(step.content), (row.reference ?? null) as JsonValue)
    .status;
}

/** A tool result as Hermes hands it back: the tool's output as JSON text. */
const toolResult = (value: unknown) => JSON.stringify(value);

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
    const prompt = read('codeword/prompt.md');
    const skill = read('SKILL.md');
    // The skills index on demand shows the front matter, never the body.
    const index = skill.split('\n---\n')[0]!;
    expect(play(`${skill}\n${prompt}`, 0).step).toEqual(
      expect.objectContaining({ content: expect.stringContaining('heron') }),
    );
    expect(grade('codeword', play(`${skill}\n${prompt}`, 0).step)).toBe('passed');

    const first = play(`${index}\n${prompt}`, 0).step;
    expect(first).toEqual({ tool: 'skill_view', arguments: { name: 'smoke-phase6-lookup' } });
    expect(index).toContain('name: smoke-phase6-lookup');
    const opened = `${index}\n${prompt}\n${toolResult({ success: true, content: skill })}`;
    expect(grade('codeword', play(opened, 1).step)).toBe('passed');

    // No skill: skill_view does not exist, and the answer stays wrong.
    const refused = `${prompt}\n${toolResult({ error: 'Unknown tool: skill_view' })}`;
    expect(grade('codeword', play(refused, 1).step)).toBe('failed');
  });

  it('currency: the seed answers only when memory puts it in the prompt', () => {
    const prompt = read('currency/prompt.md');
    expect(
      grade('currency', play(`${read('currency/home/memories/USER.md')}\n${prompt}`, 0).step),
    ).toBe('passed');
    expect(grade('currency', play(prompt, 0).step)).toBe('failed');
  });

  it('remember: saves what the expected home holds, with the memory tool', () => {
    const prompt = read('remember/prompt.md');
    // Memory on puts this task's own seed in the prompt; it must not pick another script.
    const step = play(`${read('remember/home/memories/USER.md')}\n${prompt}`, 0).step;
    expect(step).toEqual({
      tool: 'memory',
      arguments: { action: 'add', target: 'user', content: expect.any(String) },
    });
    const saved = step && 'tool' in step ? (step.arguments['content'] as string) : '';
    expect(read('remember/expected_home/memories/USER.md')).toContain(saved);
    expect(read('remember/home/memories/USER.md')).not.toContain(saved);
  });

  it('vendors: the answer comes only from list_vendors through the gateway', async () => {
    const prompt = read('vendors/prompt.md');
    const reach = play(prompt, 0).step;
    expect(reach).toEqual({
      tool: 'terminal',
      arguments: { command: expect.stringContaining('http://vendor-directory:8000/mcp') },
    });
    const reachOut = 'direct=000\nproxy=403\nREACH_DONE';
    const call = play(`${prompt}\n${reachOut}`, 1).step;
    expect(call).toEqual({
      tool: 'mcp__vendor_directory__list_vendors',
      arguments: { status: 'on_hold' },
    });
    const directory = JSON.parse(
      await readText(REPO, 'docker/mcp/vendor-directory/vendors.json'),
    ) as Array<{ name: string; status: string }>;
    const page = toolResult({
      vendors: directory.filter((v) => v.status === 'on_hold'),
      next_cursor: null,
    });
    expect(grade('vendors', play(`${prompt}\n${reachOut}\n${page}`, 2).step)).toBe('passed');
    // Without the server (no MCP in the arm), the tool call fails and so does the answer.
    const failed = `${prompt}\n${reachOut}\n${toolResult({ error: 'Unknown tool' })}`;
    expect(grade('vendors', play(failed, 2).step)).toBe('failed');
  });

  it("ledger: the right answer needs invoice-db's second page, reached with its cursor", async () => {
    const prompt = read('ledger/prompt.md');
    expect(play(prompt, 0).step).toEqual({ tool: 'mcp__invoice_db__list_invoices', arguments: {} });
    // The server's cursors, as docker/mcp/invoice-db/server.py encodes them.
    const cursor = (offset: number) =>
      Buffer.from(JSON.stringify([offset, null, null])).toString('base64url');
    expect(cursor(20)).toBe('WzIwLG51bGwsbnVsbF0');
    const csv = (await readText(REPO, 'docker/mcp/invoice-db/invoices.csv')).trim().split('\n');
    const numbers = csv.slice(1).map((line) => line.split(',')[0]!);
    const pageOf = (n: number) => ({
      invoices: numbers.slice((n - 1) * 20, n * 20).map((invoice_no) => ({ invoice_no })),
      next_cursor: cursor(n * 20),
    });
    // Hermes hands MCP results back as {"result": "<the tool's JSON, indented>"}.
    const result = (n: number) => toolResult({ result: JSON.stringify(pageOf(n), null, 2) });
    const first = `${prompt}\n${result(1)}`;
    expect(play(first, 1).step).toEqual({
      tool: 'mcp__invoice_db__list_invoices',
      arguments: { cursor: cursor(20) },
    });
    // A vendor name in a page (an on-hold one is the vendors script's match) never takes over.
    const onHold = scripts[scripts.findIndex((s) => s.match === 'smoke-phase6-vendors') - 1]!.match;
    const named = `${first}\n${onHold}`;
    expect(play(named, 1).match).toBe('smoke-phase6-ledger');
    const second = `${first}\n${toolResult({ cursor: cursor(20) })}\n${result(2)}`;
    expect(numbers[20]).toBe('INV-1021');
    expect(grade('ledger', play(`${second}\n${onHold}`, 2).step)).toBe('passed');
    // Without the server the calls fail, and so does the answer.
    const failed = `${prompt}\n${toolResult({ error: 'Unknown tool' })}`;
    expect(grade('ledger', play(`${failed}\n${failed}`, 2).step)).toBe('failed');
  });

  it('never answers an invoices-v1 request or another smoke task', () => {
    const smoke = scripts.slice(
      0,
      scripts.findIndex((s) => s.match.startsWith('Disputed')),
    );
    expect(smoke.map((s) => s.match)).toHaveLength(9);
    // Each prompt picks its own task's script and no other's.
    for (const [path, phrase] of [
      ['codeword/prompt.md', 'smoke-phase6-codeword'],
      ['currency/prompt.md', 'smoke-phase6-currency'],
      ['remember/prompt.md', 'smoke-phase6-remember'],
      ['vendors/prompt.md', 'smoke-phase6-vendors'],
      ['ledger/prompt.md', 'smoke-phase6-ledger'],
    ] as const) {
      expect(play(read(path), 0).match, path).toBe(phrase);
    }
  });
});
