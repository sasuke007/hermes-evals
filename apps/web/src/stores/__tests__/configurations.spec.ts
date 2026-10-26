import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { CONFIG_IDS, CONFIG_VERSION_IDS } from '@/fixtures/configurations';
import { detailKey, useConfigurationsStore } from '@/stores/configurations';
import { useScenario } from './scenarioEnv';

beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});

describe('configurations store', () => {
  it('keeps the list rows by id, in the API order', async () => {
    const store = useConfigurationsStore();
    await store.loadList();
    expect(store.listState).toEqual({ loading: false, loaded: true, error: null });
    expect(store.list.map((r) => r.name)).toEqual(['baseline', 'with-skill', 'with-mcp']);
    expect(store.rows[CONFIG_IDS['with-skill']]?.usedInExperiments).toBe(3);
    expect(store.nameOf(CONFIG_IDS['with-mcp'])).toBe('with-mcp');
  });

  it('keeps a failed load verbatim and the last good list', async () => {
    const store = useConfigurationsStore();
    await store.loadList();
    useScenario('error');
    await store.loadList();
    expect(store.listState.error).toBe(
      'GET /api/configurations → 502 · upstream api:8080 connection refused',
    );
    expect(store.list).toHaveLength(3);
  });

  it('keys a detail by id, and an older version by id@v<n>', async () => {
    const store = useConfigurationsStore();
    await store.loadDetail(CONFIG_IDS.baseline);
    await store.loadDetail(CONFIG_IDS.baseline, 1);
    expect(Object.keys(store.details)).toEqual([
      CONFIG_IDS.baseline,
      detailKey(CONFIG_IDS.baseline, 1),
    ]);
    expect(store.detail(CONFIG_IDS.baseline, 1)?.shown.version).toBe(1);
    await store.loadDetail(CONFIG_IDS.baseline, 7);
    expect(store.detailState(CONFIG_IDS.baseline, 7).error).toContain('→ 404');
  });

  it('saves, drops what the save made stale, and hands the notice over once', async () => {
    const store = useConfigurationsStore();
    await store.loadList();
    await store.loadDetail(CONFIG_IDS['with-skill']);
    const draft = await store.fetchDraft('edit', CONFIG_IDS['with-skill']);
    const result = await store.save({ ...draft.values, maxTurns: 30 }, CONFIG_IDS['with-skill']);
    expect(result).toMatchObject({ version: 2, createdNewVersion: true });
    expect(store.detail(CONFIG_IDS['with-skill'])).toBeNull();
    expect(store.listState.loaded).toBe(false);
    expect(store.takeSaved(CONFIG_IDS.baseline)).toBeNull();
    expect(store.takeSaved(CONFIG_IDS['with-skill'])).toEqual(result);
    expect(store.takeSaved(CONFIG_IDS['with-skill'])).toBeNull();
  });

  it('remembers a diff per selection', async () => {
    const store = useConfigurationsStore();
    const ids = [CONFIG_VERSION_IDS.baseline, CONFIG_VERSION_IDS['with-mcp']];
    const first = await store.diff(ids);
    expect(await store.diff(ids)).toBe(first);
    expect(first.differing).toEqual(['mcp_servers']);
  });
});
