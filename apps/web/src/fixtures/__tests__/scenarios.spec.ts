import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ROUTE_NAMES, routes } from '@/router';
import { SCENARIOS, scenarioEntry, scenarioUrl } from '@/fixtures/scenarios';
import { SYSTEM_SCENARIOS } from '@/fixtures/system';

/** Every scenario name the experiments, runs, suites, configurations and resources fixtures read. */
const READ_BY_THIS_DATA_LAYER = [
  'loading',
  'error',
  'empty',
  'first-launch',
  'paused-ceiling',
  'paused-provider',
  'no-worker',
  'nothing-scored',
  'single-rep',
  'verdict-updated',
  'cancelled',
  'multi-attempt',
  'disk-limit',
  'token-cap',
  'timeout-silent',
  'provider-lapsed',
  'launch-refused',
  'launch-conflict',
  'no-history',
  'bulk-refused',
  'invalid-task',
  'reverted',
  'newer-version',
  'reload-failed',
  'upload-invalid',
  'upload-new-version',
  'upload-same-version-different-hash',
  'mcp-test-failed',
  'secret-not-set',
  'nous-unavailable',
  'openrouter-in-use',
  'stream-offline',
];

describe('scenario registry', () => {
  it('lists each name once', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists every scenario the data layer reads and every system scenario', () => {
    const missing = [...READ_BY_THIS_DATA_LAYER, ...SYSTEM_SCENARIOS].filter(
      (name) => !scenarioEntry(name),
    );
    expect(missing).toEqual([]);
  });

  it('points every scenario at a real route', () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    const broken: string[] = [];
    for (const entry of SCENARIOS) {
      for (const path of [entry.route, ...(entry.alsoAt ?? [])]) {
        const resolved = router.resolve(path);
        if (resolved.name === ROUTE_NAMES.notFound || path.endsWith('/runs/')) {
          broken.push(`${entry.name} → ${path}`);
        }
      }
      if (entry.description.length < 20) broken.push(`${entry.name}: description`);
    }
    expect(broken).toEqual([]);
  });

  it('builds the URL to open a scenario', () => {
    expect(scenarioUrl(scenarioEntry('paused-ceiling')!)).toBe(
      '/experiments/exp_01JBFMCPVB?scenario=paused-ceiling',
    );
  });
});
