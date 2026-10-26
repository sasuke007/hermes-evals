/**
 * Every scripts/*mock-scripts.json at once (Phase 6b R8, Phase 6 decision
 * #12): the Phase 6b smoke starts the mock with all of them in MOCK_SCRIPTS,
 * in any order, so every script's phrase must match requests of its own
 * suite only. The mock answers a request with the first script whose
 * `match` occurs in it (apps/egress/src/mock-model.ts).
 *
 * Each capability suite's recommended arms are played as its own spec plays
 * them, by the mock's rule, against its own file alone, with each request
 * built as Hermes builds it for that arm (mcp-v1/support.ts,
 * memory-v1/support.ts, knowledge-v1/arms.ts, tools-v1/arms.ts), and
 * knowledge-v1's judge requests too. Then:
 *
 * - no phrase of any other file occurs in any of those requests;
 * - every request is answered by one of the suite's own scripts, and each
 *   of its scripts answers some request;
 * - no run calls a tool its arm lacks three times in a row, which would end
 *   it in Hermes before the scripted answer;
 * - played again with every file in MOCK_SCRIPTS, its own last and then
 *   first, every request picks the same script;
 * - no Phase 6b phrase occurs in what the earlier phases' runs show the
 *   model: invoices-v1's prompts, fixtures, rubric and skill, the scripts'
 *   own texts, and the Phase 1 to 4 smoke tests' suites. The Phase 6
 *   smoke's requests, MCP results included, are checked against every file
 *   by phase6-smoke.spec.ts.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listFiles,
  MockScriptsSchema,
  readText,
  REPO,
  SUITES_DIR,
  type MockScript,
} from './invoices-v1/support.js';
import { play as playKnowledge, ARMS as KNOWLEDGE_ARMS, readSkills } from './knowledge-v1/arms.js';
import {
  loadKnowledgeSuite,
  mockJudge,
  primaryKey as knowledgePrimary,
  scoreKey as scoreKnowledge,
  TASK_KEYS as KNOWLEDGE_KEYS,
} from './knowledge-v1/support.js';
import { play as playMcp, serverData, TASK_KEYS as MCP_KEYS } from './mcp-v1/support.js';
import { play as playMemory, TASK_KEYS as MEMORY_KEYS } from './memory-v1/support.js';
import { ARM_NAMES as TOOLS_ARMS, play as playTools } from './tools-v1/arms.js';
import { loadToolsSuite, TASK_KEYS as TOOLS_KEYS } from './tools-v1/support.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const CAPABILITY_SUITES = ['mcp-v1', 'memory-v1', 'knowledge-v1', 'tools-v1'] as const;
type Suite = (typeof CAPABILITY_SUITES)[number];
/** Who each mock-scripts file belongs to: a suite, or an earlier phase's smoke. */
const OWNERS: Record<string, string> = {
  'phase2-mock-scripts.json': 'phase2',
  'phase3-mock-scripts.json': 'phase3',
  'phase4-mock-scripts.json': 'phase4',
  'phase6-mock-scripts.json': 'phase6',
  'phase6b-knowledge-v1-mock-scripts.json': 'knowledge-v1',
  'phase6b-mcp-v1-mock-scripts.json': 'mcp-v1',
  'phase6b-memory-v1-mock-scripts.json': 'memory-v1',
  'phase6b-tools-v1-mock-scripts.json': 'tools-v1',
};
const fileOf = (suite: Suite) => `phase6b-${suite}-mock-scripts.json`;

/** One played run: where it ran, each request's text and the match that answered it. */
interface Run {
  name: string;
  /** The arm, as the suite's own play names it. */
  arm: string;
  /** A judge's request rather than the agent's. */
  judge?: boolean;
  requests: string[];
  picks: (string | null)[];
}
type Player = (scripts: readonly MockScript[]) => Promise<Run[]>;

const files = new Map<string, MockScript[]>();
const players = new Map<Suite, Player>();
const own = new Map<Suite, Run[]>();
let scratch = '';
let closers: (() => Promise<void>)[] = [];

const prompt = (suite: string, key: string) => readText(SUITES_DIR, suite, key, 'prompt.md');

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'phase6b-mock-scripts-'));
  for (const name of Object.keys(OWNERS)) {
    files.set(name, MockScriptsSchema.parse(JSON.parse(await readText(REPO, 'scripts', name))));
  }

  const data = await serverData();
  players.set('mcp-v1', async (scripts) => {
    const runs: Run[] = [];
    for (const key of MCP_KEYS) {
      for (const source of ['mcp', 'documents'] as const) {
        const p = playMcp(data, source, await prompt('mcp-v1', key), scripts);
        if (p.answer === null) throw new Error(`mcp-v1 ${key} ${source}: no answer`);
        runs.push({ name: `${key} ${source}`, arm: source, requests: p.requests, picks: p.picked });
      }
    }
    return runs;
  });

  players.set('memory-v1', async (scripts) => {
    const runs: Run[] = [];
    for (const key of MEMORY_KEYS) {
      for (const arm of ['off', 'on'] as const) {
        const p = await playMemory(scripts, key, arm, await prompt('memory-v1', key));
        runs.push({ name: `${key} memory ${arm}`, arm, requests: p.requests, picks: p.picked });
      }
    }
    return runs;
  });

  const skills = await readSkills();
  const knowledge = await loadKnowledgeSuite();
  closers.push(() => knowledge.close());
  players.set('knowledge-v1', async (scripts) => {
    const runs: Run[] = [];
    for (const key of KNOWLEDGE_KEYS) {
      for (const arm of KNOWLEDGE_ARMS) {
        const p = await playKnowledge(scripts, skills, arm, key, await prompt('knowledge-v1', key));
        runs.push({ name: `${key} ${arm}`, arm, requests: p.requests, picks: p.matches });
        const task = knowledge.byKey.get(key)!;
        if (task.verification.find((v) => v.primary)?.type !== 'llm_judge') continue;
        // The judge's request holds the rubric, the prompt, the reference and the reply.
        const judge = mockJudge(scripts);
        await scoreKnowledge(task, knowledgePrimary(task), { text: p.finalText }, judge);
        for (const r of judge.requests) {
          const text = `${r.messages.system}\n${r.messages.user}`;
          const pick = scripts.find((s) => text.includes(s.match))?.match ?? null;
          runs.push({
            name: `${key} ${arm} judge`,
            arm,
            judge: true,
            requests: [text],
            picks: [pick],
          });
        }
      }
    }
    return runs;
  });

  const tools = await loadToolsSuite();
  closers.push(() => tools.close());
  let round = 0;
  players.set('tools-v1', async (scripts) => {
    const runs: Run[] = [];
    const dir = join(scratch, `tools-${(round += 1)}`);
    for (const key of TOOLS_KEYS) {
      for (const arm of TOOLS_ARMS) {
        const p = await playTools(scripts, tools, key, arm, dir);
        runs.push({ name: `${key} ${arm}`, arm, requests: p.requests, picks: p.answeredBy });
      }
    }
    return runs;
  });

  for (const suite of CAPABILITY_SUITES) {
    own.set(suite, await players.get(suite)!(files.get(fileOf(suite))!));
  }
});

afterAll(async () => {
  for (const close of closers) await close();
  closers = [];
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Whether an arm lacks a tool. Hermes answers a call to it with "Tool '<name>'
 * does not exist" and ends the run as partial at the third such turn in a
 * row (agent/turn_tool_validation.py), so a script must never make three.
 */
function lacks(suite: Suite, arm: string, tool: string): boolean {
  if (tool.startsWith('mcp__')) return !(suite === 'mcp-v1' && arm === 'mcp');
  if (tool === 'memory') return !(suite === 'memory-v1' && arm === 'on');
  if (['skill_view', 'skills_list', 'skill_manage'].includes(tool)) {
    return !(suite === 'knowledge-v1' && arm === 'on_demand');
  }
  if (tool === 'execute_code') return !(suite === 'tools-v1' && arm === 'file-terminal-code');
  if (tool === 'terminal') return suite === 'tools-v1' && arm === 'file';
  return false;
}

/** Every other file's scripts, each with its file, in file-name order. */
const foreign = (suite: Suite) =>
  [...files].flatMap(([file, scripts]) =>
    OWNERS[file] === suite ? [] : scripts.map((script) => ({ file, script })),
  );

describe('the mock-scripts files', () => {
  it('are the eight this spec knows, each with its owner', async () => {
    const onDisk = (await readdir(join(REPO, 'scripts'))).filter((f) =>
      f.endsWith('mock-scripts.json'),
    );
    expect(onDisk.sort()).toEqual(Object.keys(OWNERS).sort());
  });

  it('give no two scripts the same phrase', () => {
    const phrases = [...files.values()].flat().map((s) => s.match);
    expect(phrases.length).toBe(new Set(phrases).size);
  });
});

describe.each(CAPABILITY_SUITES)('%s, its recommended arms played', (suite) => {
  it("holds no other file's phrase in any request", () => {
    const found: string[] = [];
    for (const run of own.get(suite)!) {
      for (const [i, text] of run.requests.entries()) {
        for (const { file, script } of foreign(suite)) {
          if (text.includes(script.match))
            found.push(`${file} "${script.match}": ${run.name} #${i + 1}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('answers every request with one of its own scripts, and uses each of them', () => {
    const scripts = files.get(fileOf(suite))!.map((s) => s.match);
    const picks = own.get(suite)!.flatMap((run) => run.picks);
    expect(picks.filter((p) => p === null || !scripts.includes(p))).toEqual([]);
    expect(scripts.filter((m) => !picks.includes(m))).toEqual([]);
  });

  it('never calls a tool its arm lacks three times in a row, where Hermes would end the run', () => {
    const steps = new Map(files.get(fileOf(suite))!.map((s) => [s.match, s.steps]));
    const found: string[] = [];
    let missing = 0;
    for (const run of own.get(suite)!.filter((r) => !r.judge)) {
      let row = 0;
      for (const [i, pick] of run.picks.entries()) {
        const script = steps.get(pick ?? '')!;
        const step = script[Math.min(i, script.length - 1)]!;
        if (!('tool' in step)) continue;
        row = lacks(suite, run.arm, step.tool) ? row + 1 : 0;
        if (row > 0) missing += 1;
        if (row >= 3) found.push(`${run.name}: ${step.tool} at request ${i + 1}`);
      }
    }
    expect(found).toEqual([]);
    // The arms without a tool do meet its calls (memory-v1's scripts never call a missing one).
    expect(missing > 0).toBe(suite !== 'memory-v1' && suite !== 'mcp-v1');
  });

  it('picks the same script for every request with every file in MOCK_SCRIPTS, its own last or first', async () => {
    const others = foreign(suite).map((o) => o.script);
    const mine = files.get(fileOf(suite))!;
    const expected = own.get(suite)!.map((run) => [run.name, run.picks]);
    for (const order of [
      [...others, ...mine],
      [...mine, ...others],
    ]) {
      const runs = await players.get(suite)!(order);
      expect(runs.map((run) => [run.name, run.picks])).toEqual(expected);
    }
  });
});

describe("the earlier phases' runs", () => {
  it('show the model no Phase 6b phrase', async () => {
    const texts: { where: string; text: string }[] = [];
    for (const file of await listFiles(join(SUITES_DIR, 'invoices-v1'))) {
      if (file.endsWith('.py') || file.includes('/expected/')) continue;
      texts.push({
        where: `suites/invoices-v1/${file}`,
        text: await readText(SUITES_DIR, 'invoices-v1', file),
      });
    }
    for (const file of await listFiles(join(REPO, 'samples/skills/invoice-method'))) {
      texts.push({
        where: `invoice-method/${file}`,
        text: await readText(REPO, 'samples/skills/invoice-method', file),
      });
    }
    for (const n of [1, 2, 3, 4]) {
      texts.push({
        where: `phase${n}-smoke.sh`,
        text: await readText(REPO, 'scripts', `phase${n}-smoke.sh`),
      });
    }
    for (const [file, scripts] of files) {
      if (CAPABILITY_SUITES.some((s) => OWNERS[file] === s)) continue;
      for (const s of scripts)
        texts.push({
          where: file,
          text: [s.match, ...s.steps.map((step) => JSON.stringify(step))].join('\n'),
        });
    }
    const found: string[] = [];
    for (const suite of CAPABILITY_SUITES) {
      for (const { match } of files.get(fileOf(suite))!) {
        for (const { where, text } of texts) {
          if (text.includes(match)) found.push(`${suite} "${match}" in ${where}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
