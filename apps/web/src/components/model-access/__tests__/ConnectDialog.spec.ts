import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ConnectDialog from '@/components/model-access/ConnectDialog.vue';
import { useProvidersStore, type FollowUpAction } from '@/stores/providers';
import { setVisibility, useScenario } from '@/stores/__tests__/scenarioEnv';

let wrapper: VueWrapper | null = null;

async function setup(scenario: string | null = 'nous-not-connected') {
  useScenario(scenario);
  setActivePinia(createPinia());
  const store = useProvidersStore();
  await store.load();
  wrapper = mount(ConnectDialog, { attachTo: document.body, props: { devControls: true } });
  return { store, w: wrapper };
}

const dialog = () => wrapper!.find('[role="dialog"]');
const footerButtons = () => wrapper!.findAll('.dlg-f button, .dlg-f a').map((b) => b.text());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T15:00:00Z'));
  setVisibility('visible');
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  useProvidersStore().dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ConnectDialog', () => {
  it('renders nothing until opened', async () => {
    await setup();
    expect(dialog().exists()).toBe(false);
  });

  it('is a labelled modal dialog', async () => {
    const { store } = await setup();
    store.dialogOpen = true;
    store.loginPhase = 'requesting';
    await flushPromises();
    const d = dialog();
    expect(d.attributes('aria-modal')).toBe('true');
    const labelId = d.attributes('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('Connect Nous Portal');
    expect(d.find('button[aria-label="Close"]').exists()).toBe(true);
  });

  it('draws Requesting with a Cancel', async () => {
    const { store } = await setup();
    store.dialogOpen = true;
    store.loginPhase = 'requesting';
    await flushPromises();
    expect(dialog().text()).toContain('Asking Nous Portal for a code…');
    expect(footerButtons()).toEqual(['Cancel']);
  });

  it('draws Waiting: code, copy, link, countdown, four steps, cancel, note', async () => {
    const { store } = await setup();
    await store.connect('other');
    await flushPromises();
    const d = dialog();
    expect(d.attributes('data-phase')).toBe('waiting');
    expect(d.text()).toContain('Your code');
    expect(d.find('[data-testid="user-code"]').text()).toBe('K7QD-P2MX');
    expect(d.find('button[aria-label="Copy code"]').text()).toContain('Copy');
    expect(d.text()).toContain('15:00 left');
    const open = d.find('a.btn.primary');
    expect(open.text()).toBe('Open Nous Portal ↗');
    expect(open.attributes('href')).toContain('K7QD-P2MX');
    expect(open.attributes('target')).toBe('_blank');
    expect(open.attributes('rel')).toContain('noopener');
    expect(d.findAll('ol li').map((li) => li.text())).toEqual([
      'Click Open Nous Portal.',
      'Sign in to Nous Portal.',
      'Check the code matches, then approve.',
      'Come back here. This updates by itself.',
    ]);
    expect(d.text()).toContain('Cancel login');
    expect(d.text()).toContain(
      'You can close this window; the login keeps waiting in the background.',
    );
    // Focus starts on the primary action.
    expect(document.activeElement).toBe(open.element);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(d.text()).toContain('14:52 left');
  });

  it('closes with Esc but keeps the login waiting', async () => {
    const { store } = await setup();
    await store.connect('other');
    await flushPromises();
    await dialog().trigger('keydown', { key: 'Escape' });
    expect(dialog().exists()).toBe(false);
    expect(store.loginPhase).toBe('waiting');
    expect(store.approvalLeft).toBe('15:00');
  });

  it('closes from the × and the scrim, keeping the login', async () => {
    const { store } = await setup();
    await store.connect('other');
    await flushPromises();
    await wrapper!.find('button[aria-label="Close"]').trigger('click');
    expect(store.dialogOpen).toBe(false);
    await store.openDialog();
    await flushPromises();
    await wrapper!.find('.cd-scrim').trigger('mousedown');
    expect(store.dialogOpen).toBe(false);
    expect(store.loginPhase).toBe('waiting');
  });

  it('traps Tab inside the dialog', async () => {
    const { store } = await setup();
    await store.connect('other');
    await flushPromises();
    const focusable = dialog().findAll('a[href], button:not([disabled])');
    const first = focusable[0]!.element as HTMLElement;
    const last = focusable[focusable.length - 1]!.element as HTMLElement;
    last.focus();
    await dialog().trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    await dialog().trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('cancels the login from Cancel login', async () => {
    const { store } = await setup();
    await store.connect('other');
    await flushPromises();
    const cancel = dialog()
      .findAll('button')
      .find((b) => b.text() === 'Cancel login')!;
    await cancel.trigger('click');
    await flushPromises();
    expect(store.dialogOpen).toBe(false);
    expect(store.loginPhase).toBe('idle');
    expect(store.nousStatus).toBe('not_connected');
  });

  describe('Connected follow-up by origin', () => {
    it('new-experiment: Back to the form and Launch now; never launches by itself', async () => {
      const { store } = await setup();
      const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
      await store.connect('new-experiment', onFollowUp, {
        experimentName: 'Skill vs no skill, invoices-v1',
      });
      await flushPromises();
      await wrapper!.find('[data-outcome="approve"]').trigger('click');
      await flushPromises();
      expect(dialog().attributes('data-phase')).toBe('connected');
      expect(dialog().text()).toContain('Nous Portal is connected.');
      expect(dialog().text()).toContain(
        'Skill vs no skill, invoices-v1 can launch now. Your form is unchanged.',
      );
      expect(footerButtons()).toEqual(['Back to the form', 'Launch now']);
      expect(onFollowUp).not.toHaveBeenCalled();
      expect(document.activeElement?.textContent?.trim()).toBe('Launch now');

      await wrapper!
        .findAll('.dlg-f button')
        .find((b) => b.text() === 'Launch now')!
        .trigger('click');
      expect(onFollowUp).toHaveBeenCalledWith('launch');
      expect(dialog().exists()).toBe(false);
    });

    it('new-experiment: Back to the form', async () => {
      const { store } = await setup();
      const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
      await store.connect('new-experiment', onFollowUp);
      await flushPromises();
      store.simulate('approve');
      await flushPromises();
      await wrapper!.findAll('.dlg-f button')[0]!.trigger('click');
      expect(onFollowUp).toHaveBeenCalledWith('back');
    });

    it('paused-experiment: Reconnect heading, Close and Resume experiment', async () => {
      const { store } = await setup();
      const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
      await store.connect('paused-experiment', onFollowUp, {
        experimentName: 'Skill vs no skill, invoices-v1',
        scored: 87,
        total: 120,
      });
      await flushPromises();
      store.simulate('approve');
      await flushPromises();
      expect(dialog().text()).toContain('Reconnect Nous Portal');
      expect(dialog().text()).toContain(
        'Skill vs no skill, invoices-v1 is still paused at 87 of 120.',
      );
      expect(footerButtons()).toEqual(['Close', 'Resume experiment']);
      await wrapper!.findAll('.dlg-f button')[1]!.trigger('click');
      expect(onFollowUp).toHaveBeenCalledWith('resume');
    });

    it('paused-experiment: Close does not resume', async () => {
      const { store } = await setup();
      const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
      await store.connect('paused-experiment', onFollowUp);
      await flushPromises();
      store.simulate('approve');
      await flushPromises();
      await wrapper!.findAll('.dlg-f button')[0]!.trigger('click');
      expect(onFollowUp).not.toHaveBeenCalled();
      expect(store.dialogOpen).toBe(false);
    });

    it('anywhere else: Done', async () => {
      const { store } = await setup();
      const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
      await store.connect('other', onFollowUp);
      await flushPromises();
      store.simulate('approve');
      await flushPromises();
      expect(dialog().text()).toContain('Every configuration that uses Nous Portal can now run.');
      expect(footerButtons()).toEqual(['Done']);
      await wrapper!.find('.dlg-f button').trigger('click');
      expect(onFollowUp).toHaveBeenCalledWith('done');
    });
  });

  describe('end states, each with one retry action', () => {
    it.each([
      [
        'expire',
        'The code expired before it was approved.',
        'Get a new code and approve it in Nous Portal.',
        'Get a new code',
      ],
      [
        'decline',
        'The login was declined in Nous Portal.',
        'Nothing was connected. Try again if that was a mistake.',
        'Try again',
      ],
      [
        'subscription',
        'This Nous account has no active subscription.',
        'Add a subscription in Nous Portal, then connect again.',
        'Open Nous Portal billing ↗',
      ],
      [
        'fail',
        'Could not reach Nous Portal: connection timed out.',
        'Check that the stack can reach the internet through the egress service, then try again.',
        'Try again',
      ],
    ] as const)('%s', async (outcome, lead, body, action) => {
      const { store } = await setup();
      await store.connect('other');
      await flushPromises();
      store.simulate(outcome);
      await flushPromises();
      const alert = dialog().find('[role="alert"]');
      expect(alert.text()).toContain(lead);
      expect(alert.text()).toContain(body);
      expect(footerButtons()).toEqual(['Close', action]);
      expect(document.activeElement?.textContent?.trim()).toBe(action);
    });

    it('opens billing in a new tab for a missing subscription', async () => {
      const { store } = await setup();
      await store.connect('other');
      await flushPromises();
      store.simulate('subscription');
      await flushPromises();
      const link = dialog().find('.dlg-f a');
      expect(link.attributes('href')).toContain('billing');
      expect(link.attributes('target')).toBe('_blank');
    });

    it('gets a new code from Expired and waits again', async () => {
      const { store } = await setup();
      await store.connect('other');
      await flushPromises();
      store.simulate('expire');
      await flushPromises();
      await wrapper!
        .findAll('.dlg-f button')
        .find((b) => b.text() === 'Get a new code')!
        .trigger('click');
      await flushPromises();
      expect(dialog().attributes('data-phase')).toBe('waiting');
      expect(dialog().text()).toContain('K7QD-P2MX');
    });

    it('expires on screen when the countdown runs out', async () => {
      const { store } = await setup('nous-not-connected,nous-login-expire');
      await store.connect('other');
      await flushPromises();
      expect(dialog().text()).toContain('0:10 left');
      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(dialog().attributes('data-phase')).toBe('expired');
    });

    it('Close after an end state forgets it', async () => {
      const { store } = await setup();
      await store.connect('other');
      await flushPromises();
      store.simulate('decline');
      await flushPromises();
      await wrapper!.find('.dlg-f button').trigger('click');
      expect(store.dialogOpen).toBe(false);
      expect(store.loginPhase).toBe('idle');
    });
  });

  it('shows the fixture controls only when asked (dev + fixtures)', async () => {
    const { store } = await setup();
    await store.connect('other');
    await flushPromises();
    expect(wrapper!.find('[aria-label="Fixture controls, development only"]').exists()).toBe(true);
    await wrapper!.setProps({ devControls: false });
    expect(wrapper!.find('[aria-label="Fixture controls, development only"]').exists()).toBe(false);
  });
});
