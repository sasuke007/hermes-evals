/**
 * What memory on and on-demand skills add to the toolsets at launch (Phase 6b #12; the
 * worker's plannedToolsets): the form's corrected Toolsets help and its live line, the
 * detail's Toolsets and Memory rows, and the diff table's toolsets cells.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ConfigDiff } from '@/api/types/configurations';
import ConfigDiffTable from '@/components/configurations/ConfigDiffTable.vue';
import ConfigurationDetailPage from '@/views/configurations/ConfigurationDetailPage.vue';
import ConfigurationFormPage from '@/views/configurations/ConfigurationFormPage.vue';
import { CONFIG_IDS } from '@/fixtures/configurations';
import { useProvidersStore } from '@/stores/providers';
import { mountPage, unmountAll } from './mountPage';

afterEach(() => {
  unmountAll();
  useProvidersStore().dispose();
  vi.unstubAllGlobals();
});

const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
const launch = (w: VueWrapper) => w.find('[data-testid="launch-toolsets"]');

describe('the configuration form', () => {
  it('says what memory on and on-demand skills add, under a corrected Toolsets help', async () => {
    const { w } = await mountPage(
      ConfigurationFormPage,
      `/configurations/${CONFIG_IDS['with-skill']}/edit`,
    );
    expect(norm(w.get('[data-testid="toolsets-help"]').text())).toBe(
      'Loaded from the runtime. skills and memory are toolsets too. Memory on adds memory at launch, and skills loaded on demand add skills, ticked here or not. With memory off, Hermes hides the memory tool even when memory is ticked.',
    );
    expect(launch(w).exists()).toBe(false);
    await w
      .get('[data-testid="skill-loading"]')
      .findAll('button')
      .find((b) => b.text() === 'on demand')!
      .trigger('click');
    expect(norm(launch(w).text())).toBe('+ skills at launch: skills load on demand');
    await w.get('[role="switch"]').trigger('click');
    await flushPromises();
    expect(norm(launch(w).text())).toBe(
      '+ memory and skills at launch: memory is on and skills load on demand',
    );
  });
});

describe('the configuration detail', () => {
  it('names the toolsets launch adds beside the stored ones, and on Memory', async () => {
    const { w } = await mountPage(
      ConfigurationDetailPage,
      `/configurations/${CONFIG_IDS['with-skill']}`,
      'skills-on-demand',
    );
    const toolsets = w.get('dl [data-key="toolsets"]');
    expect(norm(toolsets.get('[data-testid="launch-toolsets"]').text())).toBe(
      '+ skills at launch: skills load on demand',
    );
    expect(w.get('dl [data-key="memory"]').text()).toContain('(runtime default is on)');
  });
});

describe('ConfigDiffTable', () => {
  const diff: ConfigDiff = {
    columns: [
      { configurationId: 'c1', versionId: 'v1', name: 'baseline', version: 1 },
      { configurationId: 'c2', versionId: 'v2', name: 'with-memory', version: 1 },
    ],
    rows: [
      { field: 'name', values: ['baseline', 'with-memory'], differs: false },
      { field: 'toolsets', values: ['file, terminal', 'file, terminal'], differs: false },
      { field: 'memory', values: ['off', 'on'], differs: true },
      { field: 'skill_loading', values: ['preload', 'preload'], differs: false },
    ],
    differing: ['memory'],
  } as ConfigDiff;

  it('adds "+ memory at launch" under a memory-on column, the row still equal', () => {
    const w = mount(ConfigDiffTable, { props: { diff } });
    const row = w.get('[data-field="toolsets"]');
    expect(row.attributes('data-differs')).toBe('false');
    const cells = row.findAll('td').slice(1);
    expect(cells[0]!.find('[data-testid="launch-toolsets"]').exists()).toBe(false);
    expect(cells[1]!.get('[data-testid="launch-toolsets"]').text()).toBe('+ memory at launch');
    expect(w.get('[data-testid="diff-line"]').text()).toBe('1 field differs: memory');
  });
});
