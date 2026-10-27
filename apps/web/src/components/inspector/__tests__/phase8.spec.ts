/**
 * The inspector's Phase 8 states: an unfenced answer (G5, `unfenced-answer`: the reply was one
 * JSON object without a ```json fence, which the scorer took as the answer), and what the
 * launch record says memory off left out of the home (G9), from the fixtures and with
 * explicit records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { RunDetailSchema, UNFENCED_ANSWER_NOTE } from '@hermes-evals/shared';
import type { LaunchRecordView } from '@/api/types/runs';
import { UNFENCED_RUN } from '@/fixtures/inspector-answers';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import LaunchRecordSection from '../LaunchRecordSection.vue';
import { detailOf, mountDrawer, runOf, spaced, squash } from './inspectorEnv';

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

describe('an unfenced answer (unfenced-answer · dup_invoices · with-skill · rep 1)', () => {
  const id = () =>
    runOf(
      UNFENCED_RUN.experiment,
      UNFENCED_RUN.task,
      UNFENCED_RUN.config,
      UNFENCED_RUN.repetition,
      'unfenced-answer',
    );

  it('is a found answer whose range is the trimmed reply, with no fence', () => {
    const detail = RunDetailSchema.parse(detailOf(id(), 'unfenced-answer'));
    const final = detail.finalResponse!;
    expect(final.unfenced).toBe(true);
    expect(final.extraction).toBe('found');
    expect(final.fence).toBe(null);
    expect(final.text.slice(final.extracted!.start, final.extracted!.end)).toBe(final.text.trim());
    expect(JSON.parse(final.text)).toEqual(final.parsed);
    expect(detail.primary.status).toBe('passed');
  });

  it('says so above the reply and highlights the whole of it as extracted', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id(), { scenario: 'unfenced-answer' }));
    const section = wrapper.get('[data-testid="section-final"]');
    const banner = section.get('[data-testid="extraction-banner"]');
    expect(banner.attributes('data-kind')).toBe('unfenced');
    expect(banner.attributes('role')).toBe('status');
    expect(squash(banner.text())).toBe(UNFENCED_ANSWER_NOTE);
    expect(banner.find('code').text()).toBe('```json');
    const final = detailOf(id(), 'unfenced-answer').finalResponse!;
    expect(section.get('[data-testid="json-highlight"]').text()).toBe(
      `extracted${final.text.trim()}`,
    );
    expect(spaced(section.get('[data-testid="parsed-answer"]'))).toMatch(
      /^Parsed answer · the whole reply duplicates :/,
    );
  });

  it('leaves the run fenced without the scenario, and every other run as it was', async () => {
    expect(detailOf(id()).finalResponse!.unfenced).toBe(false);
    const other = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 2, 'unfenced-answer');
    expect(detailOf(other, 'unfenced-answer').finalResponse!.unfenced).toBe(false);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    expect(wrapper.find('[data-kind="unfenced"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="json-highlight"]').exists()).toBe(true);
  });
});

describe('memory in the home, in the launch record (G9)', () => {
  const recordOf = (homeMemory: LaunchRecordView['homeMemory']): LaunchRecordView => {
    const id = runOf('skillVsNoSkill', 'per_vendor', 'with-skill', 1, 'memory-files');
    const record = detailOf(id, 'memory-files').launchRecord!;
    const seeds = homeMemory && !homeMemory.memoryEnabled ? [] : record.homeSeeds;
    return { ...record, homeSeeds: seeds, homeMemory };
  };

  async function homeRow(record: LaunchRecordView): Promise<VueWrapper> {
    wrapper = mount(LaunchRecordSection, { props: { record, sectionId: 'ri-launch' } });
    await wrapper.get('h2 button').trigger('click');
    return wrapper;
  }

  it('memory off: lists the seeds left out, and says home/memories was not collected', async () => {
    const w = await homeRow(
      recordOf({
        memoryEnabled: false,
        seedsSkipped: ['memories/MEMORY.md', 'memories/USER.md'],
        memoriesCollected: false,
      }),
    );
    const row = w.get('[data-testid="launch-home-seeds"]');
    expect(row.findAll('[data-seed]')).toHaveLength(0);
    expect(row.findAll('[data-seed-skipped]').map((s) => s.text())).toEqual([
      'memories/MEMORY.md · left out',
      'memories/USER.md · left out',
    ]);
    expect(spaced(row.get('[data-testid="launch-home-memory"]'))).toBe(
      'Memory is off: these seeds were left out of the home, and home/memories was not collected, so nothing there counts as memory.',
    );
  });

  it('memory on: the seeds as copied, and home/memories collected', async () => {
    const w = await homeRow(
      recordOf({ memoryEnabled: true, seedsSkipped: [], memoriesCollected: true }),
    );
    const row = w.get('[data-testid="launch-home-seeds"]');
    expect(row.findAll('[data-seed]')).toHaveLength(2);
    expect(spaced(row.get('[data-testid="launch-home-memory"]'))).toBe(
      'Memory is on: copied from the task before launch, and home/memories collected after the run.',
    );
  });

  it('memory off with no seeds: the home started empty, and was not collected', async () => {
    const w = await homeRow({
      ...recordOf({ memoryEnabled: false, seedsSkipped: [], memoriesCollected: false }),
      homeSeeds: [],
    });
    const row = w.get('[data-testid="launch-home-seeds"]');
    expect(spaced(row)).toBe(
      "None: the home's memories/ started empty Memory is off: home/memories was not collected.",
    );
  });

  it('a record from before Phase 8 keeps its note: seeded in every configuration', async () => {
    const w = await homeRow(recordOf(null));
    expect(spaced(w.get('[data-testid="launch-home-memory"]'))).toBe(
      'Copied from the task before launch, in every configuration. Hermes reads them only with memory on.',
    );
  });
});
