/**
 * Launch under real concurrency, on Postgres 17 through node-postgres with
 * the real pg-boss on the same database: rows and jobs commit together or
 * not at all, and the freeze orders a launch against an edit of the same
 * configuration (plan 7.1), whichever comes first.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  LaunchExperimentResultSchema,
  type LaunchExperimentInput,
} from '@hermes-evals/shared';
import { ConfigurationWritesService } from '../../configurations/configuration-writes.service.js';
import { configurationInput } from '../../configurations/support-spec.js';
import {
  configurations,
  configurationVersions,
  experiments,
  runs,
} from '../../database/schema/index.js';
import { newId } from '../../database/ids.js';
import type { CommandsApp } from './commands-app.support-spec.js';
import {
  createE2eDatabase,
  holdLocks,
  SERVER_URL,
  started,
  waitForLockWaits,
  type E2eDatabase,
} from './commands-e2e.support-spec.js';
import {
  experimentRow,
  MOCK_BASE_URL,
  MOCK_MODEL,
  seedConfiguration,
  seedSuite,
  seedWorker,
  sha,
  type SeededConfiguration,
  type SeededSuite,
} from './commands-seed.support-spec.js';

interface Arm {
  versionId: string;
  configHash: string;
}

const launchBody = (
  suite: SeededSuite,
  base: Arm,
  cand: Arm,
  repetitions = 1,
): LaunchExperimentInput => ({
  name: 'Skill vs no skill',
  description: '',
  suiteId: suite.id,
  taskKeys: [...suite.taskIds.keys()],
  baselineVersionId: base.versionId,
  candidateVersionIds: [cand.versionId],
  repetitions,
  concurrency: 2,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  expectedConfigHashes: { [base.versionId]: base.configHash, [cand.versionId]: cand.configHash },
});

const refusal = (res: { body: unknown }) => ApiErrorBodySchema.parse(res.body).message;

describe.skipIf(!SERVER_URL)('launch on Postgres 17', () => {
  let e2e: E2eDatabase;
  let c: CommandsApp;

  beforeEach(async () => {
    e2e = await createE2eDatabase('launch_e2e');
    c = e2e.c;
  });

  afterEach(() => e2e.close());

  /** Nothing of a refused launch remains: no experiment, run or job, and no version frozen. */
  async function expectNothingLaunched(): Promise<void> {
    expect(await c.t.db.select({ id: experiments.id }).from(experiments)).toEqual([]);
    expect(await c.t.db.select({ id: runs.id }).from(runs)).toEqual([]);
    expect(await c.jobs()).toEqual([]);
    const versions = await c.t.db
      .select({ frozenAt: configurationVersions.frozenAt })
      .from(configurationVersions);
    expect(versions.every((v) => v.frozenAt === null)).toBe(true);
  }

  async function seedArms(): Promise<{
    suite: SeededSuite;
    base: SeededConfiguration;
    cand: SeededConfiguration;
  }> {
    await seedWorker(c.t.db);
    const suite = await seedSuite(c.t.db, { tasks: [{ key: 'alpha' }, { key: 'bravo' }] });
    const base = await seedConfiguration(c.t.db, 'baseline');
    const cand = await seedConfiguration(c.t.db, 'with-skill');
    return { suite, base, cand };
  }

  describe('atomicity', () => {
    it('commits the experiment, its runs and their jobs at once: an observer never sees one without the others', async () => {
      await seedWorker(c.t.db);
      const keys = Array.from({ length: 20 }, (_, i) => ({
        key: `task-${String(i).padStart(2, '0')}`,
      }));
      const suite = await seedSuite(c.t.db, { tasks: keys });
      const base = await seedConfiguration(c.t.db, 'baseline');
      const cand = await seedConfiguration(c.t.db, 'with-skill');

      // One statement is one snapshot: it sees the launch's commit entirely or not at all.
      const seen = new Set<string>();
      let observing = true;
      const observer = (async () => {
        while (observing) {
          const { rows } = await e2e.pool.query<{ e: number; r: number; j: number }>(
            `select (select count(*) from experiments)::int as e, (select count(*) from runs)::int as r,
                    (select count(*) from pgboss.job where name = 'execute-run')::int as j`,
          );
          seen.add(JSON.stringify(rows[0]));
        }
      })();
      // 20 tasks × 2 configurations × 5 repetitions.
      const res = await c.post('/experiments', launchBody(suite, base, cand, 5)).expect(201);
      const { id } = LaunchExperimentResultSchema.parse(res.body);
      await new Promise((resolve) => setTimeout(resolve, 50));
      observing = false;
      await observer;

      const after = JSON.stringify({ e: 1, r: 200, j: 200 });
      expect(
        [...seen].every((s) => s === JSON.stringify({ e: 0, r: 0, j: 0 }) || s === after),
      ).toBe(true);
      expect(seen.has(after)).toBe(true);
      const jobs = await c.jobs();
      expect(new Set(jobs.map((j) => j.singletonKey)).size).toBe(200);
      expect(jobs.every((j) => j.data.attempt === 1 && j.data.trigger === 'initial')).toBe(true);
      expect((await experimentRow(c.t.db, id)).status).toBe('running');
    });

    it('leaves nothing behind when a job cannot be stored: no experiment, run, job or freeze', async () => {
      const { suite, base, cand } = await seedArms();
      // The queue refuses execute-run jobs, after the experiment and its runs were inserted.
      await e2e.pool.query(`
        create function public.refuse_execute_run() returns trigger language plpgsql as $$
        begin raise exception 'injected: execute-run jobs are refused'; end $$`);
      await e2e.pool.query(`
        create trigger refuse_execute_run before insert on pgboss.job for each row
        when (new.name = 'execute-run') execute function public.refuse_execute_run()`);

      const res = await c.post('/experiments', launchBody(suite, base, cand)).expect(500);
      expect(ApiErrorBodySchema.parse(res.body).statusCode).toBe(500);
      await expectNothingLaunched();

      await e2e.pool.query('drop trigger refuse_execute_run on pgboss.job');
      await c.post('/experiments', launchBody(suite, base, cand)).expect(201);
      expect(await c.jobs()).toHaveLength(4);
    });
  });

  describe('racing a configuration edit', () => {
    it('waits for an in-place edit in flight, then refuses the configuration it changed', async () => {
      const { suite, base, cand } = await seedArms();
      // PUT /configurations/:id of an unfrozen version: the configuration row, the version, then the write.
      const edit = await holdLocks(e2e.pool, [
        ['select 1 from configurations where id = $1 for update', [cand.configurationId]],
        ['select 1 from configuration_versions where id = $1 for update', [cand.versionId]],
        [
          'update configuration_versions set max_turns = 30, config_hash = $2 where id = $1',
          [cand.versionId, sha('with-skill, edited')],
        ],
      ]);
      const launch = started(c.post('/experiments', launchBody(suite, base, cand)));
      try {
        // The launch's freeze waits for the edit's row lock.
        await waitForLockWaits(e2e.pool, 1);
      } finally {
        await edit.commit();
      }
      const res = await launch;
      expect(res.status).toBe(409);
      expect(refusal(res)).toBe('configuration with-skill changed since you opened this form');
      await expectNothingLaunched();
      const [edited] = await c.t.db
        .select()
        .from(configurationVersions)
        .where(eq(configurationVersions.id, cand.versionId));
      expect(edited).toMatchObject({
        maxTurns: 30,
        configHash: sha('with-skill, edited'),
        frozenAt: null,
      });
    });

    it('waits for an edit that makes a newer version, then refuses the version it would have tested', async () => {
      const { suite, base, cand } = await seedArms();
      await c.t.db
        .update(configurationVersions)
        .set({ frozenAt: new Date() })
        .where(eq(configurationVersions.id, cand.versionId));
      // PUT /configurations/:id of a frozen version: v2 beside it, then latest_version.
      const edit = await holdLocks(e2e.pool, [
        ['select 1 from configurations where id = $1 for update', [cand.configurationId]],
        ['select 1 from configuration_versions where id = $1 for update', [cand.versionId]],
        [
          `insert into configuration_versions
             (id, configuration_id, version, model, provider, base_url, toolsets, max_turns, time_budget_s, config_hash)
           select $3, configuration_id, 2, model, provider, base_url, toolsets, 30, time_budget_s, $2
             from configuration_versions where id = $1`,
          [cand.versionId, sha('with-skill v2'), newId()],
        ],
        ['update configurations set latest_version = 2 where id = $1', [cand.configurationId]],
      ]);
      const launch = started(c.post('/experiments', launchBody(suite, base, cand)));
      try {
        // v1 is already frozen, so the freeze skips it; the FOR SHARE read waits instead.
        await waitForLockWaits(e2e.pool, 1);
      } finally {
        await edit.commit();
      }
      const res = await launch;
      expect(res.status).toBe(409);
      expect(refusal(res)).toBe(
        'configuration with-skill changed since you opened this form (now v2)',
      );
      expect(await c.t.db.select({ id: experiments.id }).from(experiments)).toEqual([]);
      const [baseline] = await c.t.db
        .select({ frozenAt: configurationVersions.frozenAt })
        .from(configurationVersions)
        .where(eq(configurationVersions.id, base.versionId));
      expect(baseline!.frozenAt).toBeNull();
    });

    it('makes an edit that arrives during a launch wait for the freeze, and save the next version', async () => {
      await seedWorker(c.t.db);
      const suite = await seedSuite(c.t.db, { tasks: [{ key: 'alpha' }] });
      const writes = new ConfigurationWritesService(c.t.db);
      const arm = async (
        name: string,
        maxTurns: number,
      ): Promise<Arm & { configurationId: string }> => {
        const saved = await writes.create(
          configurationInput({
            name,
            provider: 'custom',
            baseUrl: MOCK_BASE_URL,
            model: MOCK_MODEL,
            maxTurns,
          }),
        );
        const [row] = await c.t.db
          .select({ configHash: configurationVersions.configHash })
          .from(configurationVersions)
          .where(eq(configurationVersions.id, saved.versionId));
        return {
          configurationId: saved.configurationId,
          versionId: saved.versionId,
          configHash: row!.configHash,
        };
      };
      const base = await arm('baseline', 20);
      const cand = await arm('with-skill', 25);

      // Stall the launch after its freeze and hash check: the experiment insert needs the suite row.
      const stall = await holdLocks(e2e.pool, [
        ['select 1 from suites where id = $1 for update', [suite.id]],
      ]);
      const launch = started(c.post('/experiments', launchBody(suite, base, cand)));
      let edit: ReturnType<ConfigurationWritesService['update']>;
      try {
        await waitForLockWaits(e2e.pool, 1);
        edit = writes.update(
          cand.configurationId,
          configurationInput({
            name: 'with-skill',
            provider: 'custom',
            baseUrl: MOCK_BASE_URL,
            model: MOCK_MODEL,
            maxTurns: 40,
          }),
        );
        // The edit's FOR UPDATE on the version waits for the launch's freeze.
        await waitForLockWaits(e2e.pool, 2);
      } finally {
        await stall.commit();
      }
      const res = await launch;
      expect(res.status).toBe(201);
      expect(await edit!).toMatchObject({ version: 2, createdNewVersion: true });

      const e = await experimentRow(c.t.db, LaunchExperimentResultSchema.parse(res.body).id);
      expect(e.candidateVersionIds).toEqual([cand.versionId]);
      const versions = await c.t.db
        .select()
        .from(configurationVersions)
        .where(eq(configurationVersions.configurationId, cand.configurationId))
        .orderBy(configurationVersions.version);
      expect(
        versions.map((v) => [
          v.version,
          v.maxTurns,
          v.configHash === cand.configHash,
          v.frozenAt !== null,
        ]),
      ).toEqual([
        [1, 25, true, true],
        [2, 40, false, false],
      ]);
      const [configuration] = await c.t.db
        .select({ latestVersion: configurations.latestVersion })
        .from(configurations)
        .where(eq(configurations.id, cand.configurationId));
      expect(configuration!.latestVersion).toBe(2);
    });
  });
});
