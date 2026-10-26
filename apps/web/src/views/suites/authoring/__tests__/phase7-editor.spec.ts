/**
 * The task editor's Phase 7 follow-ups on fixtures: "The answer is picked from these files"
 * (self_check.answers_from_fixtures, Phase 5b question 1), an upload refused for its size
 * still reported after a reload (question 11), and a text a zip held at over 1 MiB shown
 * read-only (question 18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { routes } from '@/router';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { TASK_DEBOUNCE_MS } from '@/stores/draftTask';
import { useDraftTaskToolsStore } from '@/stores/draftTaskTools';

/** Lazy pages and debounced writes take longer while every package's tests run at once. */
const LAZY_MS = 10_000;
const TASK = '/suites/invoices-v1/draft/tasks';

async function mountEditor(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  const root = mount(
    { render: () => h(RouterView) },
    { global: { plugins: [createPinia(), router] }, attachTo: document.body },
  );
  await flushPromises();
  await vi.waitFor(() => expect(root.find('[data-testid="task-key"]').exists()).toBe(true), {
    timeout: LAZY_MS,
  });
  await flushPromises();
  return root;
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  useScenario(null);
  resetDraftFixtures();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('answers_from_fixtures', () => {
  it('turns the leak warning off for a task whose answer is in its files', async () => {
    useScenario('task-problems');
    resetDraftFixtures();
    const root = await mountEditor(`${TASK}/total_due`);
    const leak = () => root.get('[data-rule="reference_leak"]');
    expect(leak().attributes('data-status')).toBe('warning');
    const toggle = root.get('[data-testid="answers-from-fixtures"]');
    expect(flat(toggle.text())).toContain('The answer is picked from these files');
    await toggle.get('[role="switch"], input, button').trigger('click');
    await vi.waitFor(() => expect(leak().attributes('data-status')).toBe('passed'), {
      timeout: LAZY_MS + TASK_DEBOUNCE_MS,
    });
    expect(flat(leak().text())).toContain(
      'Not searched: answers_from_fixtures says the answer is picked from the workspace files.',
    );
    // The setting stays on show, so it can be turned off again.
    expect(root.find('[data-testid="answers-from-fixtures"]').exists()).toBe(true);
    root.unmount();
  });

  it('is not offered on a task with no leak warning', async () => {
    const root = await mountEditor(`${TASK}/overdue_count`);
    expect(root.find('[data-testid="answers-from-fixtures"]').exists()).toBe(false);
    root.unmount();
  });
});

describe('an upload refused for its size', () => {
  it('stays a file-limits problem after a reload, and in the drop zone', async () => {
    let root = await mountEditor(`${TASK}/overdue_count`);
    const big = new File(
      [new Uint8Array(AUTHORING_LIMITS.suiteMaxFileBytes + 1024)],
      'ledger-2025.parquet',
    );
    await useDraftTaskToolsStore().upload([{ file: big, path: big.name }], 'fixture');
    await flushPromises();
    const limits = () => root.get('[data-rule="file_limits"]');
    expect(limits().attributes('data-status')).toBe('problem');
    expect(flat(limits().text())).toContain('ledger-2025.parquet is over 25 MB.');
    root.unmount();

    // A new page: nothing remembered in the browser, the API still has it.
    root = await mountEditor(`${TASK}/overdue_count`);
    expect(limits().attributes('data-status')).toBe('problem');
    expect(flat(limits().text())).toContain('ledger-2025.parquet is over 25 MB.');
    const row = root.get('[data-section="workspace"] [data-testid="upload-rejected"]');
    expect(flat(row.text())).toContain(
      'ledger-2025.parquet is over 25 MB. The file was not added.',
    );
    await row.get('button[aria-label="Dismiss ledger-2025.parquet"]').trigger('click');
    await flushPromises();
    expect(root.find('[data-testid="upload-rejected"]').exists()).toBe(false);
    expect(limits().attributes('data-status')).toBe('passed');
    root.unmount();
  });
});

describe('a text too large to edit (task-large-text)', () => {
  it('lists it as a read-only other file on the Files tab', async () => {
    useScenario('task-large-text');
    resetDraftFixtures();
    const root = await mountEditor(`${TASK}/overdue_count?tab=files`);
    const row = root.get('[data-path="rubrics/method.md"]');
    expect(row.get('[data-testid="read-only"]').text()).toBe('read-only');
    expect(flat(row.text())).toContain('too large to edit here · read-only, kept as is');
    expect(row.findAll('button').map((b) => b.text())).toEqual(['Copy path']);
    root.unmount();
  });
});
