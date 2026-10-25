/**
 * GET /runs/:id/events and the artifact reads on PGlite with the real
 * triggers, over the runs of run-states-spec.ts. Pages parse with the
 * shared RunEventsPage schema.
 */
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunEventsPageSchema, TablePreviewSchema, type RunEventsPage } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { attemptById, configVersions, eventsOf, runById } from './run-views.queries.js';
import { timelineContext } from './run-detail.js';
import { RunViewsService } from './run-views.service.js';
import { seedAllStates, type AllStates } from './run-states-spec.js';
import { SUMMARY_CSV, viewsConfig, type RunCell } from './run-fixtures-spec.js';
import { buildTimeline } from './timeline.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let seed: AllStates;
let views: RunViewsService;

beforeAll(async () => {
  t = await createTestDatabase();
  seed = await seedAllStates(t.db);
  views = new RunViewsService(t.db, seed.store, viewsConfig());
});

afterAll(async () => {
  await t.close();
  await seed.dispose();
});

const page = async (cell: RunCell, after: number): Promise<RunEventsPage> =>
  RunEventsPageSchema.parse(await views.events(seed.cell(cell), after));

describe('GET /runs/:id/events', () => {
  it('pages the timeline after a seq, sending again the rows later events changed', async () => {
    const all = await page('dup_invoices/baseline/1', 0);
    expect(all).toMatchObject({ lastSeq: 11, live: false });
    expect(all.events).toHaveLength(8);
    const later = await page('dup_invoices/baseline/1', 7);
    expect(later.events.map((e) => [e.seq, e.title])).toEqual([
      [9, 'Refused by sandbox'],
      [8, 'Model call'],
      [4, 'terminal'],
      [11, 'collected'],
    ]);
    expect(await page('dup_invoices/baseline/1', 11)).toEqual({
      events: [],
      lastSeq: 11,
      live: false,
    });
  });

  it('sends, for every cursor, exactly the rows a rebuild of the whole attempt would', async () => {
    const runId = seed.cell('dup_invoices/baseline/1');
    const run = (await runById(t.db, runId))!;
    const shown = (await attemptById(t.db, run.currentAttemptId!))!;
    const [config] = await configVersions(t.db, [run.configurationVersionId]);
    const events = await eventsOf(t.db, shown.id);
    const rows = buildTimeline(events, timelineContext(shown, config!));
    const last = events.at(-1)!.seq;
    for (let after = 0; after <= last; after += 1) {
      const expected = rows.filter((r) => r.maxSeq > after).map((r) => r.event);
      expect((await page('dup_invoices/baseline/1', after)).events, `after ${after}`).toEqual(
        expected,
      );
    }
  });

  it('cuts a page at its event limit and continues from its last event', async () => {
    const runId = seed.cell('dup_invoices/baseline/1');
    const first = RunEventsPageSchema.parse(await views.events(runId, 0, 3));
    expect(first.lastSeq).toBe(3);
    const pages = [first];
    while (pages.at(-1)!.lastSeq < 11) {
      pages.push(RunEventsPageSchema.parse(await views.events(runId, pages.at(-1)!.lastSeq, 3)));
    }
    expect(pages.map((p) => p.lastSeq)).toEqual([3, 6, 9, 11]);
    // Every row of the full timeline arrives, the latest version of each by seq.
    const latest = new Map(pages.flatMap((p) => p.events).map((e) => [e.seq, e]));
    const full = await page('dup_invoices/baseline/1', 0);
    expect([...latest.keys()].sort((a, b) => a - b)).toEqual(
      full.events.map((e) => e.seq).sort((a, b) => a - b),
    );
    for (const e of full.events) expect(latest.get(e.seq)).toEqual(e);
  });

  it('marks a running run live and keeps the cursor when nothing is new', async () => {
    const live = await page('dup_invoices/with-skill/5', 0);
    expect(live).toMatchObject({ lastSeq: 2, live: true });
    expect(await page('dup_invoices/with-skill/5', 2)).toEqual({
      events: [],
      lastSeq: 2,
      live: true,
    });
  });

  it('answers an empty page for a run with no attempt, and 404 for an unknown run', async () => {
    expect(await page('total_due/baseline/3', 5)).toEqual({ events: [], lastSeq: 5, live: false });
    await expect(views.events('run_nope', 0)).rejects.toMatchObject({
      response: { statusCode: 404 },
    });
  });
});

describe('artifacts', () => {
  const run = () => seed.cell('dup_invoices/baseline/1');

  it('streams the stored bytes of an artifact of the run', async () => {
    const download = await views.artifactContent(run(), seed.artifactIds.summary);
    expect(download.artifact.path).toBe('summary.csv');
    expect(await text(download.stream)).toBe(SUMMARY_CSV);
  });

  it("refuses another run's artifact, an unknown one and one stored without content", async () => {
    await expect(views.artifactContent(run(), seed.artifactIds.partial)).rejects.toMatchObject({
      response: { statusCode: 404, message: `artifact ${seed.artifactIds.partial} not found` },
    });
    await expect(views.artifactContent('run_nope', seed.artifactIds.summary)).rejects.toMatchObject(
      {
        response: { statusCode: 404, message: 'run run_nope not found' },
      },
    );
    await expect(views.artifactContent(run(), seed.artifactIds.big)).rejects.toMatchObject({
      response: { statusCode: 404 },
    });
  });

  it('previews a CSV and answers null for any other file', async () => {
    expect(
      TablePreviewSchema.parse(await views.artifactPreview(run(), seed.artifactIds.summary)),
    ).toMatchObject({
      columns: ['vendor', 'outstanding'],
      totalRows: 2,
    });
    expect(await views.artifactPreview(run(), seed.artifactIds.report)).toBeNull();
    expect(await views.artifactPreview(run(), seed.artifactIds.big)).toBeNull();
  });
});
