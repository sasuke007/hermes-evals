import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import BaseDialog from '@/components/ui/BaseDialog.vue';
import BaseDrawer from '@/components/ui/BaseDrawer.vue';
import BaseTooltip from '@/components/ui/BaseTooltip.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

/** A page with an opener button and a Dialog it opens. */
function dialogPage(props: Record<string, unknown> = {}) {
  const open = ref(false);
  const Page = defineComponent({
    setup() {
      return () =>
        h('div', [
          h('button', { id: 'opener', onClick: () => (open.value = true) }, 'Upload skill'),
          h(
            BaseDialog,
            {
              title: 'Upload skill',
              open: open.value,
              'onUpdate:open': (v: boolean) => (open.value = v),
              'data-phase': 'validate',
              ...props,
            },
            {
              default: () => [h('input', { id: 'first' }), h('a', { href: '#' }, 'Docs')],
              'header-extra': () => h('span', 'Step 2 of 2 · Validate'),
              footer: () => [
                h('button', { id: 'back' }, 'Back'),
                h('button', { id: 'confirm', 'data-primary': '' }, 'Confirm upload'),
              ],
            },
          ),
        ]);
    },
  });
  wrapper = mount(Page, { attachTo: document.body });
  return { open, w: wrapper };
}

const dialogEl = () => wrapper!.find('[role="dialog"]');

describe('Dialog', () => {
  it('is a labelled modal, with the extra attributes on the dialog', async () => {
    const { open } = dialogPage();
    expect(dialogEl().exists()).toBe(false);
    open.value = true;
    await flushPromises();
    const d = dialogEl();
    expect(d.attributes('aria-modal')).toBe('true');
    expect(d.attributes('data-phase')).toBe('validate');
    expect(document.getElementById(d.attributes('aria-labelledby')!)?.textContent?.trim()).toBe(
      'Upload skill',
    );
    expect(d.text()).toContain('Step 2 of 2 · Validate');
    expect(wrapper!.findAll('[data-testid="dialog-footer"] button').map((b) => b.text())).toEqual([
      'Back',
      'Confirm upload',
    ]);
  });

  it('focuses the primary action, traps Tab, and gives focus back on Esc', async () => {
    const { w } = dialogPage();
    const opener = w.get('#opener').element as HTMLElement;
    opener.focus();
    await w.get('#opener').trigger('click');
    await flushPromises();
    expect(document.activeElement?.id).toBe('confirm');
    // Tab from the last control wraps to the first (the × close button), Shift+Tab back.
    await dialogEl().trigger('keydown', { key: 'Tab' });
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Close');
    await dialogEl().trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.id).toBe('confirm');
    await dialogEl().trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(dialogEl().exists()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('closes from × and the scrim, unless not dismissible', async () => {
    const { open, w } = dialogPage();
    open.value = true;
    await flushPromises();
    await w.get('button[aria-label="Close"]').trigger('click');
    expect(open.value).toBe(false);
    open.value = true;
    await flushPromises();
    await w.get('[data-testid="dialog-scrim"]').trigger('mousedown');
    expect(open.value).toBe(false);

    wrapper!.unmount();
    const fixed = dialogPage({ dismissible: false });
    fixed.open.value = true;
    await flushPromises();
    expect(fixed.w.find('button[aria-label="Close"]').exists()).toBe(false);
    await dialogEl().trigger('keydown', { key: 'Escape' });
    await fixed.w.get('[data-testid="dialog-scrim"]').trigger('mousedown');
    expect(fixed.open.value).toBe(true);
  });
});

describe('Drawer', () => {
  function drawerPage(onClose: () => void) {
    const shown = ref(false);
    const Page = defineComponent({
      setup() {
        return () =>
          h('div', [
            h('button', { id: 'row', onClick: () => (shown.value = true) }, 'run_a'),
            shown.value
              ? h(
                  BaseDrawer,
                  { titleId: 'ri-title', onClose },
                  {
                    header: () => h('h2', { id: 'ri-title' }, 'total_due'),
                    default: () => h('button', { 'data-primary': '' }, 'Re-score'),
                  },
                )
              : null,
          ]);
      },
    });
    wrapper = mount(Page, { attachTo: document.body });
    return { shown, w: wrapper };
  }

  it('is a modal labelled by its heading; Esc, window Esc and the scrim ask to close', async () => {
    let closes = 0;
    const { shown, w } = drawerPage(() => closes++);
    shown.value = true;
    await flushPromises();
    const aside = w.get('aside[role="dialog"]');
    expect(aside.attributes('aria-modal')).toBe('true');
    expect(aside.attributes('aria-labelledby')).toBe('ri-title');
    expect(document.activeElement?.textContent).toBe('Re-score');
    await aside.trigger('keydown', { key: 'Escape' });
    expect(closes).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closes).toBe(2);
    await w.get('[data-testid="drawer-scrim"]').trigger('mousedown');
    expect(closes).toBe(3);
  });

  it('keeps 75% of the window by default and takes a fixed width when given one', async () => {
    wrapper = mount(BaseDrawer, { props: { label: 'Skill' }, attachTo: document.body });
    let aside = wrapper.get('aside[role="dialog"]');
    expect(aside.classes()).toContain('w-[min(100%,max(960px,75%))]');
    expect(aside.classes()).toContain('overscroll-contain');
    wrapper.unmount();
    wrapper = mount(BaseDrawer, { props: { label: 'Skill', width: 640 }, attachTo: document.body });
    aside = wrapper.get('aside[role="dialog"]');
    expect(aside.classes()).toContain('w-full');
    expect((aside.element as HTMLElement).style.maxWidth).toBe('640px');
  });

  it('gives focus back to the opener when it unmounts (the route closed it)', async () => {
    const { shown, w } = drawerPage(() => {});
    const opener = w.get('#row').element as HTMLElement;
    opener.focus();
    shown.value = true;
    await flushPromises();
    expect(document.activeElement).not.toBe(opener);
    shown.value = false;
    await nextTick();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Tooltip', () => {
  it('describes its trigger and hides on Esc until the pointer leaves', async () => {
    const Host = defineComponent({
      setup() {
        return () =>
          h(
            BaseTooltip,
            { text: 'Counterpart run was cancelled' },
            {
              default: ({ describedBy }: { describedBy?: string }) =>
                h('button', { disabled: true, 'aria-describedby': describedBy }, 'Same task'),
            },
          );
      },
    });
    wrapper = mount(Host, { attachTo: document.body });
    const tip = wrapper.get('[role="tooltip"]');
    expect(tip.text()).toBe('Counterpart run was cancelled');
    expect(wrapper.get('button').attributes('aria-describedby')).toBe(tip.attributes('id'));
    expect(tip.classes()).toContain('invisible');
    expect(tip.classes()).toContain('group-hover/tooltip:visible');
    await wrapper.trigger('keydown', { key: 'Escape' });
    expect(wrapper.get('[role="tooltip"]').classes()).toContain('hidden');
    await wrapper.trigger('mouseleave');
    expect(wrapper.get('[role="tooltip"]').classes()).not.toContain('hidden');
  });

  it('lets Esc through when it has no tooltip to hide', async () => {
    const reached: string[] = [];
    const Host = defineComponent({
      props: { enabled: { type: Boolean, default: true }, text: { type: String, default: 'Why' } },
      setup(props) {
        return () =>
          h('div', { onKeydown: (e: KeyboardEvent) => reached.push(e.key) }, [
            h(BaseTooltip, { text: props.text, enabled: props.enabled }, () =>
              h('button', 'Same task'),
            ),
          ]);
      },
    });
    wrapper = mount(Host, { props: { enabled: false }, attachTo: document.body });
    await wrapper.get('button').trigger('keydown', { key: 'Escape' });
    expect(reached).toEqual(['Escape']);
    await wrapper.setProps({ enabled: true, text: '' });
    await wrapper.get('button').trigger('keydown', { key: 'Escape' });
    expect(reached).toEqual(['Escape', 'Escape']);
    // A tooltip on show takes the first Esc.
    await wrapper.setProps({ text: 'Counterpart run was cancelled' });
    await wrapper.get('button').trigger('keydown', { key: 'Escape' });
    expect(reached).toEqual(['Escape', 'Escape']);
  });

  it('draws rich content as a card, and nothing when disabled', () => {
    wrapper = mount(BaseTooltip, {
      props: { variant: 'card', width: 360 },
      slots: { default: '<span>late_fees</span>', content: '<b>late_fees cannot be selected</b>' },
    });
    const tip = wrapper.get('[role="tooltip"]');
    expect(tip.find('b').text()).toBe('late_fees cannot be selected');
    expect(tip.attributes('style')).toContain('width: 360px');
    wrapper.unmount();
    wrapper = mount(BaseTooltip, { props: { text: 'x', enabled: false }, slots: { default: 'y' } });
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });
});
