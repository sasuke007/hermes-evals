/**
 * Skill loading (Phase 6 P5) on the configuration pages: the form's two-option control, shown
 * only while skills are chosen, with its help line, the change summary and the saved body; a
 * 400 on the field; duplicate keeping the mode; the detail's row, the diff's row and the
 * list's tag. `skills-on-demand` moves with-skill v1 to on demand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// Loaded up front, so the lazy route a save opens resolves at once, even under load.
import '@/views/configurations/ConfigurationDetailPage.vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { SKILL_LOADING_NEEDS_SKILLS } from '@hermes-evals/shared';
import * as configurationsApi from '@/api/configurations';
import { ApiError } from '@/api/client';
import ConfigurationDetailPage from '@/views/configurations/ConfigurationDetailPage.vue';
import ConfigurationFormPage from '@/views/configurations/ConfigurationFormPage.vue';
import ConfigurationListPage from '@/views/configurations/ConfigurationListPage.vue';
import { CONFIG_IDS, CONFIG_VERSION_IDS } from '@/fixtures/configurations';
import { useConfigurationsStore } from '@/stores/configurations';
import { useProvidersStore } from '@/stores/providers';
import { mountPage, unmountAll } from './mountPage';

afterEach(() => {
  unmountAll();
  useProvidersStore().dispose();
  vi.restoreAllMocks();
});

const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
/** An element's text as words: each text node is one piece, as the flex gaps show them. */
function words(el: { element: Element }): string {
  const walker = document.createTreeWalker(el.element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (text) parts.push(text);
  }
  return norm(parts.join(' '));
}
const edit = (scenario: string | null = null) =>
  mountPage(ConfigurationFormPage, `/configurations/${CONFIG_IDS['with-skill']}/edit`, scenario);
const loading = (w: VueWrapper) => w.find('[data-testid="skill-loading"]');
const pressed = (w: VueWrapper) =>
  loading(w)
    .findAll('button')
    .filter((b) => b.attributes('aria-pressed') === 'true')
    .map((b) => b.text());
const choose = (w: VueWrapper, label: string) =>
  loading(w)
    .findAll('button')
    .find((b) => b.text() === label)!
    .trigger('click');
const changeRows = (w: VueWrapper) =>
  w
    .findAll('aside [data-testid="changes"] li')
    .map((li) => norm([...li.element.children].map((c) => c.textContent).join(' ')));

describe('the configuration form', () => {
  it('offers preload or on demand once a skill is chosen, with one line of help', async () => {
    const { w } = await edit();
    const control = loading(w);
    expect(control.get('[role="group"]').attributes('aria-label')).toBe('Skill loading');
    expect(control.findAll('button').map((b) => b.text())).toEqual(['preload', 'on demand']);
    expect(pressed(w)).toEqual(['preload']);
    expect(norm(control.get('p').text())).toBe(
      'Preload puts the skills in the prompt; on demand installs them for the agent to find, with the skills toolset.',
    );
  });

  it('saves the mode it is set to, and the aside names the change', async () => {
    const save = vi.spyOn(configurationsApi, 'saveConfiguration');
    const { w } = await edit();
    await choose(w, 'on demand');
    expect(pressed(w)).toEqual(['on demand']);
    expect(changeRows(w)).toEqual(['skill_loading preload → on demand']);
    await w.get('[data-testid="save"]').trigger('click');
    await flushPromises();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].skillLoading).toBe('on_demand');
  });

  it('hides the choice without skills and saves preload', async () => {
    const save = vi.spyOn(configurationsApi, 'saveConfiguration');
    const { w } = await mountPage(ConfigurationFormPage, '/configurations/new');
    expect(loading(w).exists()).toBe(false);
    await w
      .get('select[aria-label="Add skill"]')
      .setValue(useConfigurationsStore().formOptions!.skills[0]!.skillId);
    expect(pressed(w)).toEqual(['preload']);
    await choose(w, 'on demand');
    await w.get('button[aria-label="Remove invoice-method"]').trigger('click');
    expect(loading(w).exists()).toBe(false);
    expect(changeRows(w)).toEqual([]);
    await w.get('input[placeholder="e.g. or-baseline"]').setValue('no-skills');
    await w.get('[data-testid="save"]').trigger('click');
    await flushPromises();
    expect(save.mock.calls[0]![0]).toMatchObject({ skillIds: [], skillLoading: 'preload' });
  });

  it('shows a 400 on the field under Skills', async () => {
    vi.spyOn(configurationsApi, 'saveConfiguration').mockRejectedValue(
      new ApiError(400, 'PUT /api/configurations/x', 'invalid configuration', [
        { path: 'skillLoading', message: SKILL_LOADING_NEEDS_SKILLS },
      ]),
    );
    const { w } = await edit();
    await choose(w, 'on demand');
    await w.get('[data-testid="save"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain(SKILL_LOADING_NEEDS_SKILLS);
  });

  it('opens on demand where the version loads on demand, and duplicate keeps it', async () => {
    const { w } = await edit('skills-on-demand');
    expect(pressed(w)).toEqual(['on demand']);
    unmountAll();
    const copy = await mountPage(
      ConfigurationFormPage,
      `/configurations/new?from=${CONFIG_IDS['with-skill']}`,
      'skills-on-demand',
    );
    expect(pressed(copy.w)).toEqual(['on demand']);
    expect(copy.w.get('aside').text()).toContain('No changes yet.');
  });
});

describe('the configuration detail, diff and list', () => {
  const row = (w: VueWrapper) => w.get('dl [data-key="skill_loading"]');

  it('shows the mode under Skills, and that a version without skills has none to load', async () => {
    const skilled = await mountPage(
      ConfigurationDetailPage,
      `/configurations/${CONFIG_IDS['with-skill']}`,
    );
    expect(words(row(skilled.w))).toBe(
      'Skill loading preload Each skill is loaded into the prompt at start (-s per skill).',
    );
    unmountAll();
    const plain = await mountPage(
      ConfigurationDetailPage,
      `/configurations/${CONFIG_IDS.baseline}`,
    );
    expect(words(row(plain.w))).toBe('Skill loading preload (no added skills to load)');
  });

  it('on demand differs from the source, and Compare with… names skill_loading', async () => {
    const { w } = await mountPage(
      ConfigurationDetailPage,
      `/configurations/${CONFIG_IDS['with-skill']}`,
      'skills-on-demand',
    );
    expect(words(row(w))).toBe(
      'Skill loading on demand Skills are installed but not loaded; the agent lists and opens them with the skills toolset. differs from baseline',
    );
    expect(row(w).classes()).toContain('bg-accent-soft');
    await w
      .findAll('button')
      .find((b) => b.text() === 'Compare with…')!
      .trigger('click');
    await flushPromises();
    const panel = w.get('section[aria-labelledby^="diff-title"]');
    expect((panel.get('select').element as HTMLSelectElement).value).toBe(
      CONFIG_VERSION_IDS.baseline,
    );
    expect(panel.get('[data-testid="diff-line"]').text()).toBe(
      '2 fields differ: skills, skill_loading',
    );
    const loadingRow = panel.get('tr[data-field="skill_loading"]');
    expect(loadingRow.findAll('td').map((td) => words(td))).toEqual([
      '≠ skill_loading (differs)',
      'preload',
      'on demand',
    ]);
  });

  it('tags skills loaded on demand in the list', async () => {
    const plain = await mountPage(ConfigurationListPage, '/configurations');
    expect(plain.w.find('[data-testid="on-demand"]').exists()).toBe(false);
    unmountAll();
    const { w } = await mountPage(ConfigurationListPage, '/configurations', 'skills-on-demand');
    const tags = w.findAll('[data-testid="on-demand"]');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.element.closest('tr')!.getAttribute('data-id')).toBe(CONFIG_IDS['with-skill']);
  });
});
