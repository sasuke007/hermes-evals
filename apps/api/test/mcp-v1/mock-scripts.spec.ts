/**
 * scripts/phase6b-mcp-v1-mock-scripts.json, the mock model's scripts for the
 * mcp-v1 experiment (docs-export · with-mcp, plan 18.3 and 18.5 step 3;
 * Phase 6b R8), checked without a stack. Each run is played by the mock's
 * own rule (the first script whose `match` occurs in the request, its step
 * chosen by the tool results so far) against this suite's model of the two
 * sample servers and of Hermes (./support.ts):
 *
 * - with-mcp: the read of docs/ fails, the task's own MCP result arrives and
 *   its MCP script answers right, so every task passes;
 * - docs-export: the read brings the attached ledger, the documents script
 *   answers every task with its trap answer and never calls an MCP tool;
 * - neither source: the prompt script answers that it reached no data.
 *
 * The comparison of the two arms reads `better`. No mcp-v1 phrase occurs in
 * another suite's files, scripts or MCP results, and no other suite's
 * phrase occurs in an mcp-v1 request, so where the file stands in
 * MOCK_SCRIPTS never matters.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScoreStatus } from '@hermes-evals/shared';
import { computeComparisonStats } from '../../src/statistics/compute.js';
import type { StatsRun } from '../../src/statistics/contracts.js';
import { extractAnswer } from '../../src/scoring/extraction.js';
import {
  listFiles,
  MockScriptsSchema,
  readText,
  REPO,
  SUITES_DIR,
  type LoadedSuite,
  type MockScript,
} from '../invoices-v1/support.js';
import {
  loadMcpSuite,
  mcpMessage,
  MOCK_SCRIPTS,
  play,
  primaryKey,
  scoreKey,
  serverData,
  SUITE_DIR,
  TASK_KEYS,
  type Call,
  type Played,
  type ServerData,
  type Source,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** The read tools the scripts may call: never update_invoice or delete_invoice. */
const MCP_READ_TOOLS = [
  'mcp__invoice_db__get_invoice',
  'mcp__invoice_db__list_invoices',
  'mcp__vendor_directory__get_vendor',
  'mcp__vendor_directory__list_vendors',
];
const SOURCES: readonly Source[] = ['mcp', 'documents', 'none'];

let suite: LoadedSuite;
let data: ServerData;
let scripts: MockScript[];
let prompts: Record<TaskKey, string>;
/** The ledger's header line: the documents script's match. */
let header: string;
let runs: Map<string, Played>;

beforeAll(async () => {
  scripts = MockScriptsSchema.parse(JSON.parse(await readText(REPO, MOCK_SCRIPTS)));
  prompts = Object.fromEntries(
    await Promise.all(TASK_KEYS.map(async (k) => [k, await readText(SUITE_DIR, k, 'prompt.md')])),
  ) as Record<TaskKey, string>;
  data = await serverData();
  header = data.documents.get('invoices.csv')!.split('\n')[0]!;
  runs = new Map(
    TASK_KEYS.flatMap((key) =>
      SOURCES.map((source) => [`${key}/${source}`, play(data, source, prompts[key], scripts)]),
    ),
  );
  suite = await loadMcpSuite();
});

afterAll(() => suite?.close());

const run = (key: TaskKey, source: Source) => runs.get(`${key}/${source}`)!;
const tagOf = (key: TaskKey) => `mcpv1-${key.replaceAll('_', '-')}`;
/** The task's MCP script: the one that ends on its reference. */
const mcpScript = (key: TaskKey) => scripts[TASK_KEYS.indexOf(key)]!;
const documentsScript = () => scripts[TASK_KEYS.length]!;
const promptScript = (key: TaskKey) => scripts[TASK_KEYS.length + 1 + TASK_KEYS.indexOf(key)]!;
const toolSteps = (s: MockScript): Call[] =>
  s.steps.flatMap((step) =>
    'tool' in step ? [{ tool: step.tool, arguments: step.arguments }] : [],
  );
const finalText = (s: MockScript) => {
  const last = s.steps.at(-1)!;
  if (!('content' in last)) throw new Error(`${s.match}: the last step is not an answer`);
  return last.content;
};
const grade = (key: TaskKey, played: Played, name = primaryKey(suite.byKey.get(key)!)) =>
  scoreKey(suite.byKey.get(key)!, name, { text: played.answer ?? '', calls: played.calls });

describe('the scripts file', () => {
  it('holds an MCP script per task, the documents script, then a prompt script per task', () => {
    expect(scripts).toHaveLength(2 * TASK_KEYS.length + 1);
    expect(documentsScript().match).toBe(header);
    expect(header).toBe(
      'invoice_no,vendor_name,invoice_date,due_date,amount,currency,po_number,status,notes',
    );
    for (const key of TASK_KEYS) {
      expect(promptScript(key).match, key).toBe(tagOf(key));
      expect(prompts[key].startsWith(`Ticket ${tagOf(key)}.\n`), key).toBe(true);
      // The two scripts of a task make the same calls; only their answers differ.
      expect(toolSteps(promptScript(key)), key).toEqual(toolSteps(mcpScript(key)));
    }
  });

  it('makes real Hermes tool calls before every answer, and never a write', () => {
    for (const s of scripts) {
      const calls = toolSteps(s);
      expect(calls[0], s.match).toEqual({
        tool: 'read_file',
        arguments: { path: '/workspace/docs/invoices.csv' },
      });
      for (const c of calls) {
        if (c.tool === 'read_file')
          expect(c.arguments['path'], s.match).toMatch(/^\/workspace\/docs\//);
        else expect(MCP_READ_TOOLS, s.match).toContain(c.tool);
      }
      expect(
        s.steps.slice(0, -1).every((step) => 'tool' in step),
        s.match,
      ).toBe(true);
      expect(finalText(s), s.match).toMatch(/```json\n.+\n```$/);
    }
    // Three turns in a row of tools a run lacks end it as partial: docs-export never calls one.
    expect(toolSteps(documentsScript()).map((c) => c.tool)).toEqual(['read_file', 'read_file']);
  });
});

describe('which script answers which request', () => {
  it.each(TASK_KEYS)(
    '%s, with-mcp: the prompt script until its own MCP result arrives, then its MCP script',
    (key) => {
      const played = run(key, 'mcp');
      const phrase = mcpScript(key).match;
      const from = played.requests.findIndex((text) => text.includes(phrase));
      expect(from, key).toBeGreaterThan(1);
      expect(played.picked, key).toEqual(
        played.requests.map((_, n) => (n < from ? tagOf(key) : phrase)),
      );
      expect(played.answer).toBe(finalText(mcpScript(key)));
      expect(played.calls).toEqual(toolSteps(mcpScript(key)));
      // The phrase arrives in exactly one tool result: an MCP result of this task.
      const results = played.calls.map((c) => (c.tool === 'read_file' ? '' : mcpMessage(data, c)));
      expect(
        results.filter((r) => r.includes(phrase)),
        key,
      ).toHaveLength(1);
      expect(results[from - 1]).toContain(phrase);
    },
  );

  it.each(TASK_KEYS)(
    '%s, docs-export: the documents script once the ledger is read, with no MCP call',
    (key) => {
      const played = run(key, 'documents');
      expect(played.picked).toEqual([tagOf(key), header, header]);
      expect(played.calls.map((c) => c.arguments['path'])).toEqual([
        '/workspace/docs/invoices.csv',
        '/workspace/docs/vendors.json',
      ]);
      expect(played.answer).toBe(finalText(documentsScript()));
    },
  );

  it.each(TASK_KEYS)('%s, neither source: the prompt script throughout', (key) => {
    const played = run(key, 'none');
    expect(new Set(played.picked)).toEqual(new Set([tagOf(key)]));
    expect(played.answer).toBe(finalText(promptScript(key)));
    expect(extractAnswer(played.answer!)).toMatchObject({ value: { data_unavailable: true } });
  });

  it('calls both servers in due_by_terms: stdio and http in one run', () => {
    const mcp = run('due_by_terms', 'mcp').calls.filter((c) => c.tool.startsWith('mcp__'));
    expect(new Set(mcp.map((c) => c.tool.split('__')[1]))).toEqual(
      new Set(['invoice_db', 'vendor_directory']),
    );
  });
});

describe('how the experiment grades', () => {
  it.each(TASK_KEYS)(
    '%s: with-mcp passes, docs-export falls into the trap, neither fails',
    (key) => {
      expect(grade(key, run(key, 'mcp')).status, `${key} with-mcp`).toBe('passed');
      expect(grade(key, run(key, 'documents')).status, `${key} docs-export`).toBe('failed');
      expect(grade(key, run(key, 'none')).status, `${key} neither`).toBe('failed');
    },
  );

  it("answers in docs-export each task's trap answer at its own path", async () => {
    const answer = extractAnswer(finalText(documentsScript()));
    if (answer.status !== 'found') throw new Error('no answer block');
    for (const key of TASK_KEYS) {
      const reference = JSON.parse(await readText(SUITE_DIR, key, 'reference.json')) as object;
      for (const path of Object.keys(reference)) {
        expect(answer.value, key).toHaveProperty([path]);
      }
    }
  });

  it('passes every secondary key in both arms: the mock never writes, pages or lists in vain', () => {
    for (const key of TASK_KEYS) {
      const names = suite.byKey
        .get(key)!
        .verification.filter((v) => !v.primary)
        .map((v) => v.key);
      for (const name of names) {
        for (const source of ['mcp', 'documents'] as const) {
          expect(grade(key, run(key, source), name).status, `${key}.${name} ${source}`).toBe(
            'passed',
          );
        }
      }
    }
  });

  it('reads better for with-mcp over docs-export at two repetitions', () => {
    const runOf = (status: ScoreStatus): StatsRun => ({
      passed: status === 'passed',
      keyStatus: status,
      executionError: null,
      durationS: null,
      tokens: null,
    });
    const arm = (key: TaskKey, source: Source) => {
      const status = grade(key, run(key, source)).status as ScoreStatus;
      return [runOf(status), runOf(status)];
    };
    const result = computeComparisonStats(
      {
        tasks: TASK_KEYS.map((key) => ({
          taskKey: key,
          baseline: arm(key, 'documents'),
          candidate: arm(key, 'mcp'),
        })),
        repetitions: 2,
        provisional: false,
        labels: { baseline: 'docs-export', candidate: 'with-mcp' },
        progress: { scored: 32, total: 32 },
        costUsd: { baseline: 0, candidate: 0 },
      },
      { seed: 20261026 },
    );
    expect(result).toMatchObject({
      computable: true,
      verdict: 'better',
      observedDelta: 1,
      lo: 1,
      hi: 1,
    });
  });
});

describe('no other suite shares a phrase with mcp-v1', () => {
  /** Every other mock-scripts file in scripts/, parsed. */
  async function otherScripts(): Promise<Array<[string, MockScript[]]>> {
    const names = (await readdir(join(REPO, 'scripts'))).filter(
      (f) => f.endsWith('mock-scripts.json') && f !== MOCK_SCRIPTS.slice('scripts/'.length),
    );
    expect(names).toContain('phase6-mock-scripts.json');
    return Promise.all(
      names.map(async (f): Promise<[string, MockScript[]]> => [
        f,
        MockScriptsSchema.parse(JSON.parse(await readText(REPO, 'scripts', f))),
      ]),
    );
  }
  /** What another run's request can hold from a script: its phrase, its call arguments, its answers. */
  const scriptTexts = (s: MockScript): string[] => [
    s.match,
    ...s.steps.map((step) => ('tool' in step ? JSON.stringify(step.arguments) : step.content)),
  ];

  it("occurs in no other suite's or sample's file", async () => {
    const roots = [
      ...(await readdir(SUITES_DIR)).filter((d) => d !== 'mcp-v1').map((d) => join(SUITES_DIR, d)),
      join(REPO, 'samples'),
    ];
    for (const root of roots) {
      for (const file of await listFiles(root)) {
        if (join(root, file).startsWith(join(REPO, 'samples/documents/mcp-v1'))) continue;
        const text = await readText(root, file);
        for (const s of scripts)
          expect(text.includes(s.match), `${root}/${file}: ${s.match}`).toBe(false);
      }
    }
  });

  it("occurs in no other script, nor in the MCP results another script's calls get", async () => {
    for (const [file, others] of await otherScripts()) {
      for (const other of others) {
        const texts = scriptTexts(other);
        for (const step of other.steps) {
          if ('tool' in step && MCP_READ_TOOLS.includes(step.tool)) {
            texts.push(mcpMessage(data, { tool: step.tool, arguments: step.arguments }));
          }
        }
        for (const s of scripts) {
          expect(
            texts.some((t) => t.includes(s.match)),
            `${file} ${other.match}: ${s.match}`,
          ).toBe(false);
        }
      }
    }
  });

  it('leaves every mcp-v1 request to the mcp-v1 scripts, wherever MOCK_SCRIPTS puts them', async () => {
    const others = (await otherScripts()).flatMap(([file, list]) =>
      list.map((s) => [file, s.match] as const),
    );
    for (const [id, played] of runs) {
      for (const text of played.requests) {
        for (const [file, match] of others) {
          expect(text.includes(match), `${id} picks ${file}'s ${match}`).toBe(false);
        }
      }
    }
  });
});
