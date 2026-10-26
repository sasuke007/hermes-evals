/**
 * scripts/phase6b-tools-v1-mock-scripts.json, the mock model's scripts for
 * the tools-v1 experiment (file · file-terminal · file-terminal-code, plan
 * 18.3 and 18.5 step 3), played without a stack. The mock plays the n-th
 * step of the first script whose `match` occurs in a request, n being the
 * tool results so far (apps/egress/src/mock-model.ts). Each run below is
 * played as Hermes would answer it (./arms.ts): a tool the arm lacks gets
 * Hermes's "does not exist" tool error; execute_code and terminal really run
 * the scripted Python and shell on a copy of the task's fixtures; read_file
 * shows the first page (2,000 lines at most); write_file writes. The final
 * replies and workspaces are graded with the
 * real scorers, and the arms' outcomes go through the real comparison
 * statistics: the experiment the scripts predict reads `better` for both
 * tool arms against `file`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeComparisonStats, seedFromExperimentId } from '../../src/statistics/compute.js';
import type { StatsRun } from '../../src/statistics/contracts.js';
import { HERMES_TOOLSETS } from '@hermes-evals/shared';
import { ARM_NAMES, ARM_TOOLSETS, play, type Arm, type Played } from './arms.js';
import {
  CONTROL,
  listFiles,
  loadToolsSuite,
  MOCK_SCRIPTS,
  MockScriptsSchema,
  readText,
  REPO,
  SUITE_DIR,
  TASK_KEYS,
  type LoadedSuite,
  type MockScript,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const TOOL_TASKS = TASK_KEYS.filter((k) => k !== CONTROL);

let suite: LoadedSuite;
let scripts: MockScript[];
let scratch: string;
const played = new Map<string, Played>();
const runKey = (key: TaskKey, arm: Arm) => `${key} · ${arm}`;

const toolSteps = (s: MockScript) => s.steps.flatMap((step) => ('tool' in step ? [step] : []));
const finalText = (s: MockScript) => {
  const last = s.steps.at(-1)!;
  if (!('content' in last)) throw new Error(`${s.match}: the last step is not an answer`);
  return last.content;
};

beforeAll(async () => {
  scripts = MockScriptsSchema.parse(JSON.parse(await readText(REPO, MOCK_SCRIPTS)));
  scratch = await mkdtemp(join(tmpdir(), 'tools-v1-mock-'));
  suite = await loadToolsSuite();
  for (const key of TASK_KEYS) {
    for (const arm of ARM_NAMES) {
      played.set(runKey(key, arm), await play(scripts, suite, key, arm, scratch));
    }
  }
});

afterAll(async () => {
  await suite?.close();
  await rm(scratch, { recursive: true, force: true });
});

const result = (key: TaskKey, arm: Arm) => played.get(runKey(key, arm))!;
const promptScript = (key: TaskKey) => scripts.find((s) => s.match === `tv1-${key}.`)!;
const outcomeScripts = () => scripts.filter((s) => !/^tv1-[a-z_]+\.$/.test(s.match));

describe('the recommended arms', () => {
  it('name toolsets GET /system/toolsets lists, and differ only by adding one', () => {
    const lists: readonly (readonly string[])[] = ARM_NAMES.map((arm) => ARM_TOOLSETS[arm]);
    for (const toolsets of lists) {
      for (const t of toolsets) expect(HERMES_TOOLSETS as readonly string[]).toContain(t);
    }
    expect(lists.map((l) => l.length)).toEqual([1, 2, 3]);
    expect(lists[1]!.slice(0, 1)).toEqual(lists[0]);
    expect(lists[2]!.slice(0, 2)).toEqual(lists[1]);
  });
});

describe('the scripts file', () => {
  it('lists each task’s outcome scripts first, then one prompt script per task', () => {
    expect(scripts.map((s) => s.match).filter((m) => /^tv1-[a-z_]+\.$/.test(m))).toEqual(
      TASK_KEYS.map((k) => `tv1-${k}.`),
    );
    expect(scripts.slice(0, outcomeScripts().length)).toEqual(outcomeScripts());
    expect(outcomeScripts()).toHaveLength(2 * TOOL_TASKS.length + 1);
    expect(new Set(scripts.map((s) => s.match)).size).toBe(scripts.length);
  });

  it('tries execute_code, then terminal, then the file tools, with real Hermes tool calls', () => {
    for (const key of TOOL_TASKS) {
      const tools = toolSteps(promptScript(key)).map((s) => s.tool);
      expect(tools.slice(0, 2), key).toEqual(['execute_code', 'terminal']);
      expect(
        tools.slice(2).every((t) => t === 'read_file' || t === 'write_file'),
        key,
      ).toBe(true);
      for (const step of toolSteps(promptScript(key))) {
        expect(JSON.stringify(step.arguments), key).toContain('/workspace/');
      }
    }
    expect(toolSteps(promptScript(CONTROL)).map((s) => s.tool)).toEqual(['read_file']);
    for (const s of scripts) expect(finalText(s), s.match).toMatch(/```json\n.+\n```$/);
  });

  it('answers with the reference in every outcome script', async () => {
    for (const s of outcomeScripts()) {
      expect(s.steps, s.match).toHaveLength(1);
      const key = TASK_KEYS.find((k) => s.match.startsWith(`tv1-${k}-`)) ?? CONTROL;
      const reference: unknown = JSON.parse(await readText(SUITE_DIR, key, 'reference.json'));
      const block = /```json\n(.+)\n```$/.exec(finalText(s))![1]!;
      expect(JSON.parse(block), s.match).toEqual(reference);
    }
  });
});

describe('which script answers which request', () => {
  it('starts every tools-v1 phrase with tv1-, but the control row, which only its catalog holds', async () => {
    const catalog = await readText(SUITE_DIR, CONTROL, 'fixtures/catalog.csv');
    for (const s of scripts) {
      if (s.match.startsWith('tv1-')) continue;
      expect(catalog.split(s.match)).toHaveLength(2);
      expect(await readText(SUITE_DIR, CONTROL, 'prompt.md')).not.toContain(s.match);
    }
  });

  it('puts each prompt phrase in its own prompt only, and no outcome phrase in any file or script step', async () => {
    const files = await listFiles(SUITE_DIR);
    const texts = new Map(
      await Promise.all(files.map(async (f) => [f, await readText(SUITE_DIR, f)] as const)),
    );
    for (const key of TASK_KEYS) {
      const holders = files.filter((f) => texts.get(f)!.includes(`tv1-${key}.`));
      expect(holders, key).toEqual([`${key}/prompt.md`]);
    }
    const stepTexts = scripts.flatMap((s) => s.steps.map((step) => JSON.stringify(step)));
    for (const s of outcomeScripts().filter((o) => o.match.startsWith('tv1-'))) {
      // Only the tool's own output can bring it: no fixture, prompt or call argument holds it.
      expect(
        files.filter((f) => texts.get(f)!.includes(s.match)),
        s.match,
      ).toEqual([]);
      expect(
        stepTexts.filter((t) => t.includes(s.match)),
        s.match,
      ).toEqual([]);
    }
  });

  it("never answers another suite's requests, and no other suite's script answers tools-v1's", async () => {
    const others: string[] = [];
    for (const dir of ['suites', 'samples']) {
      for (const file of await listFiles(join(REPO, dir))) {
        if (dir === 'suites' && file.startsWith('tools-v1/')) continue;
        others.push(await readText(REPO, dir, file));
      }
    }
    const otherScripts: MockScript[] = [];
    for (const file of await listFiles(join(REPO, 'scripts'))) {
      if (
        !/^phase[0-9a-z]+(-[a-z0-9-]+)?-mock-scripts\.json$/.test(file) ||
        `scripts/${file}` === MOCK_SCRIPTS
      )
        continue;
      const parsed = MockScriptsSchema.safeParse(JSON.parse(await readText(REPO, 'scripts', file)));
      if (parsed.success) otherScripts.push(...parsed.data);
    }
    expect(otherScripts.length).toBeGreaterThan(0);
    others.push(
      ...otherScripts.flatMap((s) => [s.match, ...s.steps.map((step) => JSON.stringify(step))]),
    );
    for (const s of scripts) {
      expect(
        others.filter((t) => t.includes(s.match)),
        s.match,
      ).toEqual([]);
    }
    const ours = await Promise.all(
      (await listFiles(SUITE_DIR))
        .filter((f) => /\/(fixtures\/|prompt\.md$)/.test(f))
        .map((f) => readText(SUITE_DIR, f)),
    );
    for (const key of TASK_KEYS) {
      for (const arm of ARM_NAMES) ours.push(result(key, arm).text);
    }
    ours.push(...scripts.flatMap((s) => s.steps.map((step) => JSON.stringify(step))));
    for (const s of otherScripts) {
      expect(
        ours.filter((t) => t.includes(s.match)),
        s.match,
      ).toEqual([]);
    }
  });
});

describe('how each arm plays', () => {
  it.each(TOOL_TASKS)(
    '%s · file: both stronger tools refused, the file tools answer and fail',
    (key) => {
      const run = result(key, 'file');
      expect(run.refused).toEqual(['execute_code', 'terminal']);
      expect(run.calls.every((c) => c.name === 'read_file' || c.name === 'write_file')).toBe(true);
      expect(new Set(run.answeredBy)).toEqual(new Set([`tv1-${key}.`]));
      expect(run.primary, run.text).toBe('failed');
    },
  );

  it.each(TOOL_TASKS)(
    '%s · file-terminal: execute_code refused, the terminal answers and passes',
    (key) => {
      const run = result(key, 'file-terminal');
      expect(run.refused).toEqual(['execute_code']);
      expect(run.calls.map((c) => c.name)).toEqual(['terminal']);
      expect(run.answeredBy.at(-1)).toMatch(new RegExp(`^tv1-${key}-term=`));
      expect(run.primary, run.text).toBe('passed');
    },
  );

  it.each(TOOL_TASKS)(
    '%s · file-terminal-code: execute_code answers and passes, with no terminal call',
    (key) => {
      const run = result(key, 'file-terminal-code');
      expect(run.refused).toEqual([]);
      expect(run.calls.map((c) => c.name)).toEqual(['execute_code']);
      expect(run.answeredBy.at(-1)).toMatch(new RegExp(`^tv1-${key}-code=`));
      expect(run.primary, run.text).toBe('passed');
    },
  );

  it.each(ARM_NAMES)('small_lookup · %s: the control reads the catalog and passes', (arm) => {
    const run = result(CONTROL, arm);
    expect(run.refused).toEqual([]);
    expect(run.calls.map((c) => c.name)).toEqual(['read_file']);
    expect(run.answeredBy.at(-1)!.startsWith('tv1-')).toBe(false);
    expect(run.primary, run.text).toBe('passed');
  });

  it('writes stock_by_sku.json in every arm; only the tools write the whole of it', () => {
    expect(result('reshape_json', 'file').quantities).toBe('failed');
    expect(result('reshape_json', 'file-terminal').quantities).toBe('passed');
    expect(result('reshape_json', 'file-terminal-code').quantities).toBe('passed');
  });

  it('answers checksum with null in the file arm: it says it cannot', () => {
    const block = /```json\n(.+)\n```$/.exec(result('checksum', 'file').text)![1]!;
    expect(JSON.parse(block)).toEqual({ sha256: null });
  });
});

describe('the experiment the scripts predict', () => {
  const runs = (key: TaskKey, arm: Arm): StatsRun[] => {
    const passed = result(key, arm).primary === 'passed';
    const run: StatsRun = {
      passed,
      keyStatus: passed ? 'passed' : 'failed',
      executionError: null,
      durationS: null,
      tokens: null,
    };
    return [run, run];
  };
  const compare = (baseline: Arm, candidate: Arm) =>
    computeComparisonStats(
      {
        tasks: TASK_KEYS.map((k) => ({
          taskKey: k,
          baseline: runs(k, baseline),
          candidate: runs(k, candidate),
        })),
        repetitions: 2,
        provisional: false,
        labels: { baseline, candidate },
        progress: { scored: 4 * TASK_KEYS.length, total: 4 * TASK_KEYS.length },
        costUsd: { baseline: 0, candidate: 0 },
      },
      { seed: seedFromExperimentId('tools-v1-mock-experiment') },
    );

  it.each(['file-terminal', 'file-terminal-code'] as const)(
    'reads better for %s against file: five tasks improved, the control unchanged',
    (candidate) => {
      const stats = compare('file', candidate);
      expect(stats.computable).toBe(true);
      if (!stats.computable) return;
      expect(stats.verdict).toBe('better');
      expect(stats.observedDelta).toBeCloseTo(5 / 6, 9);
      expect(stats.taskCounts).toEqual({ improved: 5, regressed: 0, unchanged: 1 });
      expect(stats.baseline).toMatchObject({ passed: 2, counted: 12 });
      expect(stats.candidate).toMatchObject({ passed: 12, counted: 12 });
      expect(stats.lo).toBeGreaterThan(0);
    },
  );

  it('reads inconclusive between the two tool arms', () => {
    const stats = compare('file-terminal', 'file-terminal-code');
    expect(stats.computable && stats.verdict).toBe('inconclusive');
    expect(stats.observedDelta).toBe(0);
  });
});
