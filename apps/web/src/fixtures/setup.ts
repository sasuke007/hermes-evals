/**
 * Fixtures for the platform's setup (Phase 8 G2, G3): the LLM judge, and the samples seed of
 * this API start, as GET /system/setup serves them. New experiment's options take their judge
 * from here too, so System and the form always agree.
 *
 * Scenarios (see phase8-scenarios.ts):
 *   judge-mock        the judge is the scripted mock model (Compose's default since Phase 8)
 *   judge-mock-name   a custom judge elsewhere, with Compose's default model mock/scripted left
 *   samples-seeded    a fresh clone after its first start: the mock judge too
 *   seed-running      the seed is still going: 2 items so far
 *   seed-item-failed  the seed finished, and one configuration was refused
 *   seed-failed       the seed stopped: the samples folder is not there
 *   seed-off          SEED_SAMPLES is false
 * Without one, the judge is Nous with JUDGE_MODEL set (as the run fixtures assume) and the
 * seed finished with 3 items created and 2 skipped.
 */
import {
  MOCK_MODEL_NAME,
  sampleConfigurationName,
  type JudgeView,
  type SeedItem,
  type SeedReport,
  type SystemSetup,
} from '@hermes-evals/shared';
import { hasScenario } from '@/api/source';

type Active = (name: string) => boolean;

/** The fixture world's API started at 09:00:00 on its last day; the seed took 3 s. */
const SEED_STARTED_AT = '2026-10-27T09:00:00';
const SEED_FINISHED_AT = '2026-10-27T09:00:03';

/** What the samples seed made on the fixture world's first start: one of each kind. */
const SEED_ITEMS: SeedItem[] = [
  { kind: 'skill', name: 'invoice-method', outcome: 'created', detail: 'version 1.0.0' },
  {
    kind: 'skill',
    name: 'house-style',
    outcome: 'skipped',
    detail: 'exists with the same content',
  },
  { kind: 'document', name: 'knowledge-v1/house-style.md', outcome: 'created', detail: null },
  { kind: 'mcp_server', name: 'invoice-db', outcome: 'created', detail: null },
  {
    kind: 'configuration',
    name: sampleConfigurationName('invoices-v1', 'baseline', 'mock'),
    outcome: 'skipped',
    detail: 'a configuration with this name exists',
  },
];

/** seed-item-failed: the service refused one configuration; the rest still ran. */
export const SEED_FAILED_ITEM: SeedItem = {
  kind: 'configuration',
  name: sampleConfigurationName('mcp-v1', 'with-mcp', 'mock'),
  outcome: 'failed',
  detail: 'MCP server vendor-directory does not exist',
};

/** seed-failed: what stopped the seed before it made anything. */
export const SEED_FAILED_ERROR =
  'Could not read the samples folder /app/samples: no such file or directory';

/** The judge GET /system/setup and New experiment's options report. */
export function judgeFixture(active: Active = hasScenario): JudgeView {
  if (active('judge-mock') || active('samples-seeded')) {
    return { provider: 'custom', model: MOCK_MODEL_NAME, mock: true, mockModelName: false };
  }
  if (active('judge-mock-name')) {
    return { provider: 'custom', model: MOCK_MODEL_NAME, mock: false, mockModelName: true };
  }
  return { provider: 'nous', model: 'openai/gpt-6.1-sol', mock: false, mockModelName: false };
}

/** This API start's seed, as the scenario has it. */
export function seedReportFixture(active: Active = hasScenario): SeedReport {
  const items = () => SEED_ITEMS.map((item) => ({ ...item }));
  if (active('seed-off')) {
    return { state: 'off', startedAt: null, finishedAt: null, items: [], error: null };
  }
  if (active('seed-running')) {
    return {
      state: 'running',
      startedAt: SEED_STARTED_AT,
      finishedAt: null,
      items: items().slice(0, 2),
      error: null,
    };
  }
  if (active('seed-failed')) {
    return {
      state: 'failed',
      startedAt: SEED_STARTED_AT,
      finishedAt: SEED_FINISHED_AT,
      items: [],
      error: SEED_FAILED_ERROR,
    };
  }
  return {
    state: 'done',
    startedAt: SEED_STARTED_AT,
    finishedAt: SEED_FINISHED_AT,
    items: active('seed-item-failed') ? [...items(), { ...SEED_FAILED_ITEM }] : items(),
    error: null,
  };
}

/** GET /system/setup: the judge and the samples seed of this API start. */
export function systemSetupFixture(active: Active = hasScenario): SystemSetup {
  return { judge: judgeFixture(active), seed: seedReportFixture(active) };
}
