/**
 * SuiteDraftBar in its states (plan 12.4: the conflict states; Components 5): normal with
 * three chips, many changes collapsed to "+N more", the discard confirm, a conflict with and
 * without overlap, combined, a new suite blocked until it has a task; the draft's task table
 * with change, readiness, version on save and a removed row with Undo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { draftView } from '@/api/drafts-fixture-views';
import { draftWorld, resetDraftFixtures } from '@/api/drafts-fixtures';
import { setScenario } from '@/api/__tests__/scenario';
import type { SuiteDraftView } from '@/api/types/authoring';
import DraftTaskTable from '../DraftTaskTable.vue';
import SuiteDraftBar from '../SuiteDraftBar.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:any(.*)', component: { template: '<div />' } }],
});

function sample(scenario: string | null, folder = 'invoices-v1'): SuiteDraftView {
  setScenario(scenario);
  resetDraftFixtures();
  return draftView(draftWorld().get(folder)!);
}

const bar = (draft: SuiteDraftView, props: Record<string, unknown> = {}) =>
  mount(SuiteDraftBar, {
    props: { draft, reviewTo: '/suites/invoices-v1/save', ...props },
    global: { plugins: [router] },
    attachTo: document.body,
  });

beforeEach(() => setScenario(null));

describe('SuiteDraftBar', () => {
  it('says what the draft is based on, its changes and Review and save as the next version', () => {
    const w = bar(sample(null));
    expect(w.get('[data-testid="draft-meta"]').text()).toBe(
      'based on v1 · 3 changes · saved 16:31',
    );
    expect(w.findAll('[data-testid="change-chip"]').map((c) => c.text())).toEqual([
      'added overdue_count',
      'changed total_due',
      'label 0.1 → 0.2',
    ]);
    expect(w.get('[data-testid="review-save"]').text()).toBe('Review and save as v2');
    expect(w.get('[data-testid="review-save"]').attributes('href')).toBe(
      '/suites/invoices-v1/save',
    );
    w.unmount();
  });

  it('reads saving while a write is on its way', () => {
    const w = bar(sample(null), { saving: true });
    expect(w.get('[data-testid="draft-meta"]').text()).toBe('based on v1 · 3 changes · saving…');
    w.unmount();
  });

  it('collapses more than three changes to "+N more"', async () => {
    const w = bar(sample('draft-removed'));
    expect(w.findAll('[data-testid="change-chip"]')).toHaveLength(2);
    const more = w.get('button[title]');
    expect(more.text()).toBe('+2 more');
    expect(more.attributes('title')).toBe('removed currency_mix · label 0.1 → 0.2');
    await more.trigger('click');
    expect(w.findAll('[data-testid="change-chip"]')).toHaveLength(4);
    w.unmount();
  });

  it('asks before discarding, and nothing on disk changes', async () => {
    const w = bar(sample(null));
    await w
      .findAll('button')
      .find((b) => b.text() === 'Discard draft')!
      .trigger('click');
    const confirm = w.get('[role="alertdialog"]');
    expect(confirm.text()).toContain('Discard 3 changes? Nothing on disk changes.');
    expect(document.activeElement?.textContent).toBe('Keep editing');
    await confirm
      .findAll('button')
      .find((b) => b.text() === 'Discard')!
      .trigger('click');
    expect(w.emitted('discard')).toHaveLength(1);
    w.unmount();
  });

  it('turns amber when the folder moved on, and offers Combine', async () => {
    const w = bar(sample('draft-conflict'));
    expect(w.attributes('data-state')).toBe('conflict');
    expect(w.text()).toContain('./suites/invoices-v1 changed on disk after this draft began.');
    expect(w.text()).toContain('created v2 (late_fees now invalid). Your draft is based on v1.');
    expect(w.get('[data-testid="conflict-overlap"]').text()).toBe(
      "Your changes (overdue_count, total_due) don't touch late_fees. They can be combined.",
    );
    expect(w.find('[data-testid="review-save"]').exists()).toBe(false);
    await w.get('[data-testid="combine"]').trigger('click');
    expect(w.emitted('combine')).toHaveLength(1);
    w.unmount();
  });

  it('waits for a choice per overlapping task before combining', async () => {
    const draft = sample('draft-conflict-overlap');
    const w = bar(draft);
    expect(w.attributes('data-state')).toBe('conflict-overlap');
    expect(w.get('[data-testid="conflict-overlap"]').text()).toBe(
      'Both changed total_due. Choose which version to keep below, then combine.',
    );
    expect(w.get('[data-testid="combine"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="combine"]').attributes('title')).toBe(
      'Choose a version for total_due first.',
    );
    await w.setProps({ choices: { total_due: 'mine' } });
    expect(w.get('[data-testid="conflict-overlap"]').text()).toBe(
      'Both changed total_due. You chose a version for it, so the draft can be combined.',
    );
    expect(w.get('[data-testid="combine"]').attributes('disabled')).toBeUndefined();
    w.unmount();
  });

  it('reads based on the newer version once combined', () => {
    const draft = sample(null);
    const combined = { ...draft, base: { ...draft.base!, versionNumber: 7 }, nextVersion: 8 };
    const w = bar(combined);
    expect(w.get('[data-testid="draft-meta"]').text()).toBe(
      'based on v7 · 3 changes · saved 16:31',
    );
    expect(w.get('[data-testid="review-save"]').text()).toBe('Review and save as v8');
    w.unmount();
  });

  it('blocks Review and save of a new suite until it has a task', () => {
    const w = bar(sample('draft-new-suite', 'vendor-statements-v1'));
    expect(w.get('[data-testid="draft-meta"]').text()).toBe(
      'new suite · not saved yet · saved 16:05',
    );
    expect(w.text()).toContain('No tasks yet');
    expect(w.get('[data-testid="review-save"]').attributes('aria-disabled')).toBe('true');
    expect(w.get('[data-testid="review-blocked"]').text()).toBe(
      'Add at least one task to save v1.',
    );
    w.unmount();
  });
});

describe('DraftTaskTable', () => {
  it('shows each task with its change, readiness and version on save, and a removed row with Undo', async () => {
    const draft = sample('draft-removed');
    const w = mount(DraftTaskTable, {
      props: {
        rows: draft.tasks,
        path: draft.path,
        baseVersion: 1,
        editTo: (k: string) => `/edit/${k}`,
      },
      global: { plugins: [router] },
    });
    const row = (key: string) => w.get(`tr[data-key="${key}"]`);
    expect(row('overdue_count').text()).toContain('added');
    expect(row('overdue_count').text()).toContain('new · v1 on save');
    expect(row('total_due').text()).toContain('v1 → v2 on save');
    expect(row('total_due').get('[data-testid="row-readiness"]').text()).toBe('ready');
    expect(row('currency_mix').attributes('data-state')).toBe('removed');
    expect(w.text()).toContain(
      'Removes ./suites/invoices-v1/currency_mix/ when you save. v1 and earlier keep it, and History can restore it.',
    );
    await row('currency_mix')
      .findAll('button')
      .find((b) => b.text() === 'Undo')!
      .trigger('click');
    expect(w.emitted('undo')?.[0]).toEqual(['currency_mix']);
  });

  it('moves a row with the arrow keys on its handle', async () => {
    const draft = sample(null);
    const w = mount(DraftTaskTable, {
      props: {
        rows: draft.tasks,
        path: draft.path,
        baseVersion: 1,
        editTo: (k: string) => `/edit/${k}`,
      },
      global: { plugins: [router] },
    });
    await w.get('tr[data-key="overdue_list"] button').trigger('keydown', { key: 'ArrowUp' });
    const [order] = w.emitted('reorder')![0] as [string[]];
    expect(order.slice(0, 2)).toEqual(['overdue_list', 'total_due']);
  });
});
