import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import CandidateSelect from '../CandidateSelect.vue';
import ComparisonControls from '../ComparisonControls.vue';
import { SCORE_KEY_HELP } from '../readings';
import { EXPERIMENT_IDS, getComparison } from '@/api/experiments';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

beforeEach(() => useScenario(null));
afterEach(() => {
  document.body.innerHTML = '';
});

describe('CandidateSelect', () => {
  it('lists the candidates with their verdicts and picks one from the keyboard', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillMcp);
    const w = mount(CandidateSelect, {
      props: { options: view.candidates, modelValue: view.candidate.versionId },
      attachTo: document.body,
    });
    const button = w.get('button');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(button.text()).toBe('with-skill');
    await button.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    const list = w.get('[role=listbox]');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(list.element);
    const options = w.findAll('[role=option]');
    expect(options.map((o) => o.text())).toEqual(['with-skillbetter', 'with-mcpprovisional']);
    expect(options[0]!.attributes('aria-selected')).toBe('true');
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(list.attributes('aria-activedescendant')).toBe(options[1]!.attributes('id'));
    await list.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('update:modelValue')).toEqual([[view.candidates[1]!.configuration.versionId]]);
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button.element);
  });

  it('closes on Esc without picking', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillMcp);
    const w = mount(CandidateSelect, {
      props: { options: view.candidates, modelValue: view.candidate.versionId },
      attachTo: document.body,
    });
    await w.get('button').trigger('click');
    await flushPromises();
    await w.get('[role=listbox]').trigger('keydown', { key: 'Escape' });
    expect(w.get('button').attributes('aria-expanded')).toBe('false');
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });
});

describe('ComparisonControls', () => {
  it('shows the fixed baseline, the only candidate, the key and the filter with counts', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    const w = mount(ComparisonControls, { props: { view, filter: 'all' } });
    expect(w.get('[data-testid=baseline]').text()).toBe('baseline');
    expect(w.get('[data-testid=baseline]').attributes('title')).toBe('Fixed by the experiment');
    expect(w.findAll('[data-testid=candidate] span').map((s) => s.text())).toEqual([
      'with-skill',
      'only one',
    ]);
    expect(w.get('label[for=cmp-key]').text()).toBe('Score key');
    expect(w.get('[data-testid=field-help]').text()).toBe(SCORE_KEY_HELP);
    expect(w.findAll('option').map((o) => o.text())).toEqual([
      'Primary key per task',
      'answer (all 12 tasks)',
      'Any key failed',
    ]);
    const filters = w.findAll('[role=group] button');
    expect(filters.map((b) => b.text())).toEqual([
      'All tasks 12',
      'Improved 8',
      'Regressed 0',
      'Unchanged 4',
    ]);
    await filters[2]!.trigger('click');
    expect(w.emitted('update:filter')).toEqual([['regressed']]);
    await w.get('select').setValue('any_failed');
    expect(w.emitted('update:scoreKey')).toEqual([['any_failed']]);
  });

  it('offers a candidate select from two candidates on, and hides the filter when asked', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillMcp);
    const w = mount(ComparisonControls, {
      props: { view, filter: 'all', showFilter: false },
      attachTo: document.body,
    });
    expect(w.find('[data-testid=candidate]').exists()).toBe(false);
    const select = w.get('[data-testid=candidate-select]');
    expect(
      document.getElementById(select.attributes('aria-labelledby')!.split(' ')[0]!)?.textContent,
    ).toBe('Candidate');
    expect(w.find('[role=group][aria-label="Filter tasks"]').exists()).toBe(false);
  });
});
