/**
 * Verifier script asks for the script first (SA.7 "with scripts", Phase 5b question 19):
 * the card's Script field starts on the task's only Python file, or empty when there are
 * several, and a pick without a script asks for one instead of taking the first file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { TaskFormCheck } from '@/api/types/authoring';
import CheckPicker from '../CheckPicker.vue';
import ChecksSection from '../ChecksSection.vue';
import { defaultParams } from '../checkText';
import { initialScript, scriptOptions } from '../scriptChoice';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const file = (path: string) => ({ path, sizeBytes: 100, sha256: 'a'.repeat(64) });
const optionTexts = (w: VueWrapper) =>
  w.findAll('[data-testid="picker-script"] option').map((o) => o.text());

describe('the script a Verifier script check starts with', () => {
  it('offers Python files first and starts on the only one', () => {
    expect(scriptOptions(['expected_summary.json', 'check_summary.py'])).toEqual([
      'check_summary.py',
      'expected_summary.json',
    ]);
    expect(initialScript(['expected_summary.json', 'check_summary.py'])).toBe('check_summary.py');
    expect(initialScript(['check_a.py', 'check_b.py'])).toBeNull();
    expect(initialScript(['expected.json'])).toBeNull();
  });

  it('never takes the first verify/ file on its own', () => {
    expect(defaultParams('verifier_script')).toEqual({});
    expect(defaultParams('verifier_script', 'check_summary.py')).toEqual({
      script: 'check_summary.py',
    });
  });
});

describe('CheckPicker with scripts', () => {
  it('draws the Script field in the card, set to the only Python file, and adds with it', async () => {
    wrapper = mount(CheckPicker, {
      props: { scripts: ['expected_summary.json', 'check_summary.py'] },
      attachTo: document.body,
    });
    await flushPromises();
    const cardEl = wrapper.get('[data-type="verifier_script"]');
    expect(cardEl.attributes('aria-disabled')).toBeUndefined();
    expect(cardEl.get('label').text()).toBe('Script');
    expect(optionTexts(wrapper)).toEqual(['check_summary.py', 'expected_summary.json']);
    expect(wrapper.get<HTMLSelectElement>('[data-testid="picker-script"]').element.value).toBe(
      'check_summary.py',
    );
    await cardEl.trigger('click');
    expect(wrapper.emitted('pick')).toEqual([['verifier_script', 'check_summary.py']]);
  });

  it('asks for the script when there are several, and adds once one is chosen', async () => {
    wrapper = mount(CheckPicker, {
      props: { scripts: ['check_fees.py', 'check_totals.py', 'expected_fees.json'] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(optionTexts(wrapper)).toEqual([
      'Choose a script…',
      'check_fees.py',
      'check_totals.py',
      'expected_fees.json',
    ]);
    const cardEl = wrapper.get('[data-type="verifier_script"]');
    await cardEl.trigger('click');
    expect(wrapper.emitted('pick')).toBeUndefined();
    const select = wrapper.get<HTMLSelectElement>('[data-testid="picker-script"]');
    expect(wrapper.get('[data-testid="picker-script-ask"]').text()).toBe(
      'Choose the script first.',
    );
    expect(select.attributes('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(select.element);
    expect(wrapper.get('[role="listbox"]').attributes('aria-activedescendant')).toBe(
      'ck-opt-verifier_script',
    );
    // A click in the field opens the select; it does not pick the card.
    await select.trigger('click');
    expect(wrapper.emitted('pick')).toBeUndefined();
    await select.setValue('check_totals.py');
    expect(wrapper.find('[data-testid="picker-script-ask"]').exists()).toBe(false);
    await select.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('pick')).toEqual([['verifier_script', 'check_totals.py']]);
  });

  it('asks the same way from the listbox with Enter', async () => {
    wrapper = mount(CheckPicker, {
      props: { scripts: ['check_a.py', 'check_b.py'] },
      attachTo: document.body,
    });
    await flushPromises();
    const list = wrapper.get('[role="listbox"]');
    await list.trigger('keydown', { key: 'End' });
    expect(list.attributes('aria-activedescendant')).toBe('ck-opt-verifier_script');
    await list.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('pick')).toBeUndefined();
    expect(wrapper.find('[data-testid="picker-script-ask"]').exists()).toBe(true);
  });
});

describe('Checks section with scripts', () => {
  const base = {
    answerPath: 'summary',
    reference: { summary: 1 },
    referenceValues: [],
    issues: [],
    tries: {},
    selfCheck: null,
    expectedFolder: null,
    sources: {},
    rubrics: {},
  };

  it('adds a Verifier script check naming the script the picker asked for', async () => {
    wrapper = mount(ChecksSection, {
      props: {
        ...base,
        checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
        scripts: [file('verify/a_expected.json'), file('verify/check_summary.py')],
      },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="add-check"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-type="verifier_script"]').trigger('click');
    const [checks] = wrapper.emitted('update')![0] as [TaskFormCheck[]];
    expect(checks[1]).toEqual({
      key: 'script',
      type: 'verifier_script',
      primary: false,
      params: { script: 'check_summary.py' },
    });
  });
});
