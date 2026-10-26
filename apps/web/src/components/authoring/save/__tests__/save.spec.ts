import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { DraftReview, DraftSaveResult, SuiteDraftView } from '@/api/types/authoring';
import { testRoutes } from '@/views/suites/__tests__/mountPage';
import DraftWritesPanel from '../DraftWritesPanel.vue';
import SavePanel from '../SavePanel.vue';
import SaveSteps from '../SaveSteps.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const router = () => createRouter({ history: createMemoryHistory(), routes: testRoutes() });
const FOLDER = './suites/invoices-v1/';

const steps = (w: VueWrapper) =>
  w.findAll('[role="listitem"]').map((r) => [r.attributes('data-state'), flat(r.text())]);

describe('SaveSteps (SA.11)', () => {
  it('ticks the steps done, spins the one running and greys the rest', () => {
    wrapper = mount(SaveSteps, {
      props: {
        state: 'progress',
        step: 'self_checks',
        selfChecks: { done: 1, total: 2 },
        folderPath: FOLDER,
      },
    });
    expect(steps(wrapper)).toEqual([
      ['done', 'Writing files to a staging folder ✓'],
      ['done', 'Loading ✓'],
      ['run', 'Self-checks 1 of 2…'],
      ['wait', 'Moving into ./suites/invoices-v1/'],
    ]);
    expect(wrapper.get('[role="list"]').attributes('aria-live')).toBe('polite');
  });

  it('ticks every step once saved', () => {
    wrapper = mount(SaveSteps, {
      props: { state: 'done', selfChecks: { done: 2, total: 2 }, folderPath: FOLDER },
    });
    expect(steps(wrapper).map((s) => s[1])).toEqual([
      'Writing files to a staging folder ✓',
      'Loading ✓',
      'Self-checks 2 of 2 ✓',
      'Moving into ./suites/invoices-v1/ ✓',
    ]);
  });

  it('marks the failed step with the loader line, and the rest not run', () => {
    wrapper = mount(SaveSteps, {
      props: {
        state: 'failed',
        step: 'loading',
        folderPath: FOLDER,
        failure: '`overdue_count/task.yaml` line 9: unknown key `prmary`',
      },
    });
    expect(steps(wrapper).map(([state]) => state)).toEqual(['done', 'fail', 'wait', 'wait']);
    const failed = wrapper.get('[data-state="fail"]');
    expect(
      failed
        .findAll('span span')
        .map((s) => s.text())
        .filter(Boolean),
    ).toEqual(['Loading']);
    expect(failed.get('code').text()).toBe('overdue_count/task.yaml line 9: unknown key prmary');
    expect(
      steps(wrapper)
        .slice(2)
        .map(([, text]) => text),
    ).toEqual(['Self-checks · not run', 'Moving into ./suites/invoices-v1/ · not run']);
  });
});

const draft = {
  id: 'd1',
  folder: 'invoices-v1',
  path: './suites/invoices-v1',
  name: 'invoices-v1',
  origin: 'edit',
  base: {
    suiteId: 's6',
    name: 'invoices-v1',
    versionNumber: 6,
    versionLabel: '0.3',
    contentHash: 'a'.repeat(64),
  },
  nextVersion: 7,
  versionLabel: '0.4',
  description: null,
  changes: [],
  tasks: [],
  problems: [],
  conflict: null,
  saving: null,
  revision: 3,
  createdAt: '2026-10-23T16:02:00',
  updatedAt: '2026-10-23T16:31:00',
} satisfies SuiteDraftView;

const review = (invalid: boolean): DraftReview => ({
  draft,
  changes: [],
  writes: [],
  readiness: [
    {
      key: 'overdue_count',
      state: 'added',
      readiness: invalid ? 'problems' : 'ready',
      note: invalid ? 'self-check failed' : 'self-check passed · 16:31',
    },
    {
      key: 'total_due',
      state: 'changed',
      readiness: 'ready',
      note: 'reference passes `answer`',
    },
  ],
  invalid: invalid ? [{ key: 'overdue_count', reason: 'self-check failed' }] : [],
});

const result: DraftSaveResult = {
  outcome: 'created',
  suite: { ...draft.base, suiteId: 's7', versionNumber: 7, versionLabel: '0.4' },
  changes: {
    added: ['overdue_count'],
    removed: [],
    changed: ['total_due'],
    nowInvalid: [],
    nowValid: [],
  },
  taskCount: 13,
  validCount: 12,
  invalid: [],
};

const panel = (props: Record<string, unknown>) =>
  mount(SavePanel, {
    props: { folderPath: FOLDER, draftTo: '/suites/invoices-v1/draft', ...props } as never,
    global: { plugins: [router()] },
  });

describe('SavePanel (SA.11)', () => {
  it('reviews readiness across the changed tasks, then Save as v7', () => {
    wrapper = panel({ phase: 'review', review: review(false) });
    expect(wrapper.text()).toContain('2 of 2 changed tasks ready');
    const row = (key: string) => wrapper!.get(`[data-task="${key}"]`);
    expect(row('overdue_count').get('.font-mono').text()).toBe('overdue_count');
    // The state, then the API's note, its backticked key as code (SA.11).
    expect(row('overdue_count').get('[data-testid="readiness-note"]').text()).toBe(
      'added · self-check passed · 16:31',
    );
    const note = row('total_due').get('[data-testid="readiness-note"]');
    expect(note.text()).toBe('changed · reference passes answer');
    expect(note.get('code').text()).toBe('answer');
    expect(wrapper.get('[data-testid="save-draft"]').text()).toBe('Save as v7');
    expect(wrapper.text()).toContain(
      'Writes the files, loads them and runs the self-checks, exactly as a reload does. Creates v7. Experiments on v6 keep v6.',
    );
  });

  it('asks before saving a task as invalid', async () => {
    wrapper = panel({ phase: 'confirm', review: review(true) });
    expect(wrapper.text()).toContain('1 of 2 changed tasks ready');
    expect(flat(wrapper.text())).toContain(
      "1 task will be saved as invalid and can't be launched: overdue_count (self-check failed).",
    );
    const confirm = wrapper.get('[data-testid="confirm-invalid"]');
    expect(confirm.text()).toContain('Save with 1 invalid task?');
    expect(confirm.text()).toContain(
      'It is stored as invalid, exactly as a broken file on disk would be. Fix it later and save again.',
    );
    const [save, keep] = confirm.findAll('button');
    expect([save!.text(), keep!.text()]).toEqual(['Save with 1 invalid task', 'Keep editing']);
    await save!.trigger('click');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    await keep!.trigger('click');
    expect(wrapper.emitted('keepEditing')).toHaveLength(1);
  });

  it('reports the version created, with Open suite and New experiment on it', () => {
    wrapper = panel({
      phase: 'created',
      review: review(false),
      result,
      suiteTo: '/suites/s7',
      experimentTo: '/experiments/new?suite=s7',
    });
    const status = wrapper.get('[data-testid="save-created"]');
    expect(status.get('b').text()).toBe('v7 saved');
    expect(flat(status.findAll('span')[0]!.text())).toBe(
      '1 added: overdue_count · 1 changed: total_due · 13 tasks, 12 valid',
    );
    const links = wrapper.findAll('a');
    expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['Open suite', '/suites/s7'],
      ['New experiment on v7', '/experiments/new?suite=s7'],
    ]);
    expect(wrapper.text()).toContain(
      'The draft is gone. Suite detail shows v7, and its History has a new row.',
    );
  });

  it('says when nothing changed, when the loader refused the folder, and when no worker runs', async () => {
    wrapper = panel({
      phase: 'nochanges',
      review: review(false),
      result: { ...result, outcome: 'unchanged', suite: draft.base },
    });
    const unchanged = wrapper.get('[data-testid="save-unchanged"]');
    expect(flat(unchanged.get('b').text())).toBe('Nothing changed. invoices-v1 stays at v6.');
    expect(unchanged.get('.text-text-2').text()).toBe('The draft is cleared.');
    await wrapper.setProps({
      phase: 'notsaved',
      failure: {
        step: 'loading',
        message: '`overdue_count/task.yaml` line 9: unknown key `prmary`',
      },
    });
    expect(flat(wrapper.get('[data-testid="save-failed"]').text())).toBe(
      'Not saved. overdue_count/task.yaml line 9: unknown key prmary. Nothing on disk changed. Your draft is kept.',
    );
    expect(wrapper.get('a.btn.primary').text()).toBe('Back to the draft');
    await wrapper.setProps({ phase: 'offline' });
    expect(flat(wrapper.get('[data-testid="save-offline"]').text())).toBe(
      'No worker is running. Saving needs the worker. Your draft is kept.',
    );
    expect(wrapper.get('[data-testid="copy-command"]').text()).toContain(
      'docker compose up -d worker',
    );
  });
});

describe('DraftWritesPanel (SA.11)', () => {
  it('lists each file written with its size, and counts them', () => {
    wrapper = mount(DraftWritesPanel, {
      props: {
        folderPath: FOLDER,
        writes: [
          {
            op: 'add',
            path: `${FOLDER}overdue_count/prompt.md`,
            beforeBytes: null,
            afterBytes: 346,
            note: null,
          },
          {
            op: 'change',
            path: `${FOLDER}total_due/prompt.md`,
            beforeBytes: 412,
            afterBytes: 470,
            note: null,
          },
          {
            op: 'change',
            path: `${FOLDER}suite.yaml`,
            beforeBytes: 180,
            afterBytes: 201,
            note: 'version_label 0.3 → 0.4 · tasks + overdue_count',
          },
        ],
      },
    });
    expect(flat(wrapper.get('[data-testid="writes-caption"]').text())).toBe(
      'Writes 3 files to ./suites/invoices-v1/ and removes nothing.',
    );
    expect(
      wrapper.findAll('tbody tr').map((r) => r.findAll('td').map((td) => flat(td.text()))),
    ).toEqual([
      ['+', './suites/invoices-v1/overdue_count/prompt.md', '346 B'],
      ['~', './suites/invoices-v1/total_due/prompt.md', '412 B → 470 B'],
      ['~', './suites/invoices-v1/suite.yaml', 'version_label 0.3 → 0.4 · tasks + overdue_count'],
    ]);
  });
});
