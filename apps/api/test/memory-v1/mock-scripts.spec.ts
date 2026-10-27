/**
 * scripts/phase6b-memory-v1-mock-scripts.json, the mock model's scripts for
 * the memory-v1 experiment (memory off · memory on, plan 18.3 and 18.5 step
 * 3), checked without a stack. The mock plays the n-th step of the first
 * script whose `match` occurs anywhere in the request's messages, n being the
 * tool results so far (apps/egress/src/mock-model.ts). Each request below is
 * built as Hermes would send it: with memory on, the system prompt carries
 * the seeds as Hermes renders them; with memory off it carries none; then
 * the prompt, then each tool call so far with its result. Every request of
 * either arm picks the script meant for it, whatever the order of
 * MOCK_SCRIPTS, the replies make real Hermes tool calls before they answer,
 * and the answers grade as the experiment should come out: memory on passes
 * all eight tasks; memory off fails the five only memory can answer and
 * passes the three where memory can only mislead, so the comparison reads
 * better, Δ +0.625.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { bootstrapInterval } from '../../src/statistics/bootstrap.js';
import { seedFromExperimentId } from '../../src/statistics/compute.js';
import { DEFAULT_CONFIDENCE, DEFAULT_RESAMPLES } from '../../src/statistics/contracts.js';
import { verdictOf } from '../../src/statistics/tally.js';
import { memoryEntries } from '../../src/suites/loader/home-seeds.js';
import {
  afterMemoryAdd,
  listFiles,
  loadMemorySuite,
  MEMORY_CAN_ONLY_MISLEAD,
  memoryBlocks,
  MOCK_SCRIPTS,
  MockScriptsSchema,
  primaryKey,
  readText,
  REPO,
  scoreKey,
  seedsOf,
  SUITE_DIR,
  TASK_KEYS,
  toolResult,
  type Arm,
  type LoadedSuite,
  type MockScript,
  type RecordedRun,
  type TaskKey,
  type ToolStep,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** Another phase's or suite's script, read leniently: only what a request could match or hold. */
const OtherScriptsSchema = z.array(
  z.object({
    match: z.string(),
    steps: z.array(z.record(z.string(), z.unknown())),
  }),
);

let suite: LoadedSuite;
let scripts: MockScript[];
let others: { file: string; match: string; texts: string[] }[];
let prompts: Record<TaskKey, string>;

beforeAll(async () => {
  scripts = MockScriptsSchema.parse(JSON.parse(await readText(REPO, MOCK_SCRIPTS)));
  prompts = Object.fromEntries(
    await Promise.all(TASK_KEYS.map(async (k) => [k, await readText(SUITE_DIR, k, 'prompt.md')])),
  ) as Record<TaskKey, string>;
  const files = (await readdir(join(REPO, 'scripts'))).filter(
    (f) => /^phase.*-mock-scripts\.json$/.test(f) && `scripts/${f}` !== MOCK_SCRIPTS,
  );
  others = [];
  for (const file of files) {
    for (const s of OtherScriptsSchema.parse(JSON.parse(await readText(REPO, 'scripts', file)))) {
      others.push({ file, match: s.match, texts: s.steps.map((step) => JSON.stringify(step)) });
    }
  }
  suite = await loadMemorySuite();
});

afterAll(() => suite?.close());

const seedScript = (key: TaskKey) => scripts[TASK_KEYS.indexOf(key)]!;
const promptScript = (key: TaskKey) => scripts[TASK_KEYS.length + TASK_KEYS.indexOf(key)]!;
const armScript = (key: TaskKey, arm: Arm) => (arm === 'on' ? seedScript(key) : promptScript(key));
const toolSteps = (s: MockScript): ToolStep[] =>
  s.steps.flatMap((step) => ('tool' in step ? [step] : []));
const finalText = (s: MockScript) => {
  const last = s.steps.at(-1)!;
  if (!('content' in last)) throw new Error(`${s.match}: the last step is not an answer`);
  return last.content;
};

/** The text of each request one arm's run sends, step by step, as the mock reads it. */
async function requests(key: TaskKey, arm: Arm): Promise<string[]> {
  const sent = [arm === 'on' ? await memoryBlocks(key) : 'You are Hermes.', prompts[key]];
  const texts: string[] = [];
  for (const step of armScript(key, arm).steps) {
    texts.push(sent.join('\n'));
    if ('tool' in step) sent.push(JSON.stringify(step.arguments), await toolResult(key, step));
  }
  return texts;
}

/** What one arm's run leaves behind, as the evaluation reads it (memory off: no home, Phase 8 G9). */
async function recorded(key: TaskKey, arm: Arm): Promise<RecordedRun> {
  const s = armScript(key, arm);
  const steps = toolSteps(s);
  const seeds = await seedsOf(key);
  const home: Record<string, string> = {};
  for (const step of steps.filter((t) => t.tool === 'memory')) {
    const file = step.arguments.target === 'memory' ? 'memories/MEMORY.md' : 'memories/USER.md';
    home[file] = afterMemoryAdd(
      home[file] ?? seeds[file]!,
      z.string().parse(step.arguments.content),
    );
  }
  return {
    text: finalText(s),
    calls: steps.map((step) => ({ name: step.tool, input: step.arguments })),
    home,
    ...(arm === 'off' ? { memoryOff: true as const } : {}),
    files: Object.fromEntries(
      steps
        .filter((step) => step.tool === 'write_file')
        .map((step) => [
          z
            .string()
            .parse(step.arguments.path)
            .replace(/^\/workspace\//, ''),
          z.string().parse(step.arguments.content),
        ]),
    ),
  };
}

const passes = async (key: TaskKey, arm: Arm, name?: string) => {
  const task = suite.byKey.get(key)!;
  return scoreKey(task, name ?? primaryKey(task), await recorded(key, arm));
};

describe('the scripts file', () => {
  it('holds one seed script per task, then one prompt script per task', () => {
    expect(scripts.map((s) => s.match)).toEqual([
      ...TASK_KEYS.map((_, i) => `ref mv1-s0${i + 1}`),
      ...TASK_KEYS.map((_, i) => `Ticket mv1-t0${i + 1}`),
    ]);
  });

  it('makes real Hermes tool calls before every answer, in the workspace', () => {
    for (const s of scripts) {
      const tools = toolSteps(s);
      expect(tools.length, s.match).toBeGreaterThan(0);
      expect(
        s.steps.slice(0, -1).every((step) => 'tool' in step),
        s.match,
      ).toBe(true);
      expect(finalText(s), s.match).toMatch(/```json\n.+\n```$/);
      for (const step of tools) {
        expect(['read_file', 'memory', 'write_file'], s.match).toContain(step.tool);
        if (step.tool !== 'memory') expect(step.arguments.path, s.match).toMatch(/^\/workspace\//);
      }
    }
    expect(toolSteps(seedScript('remember_this'))).toEqual([
      {
        tool: 'memory',
        arguments: { action: 'add', target: 'user', content: expect.stringContaining('@') },
      },
    ]);
  });
});

describe('which script answers which request', () => {
  it("puts each seed marker in one entry of its own task's seed and nowhere else in the suite", async () => {
    // remember_this's expected home holds its seed too, but no trial ever receives it.
    const files = (await listFiles(SUITE_DIR)).filter(
      (f) => !f.endsWith('.py') && !f.includes('/expected_home/'),
    );
    const texts = await Promise.all(files.map((f) => readText(SUITE_DIR, f)));
    for (const key of TASK_KEYS) {
      const holders = files.filter((_, i) => texts[i]!.includes(seedScript(key).match));
      expect(holders, key).toHaveLength(1);
      expect(holders[0], key).toMatch(new RegExp(`^${key}/home/memories/(USER|MEMORY)\\.md$`));
      const entries = memoryEntries(texts[files.indexOf(holders[0]!)]!);
      expect(
        entries.filter((e) => e.includes(seedScript(key).match)),
        key,
      ).toHaveLength(1);
      const prompted = files.filter((_, i) => texts[i]!.includes(promptScript(key).match));
      expect(prompted, key).toEqual([`${key}/prompt.md`]);
      expect(prompts[key].split('\n')[0], key).toBe(`${promptScript(key).match}.`);
    }
  });

  it.each(TASK_KEYS)(
    '%s: every request of either arm picks that arm’s script, before or after every other file’s scripts',
    async (key) => {
      for (const arm of ['off', 'on'] as const) {
        const all = [...scripts.map((s) => s.match), ...others.map((o) => o.match)];
        const reversed = [...others.map((o) => o.match), ...scripts.map((s) => s.match)];
        for (const text of await requests(key, arm)) {
          const pick = (order: string[]) => order.find((m) => text.includes(m)) ?? null;
          expect(pick(all), `${key} ${arm}`).toBe(armScript(key, arm).match);
          expect(pick(reversed), `${key} ${arm}`).toBe(armScript(key, arm).match);
        }
      }
    },
  );

  it('holds no memory-v1 phrase in any other suite, sample or script, nor any other phrase in a memory-v1 request', async () => {
    const outside: { where: string; text: string }[] = [];
    for (const dir of ['suites', 'samples']) {
      for (const file of await listFiles(join(REPO, dir))) {
        if (dir === 'suites' && file.startsWith('memory-v1/')) continue;
        outside.push({ where: `${dir}/${file}`, text: await readText(REPO, dir, file) });
      }
    }
    for (const file of [
      'docker/mcp/invoice-db/invoices.csv',
      'docker/mcp/vendor-directory/vendors.json',
    ]) {
      outside.push({ where: file, text: await readText(REPO, file) });
    }
    for (const o of others) outside.push({ where: o.file, text: [o.match, ...o.texts].join('\n') });
    for (const s of scripts) {
      for (const { where, text } of outside) {
        expect(text.includes(s.match), `${s.match} in ${where}`).toBe(false);
      }
    }
    const inside = [
      ...(
        await Promise.all(TASK_KEYS.flatMap((k) => [requests(k, 'on'), requests(k, 'off')]))
      ).flat(),
      ...scripts.map(finalText),
    ];
    for (const o of others) {
      expect(
        inside.some((text) => text.includes(o.match)),
        `${o.file}: ${o.match}`,
      ).toBe(false);
    }
  });
});

describe('how the experiment grades', () => {
  it.each(TASK_KEYS)('%s: memory on passes the primary key', async (key) => {
    const result = await passes(key, 'on');
    expect(result.status, `${key}: ${result.comment}`).toBe('passed');
  });

  it.each(TASK_KEYS)('%s: memory off passes only where memory can only mislead', async (key) => {
    const result = await passes(key, 'off');
    expect(result.status, `${key}: ${result.comment}`).toBe(
      MEMORY_CAN_ONLY_MISLEAD.includes(key) ? 'passed' : 'failed',
    );
  });

  it('grades the secondary keys the same way', async () => {
    expect((await passes('usual_currency', 'on', 'currency')).status).toBe('passed');
    expect((await passes('usual_currency', 'off', 'currency')).status).toBe('failed');
    expect((await passes('prompt_wins', 'on', 'currency')).status).toBe('passed');
    expect((await passes('prompt_wins', 'off', 'currency')).status).toBe('passed');
    expect((await passes('remember_this', 'on', 'used_memory')).status).toBe('passed');
    expect((await passes('remember_this', 'off', 'used_memory')).status).toBe('failed');
  });

  it("leaves remember_this's expected home with memory on, and no memory with memory off", async () => {
    const on = await recorded('remember_this', 'on');
    const expected = await readText(SUITE_DIR, 'remember_this/expected_home/memories/USER.md');
    expect(on.home?.['memories/USER.md']).toBe(expected.trimEnd());
    const off = await recorded('remember_this', 'off');
    expect(off).toMatchObject({ home: {}, memoryOff: true });
    expect(Object.keys(off.files ?? {})).toEqual(['preferences.md']);
    // Phase 8 G9: the verifier finds no memory file at all, not the seeds left as they were.
    const saved = await passes('remember_this', 'off');
    expect(saved).toMatchObject({ status: 'failed', score: 0 });
    expect(saved.comment).toContain('neither memories/USER.md nor memories/MEMORY.md exists');
  });

  it('asks remember_this to save the preference in memory, not as a skill (Phase 8 G10)', () => {
    // The real model, asked only to remember it, wrote skills/vendor-email-drafting/SKILL.md.
    expect(prompts.remember_this).toContain('save it in your memory, not as a skill');
    expect(toolSteps(seedScript('remember_this')).map((step) => step.tool)).toEqual(['memory']);
  });

  it('reads better, 5 tasks improved and 3 unchanged, Δ +0.625, whatever the experiment id seeds the bootstrap with', async () => {
    const deltas: number[] = [];
    for (const key of TASK_KEYS) {
      const on = (await passes(key, 'on')).status === 'passed' ? 1 : 0;
      const off = (await passes(key, 'off')).status === 'passed' ? 1 : 0;
      deltas.push(on - off);
    }
    expect(deltas.filter((d) => d === 1)).toHaveLength(5);
    expect(deltas.filter((d) => d === 0)).toHaveLength(3);
    expect(deltas.reduce((s, d) => s + d, 0) / deltas.length).toBe(0.625);
    for (const id of ['01M5TV2A6YVJTSYCBDWFYMXMC4', '01M6B0000000000000000000AA', 'memory-v1']) {
      const { lo, hi } = bootstrapInterval(deltas, {
        seed: seedFromExperimentId(id),
        resamples: DEFAULT_RESAMPLES,
        confidence: DEFAULT_CONFIDENCE,
      });
      expect(verdictOf(lo, hi, false), id).toBe('better');
      expect(lo, id).toBeGreaterThanOrEqual(0.25);
    }
  });
});
