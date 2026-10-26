/**
 * suites/knowledge-v1 through the real loader into PGlite (plan 17, Phase 6b
 * exit; plan 18.5 steps 1 and 2): all eight tasks load valid with no load
 * issue at all, every runnable self-check passes on its reference (the
 * llm_judge and trajectory keys are schema-checked only, plan 4.3), and for
 * every task a scripted reply that falls into its trap fails the primary
 * key while the reference passes it, graded by the real scorers. The one
 * llm_judge primary, house_summary's, is graded by the real scorer with the
 * suite's mock judge.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { LoadIssueSchema, SelfCheckSchema } from '@hermes-evals/shared';
import { taskFiles, tasks } from '../../src/database/schema/index.js';
import {
  knowledgeScripts,
  loadKnowledgeSuite,
  mockJudge,
  primaryKey,
  replyWith,
  runGenerator,
  scoreKey,
  TASK_FILES,
  TASK_KEYS,
  type LoadedSuite,
  type MockScript,
  type TaskKey,
  type Trap,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let suite: LoadedSuite;
let traps: Record<TaskKey, Trap>;
let scripts: MockScript[];
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'knowledge-v1-traps-'));
  traps = await runGenerator(scratch);
  scripts = await knowledgeScripts();
  suite = await loadKnowledgeSuite();
});

afterAll(async () => {
  await suite?.close();
  await rm(scratch, { recursive: true, force: true });
});

const row = (key: TaskKey) => suite.byKey.get(key)!;

describe('loading suites/knowledge-v1', () => {
  it('creates a version with the eight tasks in suite.yaml order, every one valid', () => {
    expect(suite.entry).toMatchObject({
      name: 'knowledge-v1',
      outcome: 'created',
      versionNumber: 1,
      error: null,
    });
    expect(suite.rows.map((r) => r.key)).toEqual([...TASK_KEYS]);
    for (const r of suite.rows) {
      expect(r, r.key).toMatchObject({ valid: true, invalidReason: null });
    }
  });

  it('reports no load issue, not even a warning', () => {
    for (const r of suite.rows) {
      for (const issue of r.loadIssues) LoadIssueSchema.parse(issue);
      expect(r.loadIssues, r.key).toEqual([]);
    }
  });

  it('passes every runnable self-check on the reference, and skips only the judge and trajectory keys', () => {
    for (const r of suite.rows) {
      const check = SelfCheckSchema.parse(r.selfCheck);
      expect(check.status, r.key).toBe('passed');
      for (const result of check.results) {
        expect(result.expect ?? 'pass', `${r.key}.${result.key}`).toBe('pass');
        if (result.mode === 'none') {
          expect(['trajectory_match', 'llm_judge'], `${r.key}.${result.key}`).toContain(
            result.type,
          );
          expect(result.status).toBe('skipped');
        } else {
          expect(result.mode, `${r.key}.${result.key}`).toBe('answer');
          expect(result.status, `${r.key}.${result.key}: ${result.comment}`).toBe('passed');
        }
      }
    }
    const modes = (key: TaskKey) =>
      row(key).selfCheck.results.map((r) => [r.key, r.mode, r.status]);
    expect(modes('house_summary')).toEqual([
      ['style', 'none', 'skipped'],
      ['title_format', 'answer', 'passed'],
      ['date_format', 'answer', 'passed'],
    ]);
    expect(modes('large_file')).toEqual([
      ['answer', 'answer', 'passed'],
      ['runs_program', 'none', 'skipped'],
    ]);
  });

  it('stores one fixture per task, the file the prompt names, and the rubric: nothing else', async () => {
    const files = await suite.db.db
      .select({ key: tasks.key, path: taskFiles.path, kind: taskFiles.kind })
      .from(taskFiles)
      .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(eq(tasks.suiteId, suite.entry.suiteId!))
      .orderBy(asc(tasks.key), asc(taskFiles.path));
    expect(files.filter((f) => f.kind !== 'fixture').map((f) => [f.key, f.path, f.kind])).toEqual([
      ['house_summary', 'rubric.md', 'rubric'],
    ]);
    const fixtures = files.filter((f) => f.kind === 'fixture');
    expect(Object.fromEntries(fixtures.map((f) => [f.key, f.path]))).toEqual(
      Object.fromEntries(TASK_KEYS.map((k) => [k, `fixtures/${TASK_FILES[k].file}`])),
    );
    expect(fixtures).toHaveLength(TASK_KEYS.length);
    for (const key of TASK_KEYS) expect(row(key).prompt, key).toContain(TASK_FILES[key].file);
  });
});

describe('each task against its trap', () => {
  it.each(TASK_KEYS)(
    '%s: the reference passes the primary key, and the trap answer fails it',
    async (key) => {
      const task = row(key);
      const primary = primaryKey(task);
      const judge = mockJudge(scripts);
      const right = await scoreKey(task, primary, { text: replyWith(task.reference) }, judge);
      expect(right.status, `${key} reference: ${right.comment}`).toBe('passed');
      const wrong = await scoreKey(task, primary, { text: replyWith(traps[key].answer) }, judge);
      expect(wrong.status, `${key} trap (${traps[key].note}): ${wrong.comment}`).toBe('failed');
    },
  );

  it("fails house_summary's title and date checks on the plain review, and passes them on the reference", async () => {
    for (const key of ['title_format', 'date_format']) {
      const right = await scoreKey(row('house_summary'), key, {
        text: replyWith(row('house_summary').reference),
      });
      expect(right.status, key).toBe('passed');
      const wrong = await scoreKey(row('house_summary'), key, {
        text: replyWith(traps.house_summary.answer),
      });
      expect(wrong.status, key).toBe('failed');
    }
  });

  it('grades house_summary with the judge on the reply, never on the reference alone', async () => {
    const judge = mockJudge(scripts);
    const right = await scoreKey(
      row('house_summary'),
      'style',
      { text: replyWith(row('house_summary').reference) },
      judge,
    );
    expect(right).toMatchObject({ status: 'passed', score: 0.9 });
    const wrong = await scoreKey(
      row('house_summary'),
      'style',
      { text: replyWith(traps.house_summary.answer) },
      judge,
    );
    expect(wrong).toMatchObject({ status: 'failed', score: 0.2 });
    // Both requests carry the reference: only the reply's own title tells them apart.
    const { title } = row('house_summary').reference as { title: string };
    for (const request of judge.requests) expect(request.messages.system).toContain(title);
    expect(judge.requests[1]!.messages.user).toContain(
      traps.house_summary.answer['title'] as string,
    );
  });

  it('passes large_file’s program key only for a run that used the terminal', async () => {
    const terminal = await scoreKey(row('large_file'), 'runs_program', {
      text: replyWith(row('large_file').reference),
      calls: [{ name: 'terminal', input: { command: 'python3 bx7.py statement_2026_q2.bx7' } }],
    });
    expect(terminal.status).toBe('passed');
    const byHand = await scoreKey(row('large_file'), 'runs_program', {
      text: replyWith(row('large_file').reference),
      calls: [{ name: 'read_file', input: { path: '/workspace/statement_2026_q2.bx7' } }],
    });
    expect(byHand.status).toBe('failed');
  });

  it('grades a reply without an answer block ungradable on answer keys', async () => {
    const none = await scoreKey(row('closing_balance'), 'answer', { text: 'About 2,000 EUR.' });
    expect(none.status).toBe('ungradable');
  });
});
