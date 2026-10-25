import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ChipListInput from '../ChipListInput.vue';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
});

function chips(names: string[]) {
  w = mount(ChipListInput, {
    props: {
      label: 'Environment variable names',
      inputLabel: 'Add variable name',
      modelValue: names,
      'onUpdate:modelValue': (value: string[]) => w?.setProps({ modelValue: value }),
    },
    attachTo: document.body,
  });
  return w;
}

describe('ChipListInput', () => {
  it('a press anywhere on the box puts the caret in its text box, keeping what was typed', async () => {
    const wrapper = chips(['INVOICE_DB_URL']);
    const input = wrapper.get('input');
    expect(document.activeElement).not.toBe(input.element);
    await wrapper.get('[data-testid="chip-list"]').trigger('mousedown');
    expect(document.activeElement).toBe(input.element);

    await input.setValue('VENDOR_TOKEN');
    await wrapper.get('[data-testid="chip-list"]').trigger('mousedown');
    expect(document.activeElement).toBe(input.element);
    expect((input.element as HTMLInputElement).value).toBe('VENDOR_TOKEN');
  });

  it("a press on a chip's remove button removes it and does not steal the press", async () => {
    const wrapper = chips(['A_NAME', 'B_NAME']);
    await wrapper.get('button[aria-label="Remove A_NAME"]').trigger('mousedown');
    expect(document.activeElement).not.toBe(wrapper.get('input').element);
    await wrapper.get('button[aria-label="Remove A_NAME"]').trigger('click');
    expect(wrapper.findAll('[data-testid="chip"]').map((c) => c.text())).toEqual(['B_NAME ×']);
  });
});
