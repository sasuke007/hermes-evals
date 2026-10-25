import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import BaseInput from '@/components/ui/BaseInput.vue';
import FormField from '@/components/ui/FormField.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import TextArea from '@/components/ui/TextArea.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import ToggleButton from '@/components/ui/ToggleButton.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('FormField and BaseInput', () => {
  it('labels the control and describes it with the help line', () => {
    wrapper = mount(BaseInput, {
      props: { label: 'Name', help: 'Shown in the experiment list.', modelValue: 'x' },
    });
    const input = wrapper.get('input');
    expect(wrapper.get('label').attributes('for')).toBe(input.attributes('id'));
    const help = wrapper.get('[data-testid="field-help"]');
    expect(input.attributes('aria-describedby')).toBe(help.attributes('id'));
    expect(help.classes()).toContain('text-text-3');
    expect(input.attributes('aria-invalid')).toBeUndefined();
    expect(input.classes()).toContain('input');
  });

  it('turns the help amber for a warning and orange for an error, which marks it invalid', async () => {
    wrapper = mount(BaseInput, {
      props: {
        label: 'Repetitions',
        warning: 'A single repetition cannot produce a confidence interval.',
        mono: true,
      },
    });
    expect(wrapper.get('[data-testid="field-help"]').classes()).toContain('text-ung-text');
    expect(wrapper.get('input').classes()).toEqual(expect.arrayContaining(['warn', 'font-mono']));
    await wrapper.setProps({ error: 'Name is required.' });
    expect(wrapper.get('[data-testid="field-help"]').text()).toBe('Name is required.');
    expect(wrapper.get('[data-testid="field-help"]').classes()).toContain('text-fail-text');
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('input').classes()).not.toContain('warn');
  });

  it('updates the model and marks a required field', async () => {
    let value: string | number | null = '';
    wrapper = mount(BaseInput, {
      props: {
        label: 'Name',
        required: true,
        modelValue: value,
        'onUpdate:modelValue': (v: string | number | null) => (value = v),
      },
    });
    expect(wrapper.get('label').text()).toBe('Name *');
    await wrapper.get('input').setValue('Skill vs no skill');
    expect(value).toBe('Skill vs no skill');
  });

  it('lends its ids to any control in the slot', () => {
    wrapper = mount(FormField, {
      props: { label: 'Concurrency', id: 'ne-conc', error: 'At most 3' },
      slots: {
        default: `<template #default="{ id, describedBy, invalid }">
          <input :id="id" :aria-describedby="describedBy" :aria-invalid="invalid" />
        </template>`,
      },
    });
    const input = wrapper.get('input');
    expect(input.attributes('id')).toBe('ne-conc');
    expect(input.attributes('aria-describedby')).toBe('ne-conc-help');
    expect(input.attributes('aria-invalid')).toBe('true');
  });
});

describe('TextArea', () => {
  it('is a labelled textarea', async () => {
    wrapper = mount(TextArea, { props: { label: 'Description', rows: 2, modelValue: 'a' } });
    const area = wrapper.get('textarea');
    expect(area.attributes('rows')).toBe('2');
    expect(wrapper.get('label').attributes('for')).toBe(area.attributes('id'));
  });
});

describe('Select', () => {
  const options = [
    { value: 'all', label: 'All' },
    { value: 'baseline', label: 'baseline' },
    { value: 'with-skill', label: 'with-skill', disabled: true },
  ];

  it('renders the options and updates the model', async () => {
    let value = 'all';
    wrapper = mount(BaseSelect<string>, {
      props: {
        options,
        ariaLabel: 'Configuration',
        size: 'sm',
        modelValue: value,
        'onUpdate:modelValue': (v: string) => (value = v),
      },
    });
    const select = wrapper.get('select');
    expect(select.attributes('aria-label')).toBe('Configuration');
    expect(select.classes()).toEqual(expect.arrayContaining(['input', 'sm']));
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual([
      'All',
      'baseline',
      'with-skill',
    ]);
    expect(wrapper.findAll('option')[2]!.attributes('disabled')).toBeDefined();
    await select.setValue('baseline');
    expect(value).toBe('baseline');
  });

  it('sits in a FormField with a label', () => {
    wrapper = mount(BaseSelect<string>, {
      props: {
        options,
        label: 'Score key',
        help: 'Default: each task’s primary check.',
        modelValue: 'all',
      },
    });
    expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('select').attributes('id'));
    expect(wrapper.get('select').attributes('aria-describedby')).toBeDefined();
  });
});

describe('Toggle and ToggleButton', () => {
  it('is a switch that flips aria-checked', async () => {
    let on = false;
    wrapper = mount(BaseToggle, {
      props: {
        label: 'Memory disabled',
        modelValue: on,
        'onUpdate:modelValue': (v: boolean) => {
          on = v;
          void wrapper!.setProps({ modelValue: v });
        },
      },
    });
    const sw = wrapper.get('[role="switch"]');
    expect(sw.attributes('aria-checked')).toBe('false');
    await sw.trigger('click');
    expect(on).toBe(true);
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[role="switch"]').classes()).toContain('bg-accent');
  });

  it('presses a filter and a toolset chip', async () => {
    let pressed = false;
    wrapper = mount(ToggleButton, {
      props: { modelValue: pressed, 'onUpdate:modelValue': (v: boolean) => (pressed = v) },
      slots: { default: 'Has execution error' },
    });
    expect(wrapper.attributes('aria-pressed')).toBe('false');
    expect(wrapper.classes()).toContain('h-30');
    await wrapper.trigger('click');
    expect(pressed).toBe(true);
    wrapper.unmount();
    wrapper = mount(ToggleButton, { props: { variant: 'chip', modelValue: true } });
    expect(wrapper.attributes('aria-pressed')).toBe('true');
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['rounded-full', 'font-mono']));
  });
});
