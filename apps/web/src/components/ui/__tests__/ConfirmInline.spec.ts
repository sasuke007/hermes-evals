import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';

const base = {
  triggerLabel: 'Cancel experiment',
  title: 'Cancel 32 unfinished runs?',
  consequence:
    '28 queued runs will not start. 3 running and 1 scoring run will be stopped and marked cancelled.',
  confirmLabel: 'Cancel experiment',
  cancelLabel: 'Keep running',
  busyLabel: 'Cancelling…',
};

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function make(props: Record<string, unknown> = {}) {
  wrapper = mount(ConfirmInline, {
    props: { ...base, ...props } as typeof base,
    attachTo: document.body,
  });
  return wrapper;
}

const buttons = (w: VueWrapper) => w.findAll('button').map((b) => b.text());

describe('ConfirmInline', () => {
  it('starts as the trigger button', () => {
    const w = make();
    expect(buttons(w)).toEqual(['Cancel experiment']);
    expect(w.find('[role="group"]').exists()).toBe(false);
    expect(w.find('button').classes()).toContain('danger');
  });

  it('replaces the trigger with the consequence and focuses the safe option', async () => {
    const w = make();
    await w.find('button').trigger('click');
    const group = w.find('[role="group"]');
    expect(group.exists()).toBe(true);
    expect(group.attributes('aria-label')).toBe('Cancel 32 unfinished runs?');
    expect(group.text()).toContain('Cancel 32 unfinished runs?');
    expect(group.text()).toContain('28 queued runs will not start.');
    expect(buttons(w)).toEqual(['Cancel experiment', 'Keep running']);
    expect(document.activeElement?.textContent?.trim()).toBe('Keep running');
  });

  it('backs out with Esc and returns focus to the trigger', async () => {
    const w = make();
    await w.find('button').trigger('click');
    await w.find('[role="group"]').trigger('keydown', { key: 'Escape' });
    expect(w.find('[role="group"]').exists()).toBe(false);
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('confirm')).toBeUndefined();
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel experiment');
  });

  it('backs out with the cancel button', async () => {
    const w = make();
    await w.find('button').trigger('click');
    await w.findAll('button')[1]!.trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(buttons(w)).toEqual(['Cancel experiment']);
  });

  it('emits confirm; the parent sets busy, then the panel closes', async () => {
    const w = make();
    await w.find('button').trigger('click');
    await w.findAll('button')[0]!.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);

    await w.setProps({ busy: true });
    const [confirm, cancel] = w.findAll('button');
    expect(confirm!.text()).toBe('Cancelling…');
    expect(confirm!.attributes('disabled')).toBeDefined();
    expect(cancel!.attributes('disabled')).toBeDefined();

    await w.setProps({ busy: false });
    expect(w.find('[role="group"]').exists()).toBe(false);
    expect(buttons(w)).toEqual(['Cancel experiment']);
  });

  it('shows a failure under the returned trigger, verbatim', async () => {
    const w = make();
    await w.find('button').trigger('click');
    await w.setProps({ busy: true });
    await w.setProps({
      busy: false,
      error: 'POST /api/experiments/e1/cancel → 502 · upstream api:8080 connection refused',
    });
    const alert = w.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.find('code').text()).toBe(
      'POST /api/experiments/e1/cancel → 502 · upstream api:8080 connection refused',
    );
    expect(buttons(w)[0]).toBe('Cancel experiment');
  });

  it('can be opened by the parent without a trigger (row layout)', async () => {
    const w = make({
      triggerLabel: null,
      title: 'Disconnect Nous Portal?',
      consequence: 'Running experiments that use it will pause.',
      confirmLabel: 'Disconnect',
      cancelLabel: 'Keep connected',
      layout: 'row',
      open: false,
    });
    expect(w.findAll('button')).toHaveLength(0);
    await w.setProps({ open: true });
    expect(w.find('.layout-row').exists()).toBe(true);
    expect(buttons(w)).toEqual(['Disconnect', 'Keep connected']);
    await w.findAll('button')[1]!.trigger('click');
    const opens = w.emitted('update:open') ?? [];
    expect(opens[opens.length - 1]).toEqual([false]);
  });

  it('uses a primary confirm for the default tone', async () => {
    const w = make({ tone: 'default' });
    await w.find('button').trigger('click');
    expect(w.findAll('button')[0]!.classes()).toContain('primary');
  });
});
