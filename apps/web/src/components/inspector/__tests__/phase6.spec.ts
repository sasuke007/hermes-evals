/**
 * The inspector's Phase 6 states: the Memory group of a run's home files (P2) under
 * `memory-files`, the launch record's home seeds (P1), skill loading (P5, `skills-on-demand`)
 * and background review intervals (P3), from the fixtures and with explicit props.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ArtifactView, LaunchRecordView, RunDetail } from '@/api/types/runs';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import ArtifactsSection from '../ArtifactsSection.vue';
import LaunchRecordSection from '../LaunchRecordSection.vue';
import { detailOf, mountDrawer, runOf, spaced } from './inspectorEnv';

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

/** The path, origin and size cells of each artifact row under `scope`. */
const rowsOf = (w: VueWrapper, scope: string) =>
  w
    .get(scope)
    .findAll('[data-testid="artifact-row"]')
    .map((r) =>
      r
        .findAll('td')
        .slice(0, 3)
        .map((td) => td.text()),
    );

async function openLaunchRecord(w: VueWrapper): Promise<string> {
  await w.get('[data-testid="section-launch"] h2 button').trigger('click');
  return spaced(w.get('[data-testid="launch-record"]'));
}

describe('memory files (memory-files · per_vendor)', () => {
  it('lists the home files in a Memory group, labelled against the seeds', async () => {
    const id = runOf('skillVsNoSkill', 'per_vendor', 'with-skill', 1, 'memory-files');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'memory-files' }));
    const group = wrapper.get('[data-testid="memory-group"]');
    expect(spaced(group.get('h3'))).toBe(
      "Memory · the agent's memory files, collected from memories/ in its home after the run",
    );
    const rows = group.findAll('[data-testid="artifact-row"]');
    expect(rows.map((r) => r.attributes('data-root'))).toEqual(['home', 'home']);
    expect(rows.map((r) => r.findAll('td').map((td) => td.text())[0])).toEqual([
      'home/memories/MEMORY.md',
      'home/memories/USER.md',
    ]);
    expect(rows.map((r) => r.findAll('td')[1]!.text())).toEqual([
      'home seed · unchanged',
      'home seed · modified',
    ]);
    // The workspace keeps its own table; the fixture stays there.
    const workspace = wrapper.get('table[aria-label="Artifacts"]');
    expect(workspace.text()).toContain('workspace/invoices.csv');
    expect(workspace.text()).not.toContain('memories');
    // The modified seed opens its preview: the text as the agent left it.
    await flushPromises();
    const preview = wrapper.get('[data-testid="artifact-preview"]');
    expect(preview.text()).toContain('Wants vendor totals sorted by amount, largest first.');
  });

  it('keeps USER.md unchanged where the answer failed', async () => {
    const id = runOf('mcpVsBaseline', 'per_vendor', 'baseline', 4, 'memory-files');
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id, { scenario: 'memory-files' }));
    const origins = wrapper
      .get('[data-testid="memory-group"]')
      .findAll('[data-testid="artifact-row"]')
      .map((r) => r.attributes('data-origin'));
    expect(origins).toEqual(['home_seed_unchanged', 'home_seed_unchanged']);
  });

  it('lists both seeds in the launch record, with where they land and their hashes', async () => {
    const id = runOf('skillVsNoSkill', 'per_vendor', 'baseline', 2, 'memory-files');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'memory-files' }));
    await openLaunchRecord(wrapper);
    const seeds = wrapper.get('[data-testid="launch-home-seeds"]');
    expect(seeds.findAll('[data-seed]').map((s) => spaced(s))).toEqual([
      expect.stringMatching(
        /^memories\/MEMORY\.md → \/opt\/data\/memories\/MEMORY\.md · sha256:5e1b[0-9a-f]{4}…[0-9a-f]{4}$/,
      ),
      expect.stringMatching(/^memories\/USER\.md → \/opt\/data\/memories\/USER\.md · sha256:a08c/),
    ]);
    expect(seeds.text()).toContain('Copied from the task before launch, in every configuration.');
  });

  it('has no Memory group and an empty home without the scenario', async () => {
    const id = runOf('skillVsNoSkill', 'per_vendor', 'with-skill', 1);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id));
    expect(wrapper.find('[data-testid="memory-group"]').exists()).toBe(false);
    await openLaunchRecord(wrapper);
    expect(spaced(wrapper.get('[data-testid="launch-home-seeds"]'))).toBe(
      "None: the home's memories/ started empty",
    );
  });
});

describe('ArtifactsSection with home files only', () => {
  const memory: ArtifactView = {
    id: 'art_mem',
    root: 'home',
    path: 'home/memories/MEMORY.md',
    origin: 'agent',
    sizeBytes: 64,
    sha256: 'b1'.padEnd(64, '0'),
    skippedReason: null,
    preview: null,
  };

  it('labels a memory file the agent wrote, and says the workspace holds nothing', () => {
    const d: RunDetail = detailOf(SAMPLE_RUN_ID);
    d.artifacts = { items: [memory], note: null, agentWroteNothing: true };
    wrapper = mount(ArtifactsSection, { props: { detail: d, sectionId: 'ri-artifacts' } });
    expect(wrapper.find('table[aria-label="Artifacts"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="artifacts-note"]').text()).toBe(
      'The agent wrote no files in its workspace during this run, and this task has no fixture files.',
    );
    expect(rowsOf(wrapper, '[data-testid="memory-group"]')).toEqual([
      ['home/memories/MEMORY.md', 'written by agent', '64 B'],
    ]);
  });
});

describe('ArtifactsSection with memory on and nothing saved (Phase 6 #11)', () => {
  const memoryOn = (d: RunDetail): RunDetail => ({
    ...d,
    launchRecord: d.launchRecord && {
      ...d.launchRecord,
      configYaml: d.launchRecord.configYaml.replace(
        'memory_enabled: false',
        'memory_enabled: true',
      ),
    },
  });

  it('keeps the Memory group to say the agent saved nothing', () => {
    const d = memoryOn(detailOf(SAMPLE_RUN_ID));
    expect(d.artifacts.items.some((a) => a.root === 'home')).toBe(false);
    wrapper = mount(ArtifactsSection, { props: { detail: d, sectionId: 'ri-artifacts' } });
    const group = wrapper.get('[data-testid="memory-group"]');
    expect(group.find('table').exists()).toBe(false);
    expect(group.get('[data-testid="memory-note"]').text()).toBe(
      'Memory is on; the agent saved nothing.',
    );
  });

  it('has no Memory group with memory off, nor while the run is unfinished', () => {
    const off = detailOf(SAMPLE_RUN_ID);
    wrapper = mount(ArtifactsSection, { props: { detail: off, sectionId: 'ri-artifacts' } });
    expect(wrapper.find('[data-testid="memory-group"]').exists()).toBe(false);
    wrapper.unmount();
    const running = { ...memoryOn(detailOf(SAMPLE_RUN_ID)), status: 'running' as const };
    wrapper = mount(ArtifactsSection, { props: { detail: running, sectionId: 'ri-artifacts' } });
    expect(wrapper.find('[data-testid="memory-group"]').exists()).toBe(false);
  });
});

describe('skill loading in the launch record', () => {
  it('preload: -s per skill', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id));
    const record = await openLaunchRecord(wrapper);
    expect(spaced(wrapper.get('[data-testid="launch-skill-loading"]'))).toBe(
      'preload · each skill loaded into the prompt at start with -s',
    );
    expect(record).toContain('-t file,terminal -s invoice-method');
  });

  it('on demand (skills-on-demand): no -s, the skills toolset added', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 3, 'skills-on-demand');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'skills-on-demand' }));
    const record = await openLaunchRecord(wrapper);
    expect(spaced(wrapper.get('[data-testid="launch-skill-loading"]'))).toBe(
      'on demand · installed in the home without -s ; the agent lists and opens them through the skills toolset',
    );
    expect(record).toContain('-t file,terminal,skills');
    expect(record).not.toContain('-s invoice-method');
  });

  it('says nothing about loading on a run without skills', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'baseline', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id));
    await openLaunchRecord(wrapper);
    expect(wrapper.find('[data-testid="launch-skill-loading"]').exists()).toBe(false);
  });
});

describe('background review in the launch record', () => {
  const NOTE =
    ' Written the same in every run; a one-shot run is a finite turn, for which Hermes starts no review';
  async function review(backgroundReview: LaunchRecordView['backgroundReview']): Promise<string> {
    const record = detailOf(SAMPLE_RUN_ID).launchRecord!;
    wrapper = mount(LaunchRecordSection, {
      props: { record: { ...record, backgroundReview }, sectionId: 'ri-launch' },
    });
    await wrapper.get('h2 button').trigger('click');
    return spaced(wrapper.get('[data-testid="launch-background-review"]'));
  }

  it('shows config.yaml’s intervals, 0 as off', async () => {
    expect(await review({ memoryNudgeInterval: 0, skillCreationNudgeInterval: 0 })).toBe(
      'memory.nudge_interval 0 (off) skills.creation_nudge_interval 0 (off)' + NOTE,
    );
  });

  it('shows Hermes’s defaults when they are written', async () => {
    expect(await review({ memoryNudgeInterval: 10, skillCreationNudgeInterval: 1 })).toBe(
      'memory.nudge_interval 10 (every 10 user turns) skills.creation_nudge_interval 1 (every tool iteration)' +
        NOTE,
    );
  });

  it('says a record from before Phase 6 wrote none', async () => {
    expect(await review(null)).toBe(
      "Not written: Hermes's defaults applied (a record from before background review was pinned)",
    );
  });

  it('is in every fixture run’s record, with config.yaml showing the same values', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const record = await openLaunchRecord(wrapper);
    // Hermes's defaults, written explicitly (the one-shot trial never forks a review).
    expect(record).toContain('memory.nudge_interval 10 (every 10 user turns)');
    expect(record).toContain('nudge_interval: 10');
    expect(record).toContain('creation_nudge_interval: 10');
  });
});
