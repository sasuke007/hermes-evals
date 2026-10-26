/**
 * A Reload all as one job per directory (Phase 4 question 9), against a
 * stand-in pg-boss whose jobs move from created to active to their end on
 * each look: the scan, a job per directory, the progress the suite list
 * polls, a directory whose job fails, two suites that swapped names, and
 * which requests share a pass.
 */
import type { PgBoss } from 'pg-boss';
import {
  SuiteReloadProgressSchema,
  SuiteReloadResultSchema,
  type SuiteReloadEntry,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { ReloadAll } from './reload-all.js';

interface Job {
  id: string;
  data: { path: string | null };
  looks: number;
}

const entry = (path: string, overrides: Partial<SuiteReloadEntry> = {}): SuiteReloadEntry => ({
  sourcePath: `./suites/${path}`,
  name: path,
  outcome: 'created',
  suiteId: `suite_${path}`,
  versionNumber: 1,
  changes: { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] },
  message: 'All self-checks passed',
  error: null,
  ...overrides,
});

/** Jobs are created, then active, then end as `answer` says, one step per findJobs. */
class StepBoss {
  readonly jobs: Job[] = [];
  answer: (job: Job) => { state: string; output: unknown } = (job) => ({
    state: 'completed',
    output:
      job.data.path === null
        ? { at: '2026-10-26T10:00:00.000Z', missing: [], directories: ['alpha', 'beta'] }
        : { at: '2026-10-26T10:00:00.000Z', suites: [entry(job.data.path)] },
  });
  /** Holds every job created until opened. */
  gate: Promise<void> = Promise.resolve();

  async send(_queue: string, data: Job['data']): Promise<string> {
    const job = { id: `job_${this.jobs.length + 1}`, data, looks: 0 };
    this.jobs.push(job);
    return job.id;
  }

  async findJobs(_queue: string, options: { id?: string }) {
    const job = this.jobs.find((j) => j.id === options.id);
    if (!job) return [];
    await this.gate;
    job.looks += 1;
    if (job.looks === 1) return [{ id: job.id, state: 'created', output: null }];
    if (job.looks === 2) return [{ id: job.id, state: 'active', output: null }];
    return [{ id: job.id, ...this.answer(job) }];
  }
}

let t: TestDatabase;
let boss: StepBoss;
let all: ReloadAll;
const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  t = await createTestDatabase();
  boss = new StepBoss();
  all = new ReloadAll({
    db: t.db,
    boss: () => boss as unknown as PgBoss,
    logger,
    jobTimeoutMs: 60_000,
    pollMs: 1,
  });
});

afterEach(async () => {
  await t.close();
});

describe('ReloadAll', () => {
  it('scans, sends one job per directory, and reports where each stands', async () => {
    const seen = new Set<string>();
    const watch = setInterval(() => {
      for (const d of all.progress().directories) seen.add(`${d.sourcePath}:${d.state}`);
    }, 0);
    const result = SuiteReloadResultSchema.parse(await all.run());
    clearInterval(watch);
    expect(boss.jobs.map((j) => j.data.path)).toEqual([null, 'alpha', 'beta']);
    expect(result.suites.map((e) => e.sourcePath)).toEqual(['./suites/alpha', './suites/beta']);
    expect(seen).toContain('./suites/alpha:queued');
    expect(seen).toContain('./suites/alpha:loading');
    const progress = SuiteReloadProgressSchema.parse(all.progress());
    expect(progress).toMatchObject({ active: false, startedAt: expect.any(String) });
    expect(progress.directories.map((d) => [d.sourcePath, d.state])).toEqual([
      ['./suites/alpha', 'done'],
      ['./suites/beta', 'done'],
    ]);
  });

  it('reports a directory whose job failed, as a failed row and an error entry', async () => {
    boss.answer = (job) =>
      job.data.path === 'beta'
        ? { state: 'failed', output: { message: 'disk on fire', stack: 'at x' } }
        : new StepBoss().answer(job);
    const result = await all.run();
    expect(result.suites[1]).toMatchObject({
      sourcePath: './suites/beta',
      outcome: 'error',
      message: 'Could not reload: disk on fire',
    });
    expect(all.progress().directories[1]).toMatchObject({ state: 'failed', error: 'disk on fire' });
  });

  it('loads a directory again when another one freed the name it wanted', async () => {
    const taken = entry('alpha', {
      outcome: 'error',
      suiteId: null,
      versionNumber: null,
      message:
        'Could not reload: suite.yaml:1:7 · suite name beta is already used by directory beta; give one of them another name',
    });
    let alphaLoads = 0;
    boss.answer = (job) => {
      if (job.data.path === null) return new StepBoss().answer(job);
      if (job.data.path === 'alpha') alphaLoads += 1;
      const first = job.data.path === 'alpha' && alphaLoads === 1;
      return {
        state: 'completed',
        output: { at: 'x', suites: [first ? taken : entry(job.data.path!)] },
      };
    };
    const result = await all.run();
    expect(boss.jobs.map((j) => j.data.path)).toEqual([null, 'alpha', 'beta', 'alpha']);
    expect(result.suites.map((e) => e.outcome)).toEqual(['created', 'created']);
  });

  it('shares a pass that has read nothing yet, and gives a later request the next pass', async () => {
    let open!: () => void;
    boss.gate = new Promise((resolve) => (open = resolve));
    const a = all.run();
    const b = all.run();
    open();
    // Once the scan is active, a request may have edited files it already read.
    while (!boss.jobs.some((j) => j.data.path === null && j.looks >= 2)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const c = all.run();
    const d = all.run();
    const [ra, rb, rc, rd] = await Promise.all([a, b, c, d]);
    // One result object per pass: a and b shared the first, c and d the next.
    expect(rb).toBe(ra);
    expect(rd).toBe(rc);
    expect(rc).not.toBe(ra);
    expect(boss.jobs.filter((j) => j.data.path === null)).toHaveLength(2);
  });
});
