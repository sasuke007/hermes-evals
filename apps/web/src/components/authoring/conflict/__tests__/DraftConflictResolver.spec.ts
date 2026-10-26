import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { getSuiteDraft } from '@/api/drafts';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import type { SuiteDraftView } from '@/api/types/authoring';
import { SUITE_V1_ID, SUITE_V2_ID } from '@/fixtures/suites';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { hhmm } from '../../draft-bar/draftText';
import DraftConflictResolver from '../DraftConflictResolver.vue';

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  useScenario('draft-conflict-overlap');
  resetDraftFixtures();
  setActivePinia(createPinia());
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The draft of the overlap scenario, its newer version being the fixtures' v2 on disk. */
async function overlapDraft(): Promise<SuiteDraftView> {
  const draft = await getSuiteDraft('invoices-v1');
  return {
    ...draft,
    base: { ...draft.base!, suiteId: SUITE_V1_ID },
    conflict: { ...draft.conflict!, current: { ...draft.conflict!.current, suiteId: SUITE_V2_ID } },
  };
}

describe('DraftConflictResolver (SA.12)', () => {
  it('sets the two versions of total_due side by side and takes one', async () => {
    const draft = await overlapDraft();
    wrapper = mount(DraftConflictResolver, { props: { draft, choices: {} } });
    await flushPromises();
    const section = wrapper.get('[data-overlap="total_due"]');
    expect(flat(section.get('h2').text())).toBe('total_due changed in your draft and on disk');
    expect(section.text()).toContain('1 overlap · choose one version');
    const [mine, disk] = section.findAll('label[data-side]');
    expect(flat(mine!.get('b').text())).toBe('Keep my version');
    expect(mine!.text()).toContain(`Your draft · based on v${draft.conflict!.baseVersion}`);
    expect(flat(disk!.get('b').text())).toBe('Keep the version on disk');
    expect(disk!.text()).toContain(
      `On disk · v${draft.conflict!.current.versionNumber}, loaded ${hhmm(draft.conflict!.current.loadedAt)}`,
    );
    expect(disk!.get('[data-testid="side-summary"]').text()).toBe(
      'prompt +1 line −1 line · task.yaml as in v1 · reference answer changed · 1 file changed',
    );
    expect(disk!.findAll('pre')[0]!.find('.bg-pass-soft').text()).toContain(
      'and invoices paid in part',
    );
    expect(flat(section.get('p').text())).toContain(
      "Keeping one version keeps that whole task. The other side's change to total_due is dropped, and you can redo it in the editor after combining.",
    );
    await disk!.get('input[type="radio"]').setValue(true);
    expect(wrapper.emitted('update:choices')).toEqual([[{ total_due: 'disk' }]]);
  });

  it('draws nothing when the two sides touch different tasks', async () => {
    const draft = await overlapDraft();
    wrapper = mount(DraftConflictResolver, {
      props: { draft: { ...draft, conflict: { ...draft.conflict!, overlap: [] } } },
    });
    expect(wrapper.find('[data-testid="conflict-resolver"]').exists()).toBe(false);
  });
});
