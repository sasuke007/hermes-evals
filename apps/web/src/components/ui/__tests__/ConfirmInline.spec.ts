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

  it('stays open on a failure with the server message verbatim, and offers Try again', async () => {
    const w = make({ errorTitle: 'Could not cancel. Nothing was stopped.' });
    await w.find('button').trigger('click');
    await w.setProps({ busy: true });
    await w.setProps({
      busy: false,
      error: 'POST /api/experiments/e1/cancel → 502 · upstream api:8080 connection refused',
    });
    expect(w.find('[role="group"]').exists()).toBe(true);
    const alert = w.find('[role="alert"]');
    expect(alert.find('b').text()).toBe('Could not cancel. Nothing was stopped.');
    expect(alert.find('code').text()).toBe(
      'POST /api/experiments/e1/cancel → 502 · upstream api:8080 connection refused',
    );
    // The message takes the consequence's place.
    expect(w.text()).not.toContain('28 queued runs will not start.');
    expect(buttons(w)).toEqual(['Try again', 'Keep running']);
    await w.findAll('button')[0]!.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    // Keep running closes it and the trigger returns.
    await w.findAll('button')[1]!.trigger('click');
    expect(buttons(w)).toEqual(['Cancel experiment']);
  });

  it('shows a spinner while busy', async () => {
    const w = make();
    await w.find('button').trigger('click');
    await w.setProps({ busy: true });
    expect(w.find('[role="group"]').attributes('aria-busy')).toBe('true');
    expect(w.findAll('button')[0]!.find('.animate-spin').exists()).toBe(true);
  });

  it('columns: the title on its own line over the consequence, buttons beside (OverviewRunning)', async () => {
    const w = make({ layout: 'columns' });
    await w.get('button').trigger('click');
    const group = w.get('[role="group"]');
    expect(group.classes()).toEqual(
      expect.arrayContaining(['px-16', 'py-14', 'gap-x-24', 'gap-y-12', 'justify-between']),
    );
    const text = w.get('[data-testid="confirm-text"]');
    expect(text.classes()).toEqual(expect.arrayContaining(['flex-col', 'max-w-820', 'gap-2']));
    // Two lines: the title, then the consequence (no space joins them into one run).
    expect(text.element.children).toHaveLength(2);
    expect(text.element.children[0]!.textContent).toBe('Cancel 32 unfinished runs?');
    expect(text.get('[data-testid="confirm-consequence"]').text()).toContain('28 queued runs');
  });

  it('row: one run of text, as the System provider row draws it', async () => {
    const w = make({ layout: 'row' });
    await w.get('button').trigger('click');
    expect(w.get('[role="group"]').classes()).toEqual(
      expect.arrayContaining(['px-16', 'py-10', 'gap-x-20']),
    );
    expect(w.get('[data-testid="confirm-text"]').text()).toMatch(
      /^Cancel 32 unfinished runs\? 28 queued runs/,
    );
  });

  it('takes a #consequence slot for rich text', async () => {
    wrapper = mount(ConfirmInline, {
      props: base,
      slots: { consequence: 'marked <span class="font-mono">cancelled</span>.' },
      attachTo: document.body,
    });
    await wrapper.get('button').trigger('click');
    expect(wrapper.get('[data-testid="confirm-consequence"] .font-mono').text()).toBe('cancelled');
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
    expect(w.find('[data-layout="row"]').exists()).toBe(true);
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
