/**
 * scripts/phase6b-knowledge-v1-mock-scripts.json, the mock model's scripts
 * for knowledge-v1's experiment (none · documents · skills preloaded ·
 * skills on demand, plan 18.3 and 18.5 step 3, Phase 6b R8), checked
 * without a stack. Each arm's run is played as the mock plays it (the first
 * script whose `match` occurs in the request; its step chosen by the tool
 * results so far, the last step repeated): the request holds what Hermes
 * puts in it for that arm (the preloaded skills, or the skills index on
 * demand), and each tool call is answered from the files that arm's trial
 * holds, bx7.py run for real. The replies are graded by the real scorers,
 * house_summary's judge by the same scripts, and the comparison by the real
 * statistics module: each knowledge arm reads `better` than none. No
 * knowledge-v1 phrase occurs in another suite's texts, and no other
 * suite's phrase in knowledge-v1's, so the order of MOCK_SCRIPTS never
 * matters.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { computeComparisonStats, seedFromExperimentId } from '../../src/statistics/compute.js';
import type { StatsRun, StatsTask } from '../../src/statistics/contracts.js';
import { ARMS, isTool, KNOWLEDGE_ARMS, play, readSkills, type Arm, type Played } from './arms.js';
import {
  DOCUMENTS,
  DOCUMENTS_DIR,
  frontMatter,
  knowledgeScripts,
  listFiles,
  loadKnowledgeSuite,
  MARKERS,
  mockJudge,
  MOCK_SCRIPTS,
  primaryKey,
  readText,
  REPO,
  SKILL_NAMES,
  skillBody,
  scoreKey,
  SUITE_DIR,
  SUITES_DIR,
  TASK_FILES,
  TASK_KEYS,
  type LoadedSuite,
  type MockScript,
  type RecordedRun,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERMES_TOOLS = ['read_file', 'terminal', 'skill_view'];

let scripts: MockScript[];
let suite: LoadedSuite;
let skills: Map<string, string>;
const prompts = {} as Record<TaskKey, string>;
const played = new Map<string, Played>();

const finalText = (s: MockScript): string => {
  const last = s.steps.at(-1)!;
  if (isTool(last)) throw new Error(`${s.match}: the last step is not an answer`);
  return last.content;
};

const run = (arm: Arm, key: TaskKey) => played.get(`${arm}/${key}`)!;
const recorded = (p: Played): RecordedRun => ({ text: p.finalText, calls: p.calls });

beforeAll(async () => {
  scripts = await knowledgeScripts();
  skills = await readSkills();
  for (const key of TASK_KEYS) prompts[key] = await readText(SUITE_DIR, key, 'prompt.md');
  for (const arm of ARMS) {
    for (const key of TASK_KEYS) {
      played.set(`${arm}/${key}`, await play(scripts, skills, arm, key, prompts[key]));
    }
  }
  suite = await loadKnowledgeSuite();
});

afterAll(() => suite?.close());

const parserLine = (key: TaskKey) => `file ${TASK_FILES[key].file}: format BX07,`;
const baseOf = (key: TaskKey) => scripts.find((s) => prompts[key].includes(s.match))!;

describe('the scripts file', () => {
  it('holds judges, chains of one step each, and a four-step script per statement task', () => {
    expect(scripts).toHaveLength(20);
    const multi = scripts.filter((s) => s.steps.length > 1);
    expect(multi.map((s) => s.steps.length)).toEqual([2, 4, 4, 4, 4, 4, 4, 4]);
    for (const s of scripts) {
      for (const step of s.steps.filter(isTool)) expect(HERMES_TOOLS, s.match).toContain(step.tool);
      if (s.steps.length > 1) expect(finalText(s), s.match).toMatch(/```json\n.+\n```$/);
    }
    for (const key of TASK_KEYS.filter((k) => TASK_FILES[k].statement)) {
      expect(baseOf(key).steps.slice(0, 3)).toEqual([
        { tool: 'skill_view', arguments: { name: 'bx7-format' } },
        { tool: 'read_file', arguments: { path: '/workspace/docs/bx7-spec.md' } },
        { tool: 'read_file', arguments: { path: `/workspace/${TASK_FILES[key].file}` } },
      ]);
    }
  });

  it('keeps each phrase where it belongs', async () => {
    const texts = new Map<string, string>([
      ...TASK_KEYS.map((k) => [`${k}/prompt.md`, prompts[k]] as const),
      ...[...skills].map(([p, t]) => [`skill ${p}`, t] as const),
      ...DOCUMENTS.map((d) => [`doc ${d.doc}`, ''] as const),
    ]);
    for (const { doc } of DOCUMENTS) texts.set(`doc ${doc}`, await readText(DOCUMENTS_DIR, doc));
    for (const key of TASK_KEYS) {
      texts.set(`${key}/fixture`, await readText(SUITE_DIR, key, 'fixtures', TASK_FILES[key].file));
    }
    const holders = (phrase: string) =>
      [...texts].filter(([, t]) => t.includes(phrase)).map(([p]) => p);
    for (const key of TASK_KEYS)
      expect(holders(baseOf(key).match), key).toEqual([`${key}/prompt.md`]);
    expect(holders(MARKERS.bx7)).toEqual(['skill bx7-format/SKILL.md', 'doc bx7-spec.md']);
    expect(frontMatter(skills.get('bx7-format/SKILL.md')!).description).not.toContain('kv1-');
    expect(holders(MARKERS.codes)).toEqual(['skill bx7-format/codes.md', 'doc codes.md']);
    expect(holders(MARKERS.template)).toEqual([
      'skill house-style/templates/summary-template.md',
      'doc summary-template.md',
    ]);
    expect(holders(MARKERS.house)).toEqual(['skill house-style/SKILL.md', 'doc house-style.md']);
    expect(holders(MARKERS.bx6)).toEqual(['skill bx6-format/SKILL.md', 'doc bx6-spec.md']);
    // What only bx7.py prints, and the judges' titles, are in no file an agent can read.
    const judgeTitles = scripts.slice(0, 2).map((s) => s.match);
    for (const phrase of [...TASK_KEYS.map(parserLine), ...judgeTitles]) {
      expect(holders(phrase), phrase).toEqual([]);
    }
    // ...nor in any argument a script sends, which later requests hold.
    const args = scripts.flatMap((s) =>
      s.steps.filter(isTool).map((t) => JSON.stringify(t.arguments)),
    );
    for (const s of scripts) {
      for (const a of args) expect(a.includes(s.match), `${s.match} in ${a}`).toBe(false);
    }
  });
});

describe('each arm’s run, as the mock plays it', () => {
  it.each(TASK_KEYS)(
    '%s: the knowledge reaches each knowledge arm the way that arm delivers it',
    (key) => {
      const knowledge = MARKERS.bx7;
      if (key === 'unrelated') {
        for (const arm of ARMS) {
          expect(run(arm, key).matches, arm).toEqual([baseOf(key).match, baseOf(key).match]);
        }
        return;
      }
      const tail = (() => {
        if (key === 'reason_codes') return [parserLine(key), MARKERS.codes];
        if (key === 'house_summary') return [parserLine(key), MARKERS.template];
        return [parserLine(key)];
      })();
      const base = baseOf(key).match;
      expect(run('preload', key).matches).toEqual([knowledge, ...tail]);
      expect(run('on_demand', key).matches).toEqual([base, knowledge, ...tail]);
      expect(run('docs', key).matches).toEqual([base, base, knowledge, ...tail]);
      expect(run('none', key).matches).toEqual([base, base, base, base]);
      // On demand the agent opens the skill; with the documents it reads the file.
      expect(run('on_demand', key).calls[0]).toMatchObject({ name: 'skill_view' });
      expect(run('on_demand', key).calls[0]!.output).toContain(knowledge);
      expect(run('docs', key).calls[1]).toMatchObject({
        name: 'read_file',
        input: { path: '/workspace/docs/bx7-spec.md' },
      });
      expect(run('docs', key).calls[1]!.output).toContain(knowledge);
      for (const arm of KNOWLEDGE_ARMS) {
        const parser = run(arm, key).calls.find((c) => c.name === 'terminal')!;
        expect(parser.output, arm).toContain('BX-7 reader report');
      }
      for (const call of run('none', key).calls) expect(call.output).not.toContain('kv1-');
    },
  );

  it.each(TASK_KEYS)(
    '%s: the primary key passes in each knowledge arm, and only the control passes with none',
    async (key) => {
      const task = suite.byKey.get(key)!;
      for (const arm of ARMS) {
        const result = await scoreKey(
          task,
          primaryKey(task),
          recorded(run(arm, key)),
          mockJudge(scripts),
        );
        const passes = arm !== 'none' || key === 'unrelated';
        expect(result.status, `${arm}/${key}: ${result.comment}`).toBe(
          passes ? 'passed' : 'failed',
        );
      }
    },
  );

  it("passes large_file's program key and house_summary's format keys only with the knowledge", async () => {
    for (const arm of ARMS) {
      const expected = arm === 'none' ? 'failed' : 'passed';
      const program = await scoreKey(
        suite.byKey.get('large_file')!,
        'runs_program',
        recorded(run(arm, 'large_file')),
      );
      expect(program.status, arm).toBe(expected);
      for (const key of ['title_format', 'date_format']) {
        const style = await scoreKey(
          suite.byKey.get('house_summary')!,
          key,
          recorded(run(arm, 'house_summary')),
        );
        expect(style.status, `${arm} ${key}`).toBe(expected);
      }
    }
  });

  it('answers the judge by the review’s own title: 0.9 for the house style, 0.2 for the plain one', async () => {
    const task = suite.byKey.get('house_summary')!;
    for (const arm of ARMS) {
      const judge = mockJudge(scripts);
      const result = await scoreKey(task, 'style', recorded(run(arm, 'house_summary')), judge);
      expect(result.score, arm).toBe(arm === 'none' ? 0.2 : 0.9);
      expect(judge.requests).toHaveLength(1);
    }
  });

  it('reads better for each knowledge arm against none: 7 tasks improved, the control unchanged', async () => {
    const rate = async (arm: Arm, key: TaskKey): Promise<StatsRun> => {
      const task = suite.byKey.get(key)!;
      const result = await scoreKey(
        task,
        primaryKey(task),
        recorded(run(arm, key)),
        mockJudge(scripts),
      );
      return {
        passed: result.status === 'passed',
        keyStatus: result.status,
        executionError: null,
        durationS: 10,
        tokens: 100,
      };
    };
    for (const arm of KNOWLEDGE_ARMS) {
      const tasks: StatsTask[] = [];
      for (const key of TASK_KEYS) {
        // Two repetitions, as the smoke runs them: the mock plays the same run twice.
        const base = await rate('none', key);
        const candidate = await rate(arm, key);
        tasks.push({ taskKey: key, baseline: [base, base], candidate: [candidate, candidate] });
      }
      const stats = computeComparisonStats(
        {
          tasks,
          repetitions: 2,
          provisional: false,
          labels: { baseline: 'none', candidate: arm },
          progress: { scored: 32, total: 32 },
          costUsd: { baseline: 0, candidate: 0 },
        },
        { seed: seedFromExperimentId(`knowledge-v1-${arm}`) },
      );
      expect(stats.computable, arm).toBe(true);
      if (!stats.computable) continue;
      expect(stats.verdict, arm).toBe('better');
      expect(stats.observedDelta, arm).toBeCloseTo(0.875, 9);
      expect(stats.taskCounts, arm).toEqual({ improved: 7, regressed: 0, unchanged: 1 });
      expect(stats.lo, arm).toBeGreaterThan(0);
    }
  });
});

/** Every text file under `dir`, by its path from the repository root, leaving `skip` out. */
async function textsUnder(
  dir: string,
  skip: (path: string) => boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const file of await listFiles(dir)) {
    const path = relative(REPO, join(dir, file));
    if (skip(path)) continue;
    const bytes = await readFile(join(dir, file));
    if (!bytes.includes(0)) out.set(path, bytes.toString('utf8'));
  }
  return out;
}

/** Every other mock-scripts file of the repository (scripts/*mock-scripts.json but this suite's): its phrases and its text. */
async function otherScripts(): Promise<Map<string, { matches: string[]; text: string }>> {
  const names = (await readdir(join(REPO, 'scripts'))).filter(
    (f) => f.endsWith('mock-scripts.json') && `scripts/${f}` !== MOCK_SCRIPTS,
  );
  const out = new Map<string, { matches: string[]; text: string }>();
  for (const name of names) {
    const text = await readText(REPO, 'scripts', name);
    const list = z.array(z.looseObject({ match: z.string().min(1) })).parse(JSON.parse(text));
    out.set(name, { matches: list.map((s) => s.match), text });
  }
  return out;
}

describe('the scripts and the other suites', () => {
  it('match nothing another suite, sample or mock script can put in a request', async () => {
    const others = new Map([
      ...(await textsUnder(SUITES_DIR, (p) => p.startsWith('suites/knowledge-v1/'))),
      ...(await textsUnder(join(REPO, 'samples'), (p) =>
        [...SKILL_NAMES.map((n) => `samples/skills/${n}/`), 'samples/documents/knowledge-v1/'].some(
          (m) => p.startsWith(m),
        ),
      )),
      ...(await textsUnder(join(REPO, 'docker/mcp'), () => false)),
    ]);
    for (const [name, other] of await otherScripts()) others.set(`scripts/${name}`, other.text);
    expect(others.has('suites/invoices-v1/total_due/prompt.md')).toBe(true);
    for (const s of scripts) {
      for (const [path, text] of others)
        expect(text.includes(s.match), `${s.match} in ${path}`).toBe(false);
    }
  });

  it("holds no other script's phrase in anything knowledge-v1's runs can show the model", async () => {
    const ours = [
      ...(await textsUnder(SUITE_DIR, () => false)).values(),
      ...skills.values(),
      ...(await textsUnder(DOCUMENTS_DIR, () => false)).values(),
      ...[...played.values()].flatMap((p) => [p.finalText, ...p.calls.map((c) => c.output)]),
      JSON.stringify(scripts),
    ];
    const phrases = [...(await otherScripts())].flatMap(([name, other]) =>
      other.matches.map((match) => [name, match] as const),
    );
    expect(phrases.length).toBeGreaterThan(0);
    for (const [name, phrase] of phrases) {
      for (const text of ours) expect(text.includes(phrase), `${name}: ${phrase}`).toBe(false);
    }
  });
});

describe('the documents arm and the skills arms', () => {
  it('ship the same text', async () => {
    for (const { doc, skill } of DOCUMENTS) {
      const text = skills.get(skill)!;
      const expected = skill.endsWith('SKILL.md') ? skillBody(text) : text;
      expect(await readText(DOCUMENTS_DIR, doc), doc).toBe(expected);
    }
  });
});
