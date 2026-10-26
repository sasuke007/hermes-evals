/**
 * The task editor (SA.4 to SA.8, SA.13) on fixtures: the Form tab's sections and panel, the
 * form and task.yaml tabs staying in sync and the form locking while task.yaml has an error
 * (plan 12.4), a Fix link going to its field, the Files tab, a rename the address follows,
 * leaving during an upload, and the loading and error states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { routes } from '@/router';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { TASK_DEBOUNCE_MS } from '@/stores/draftTask';
import { useDraftTaskToolsStore } from '@/stores/draftTaskTools';

/** Lazy pages and debounced writes take longer while every package's tests run at once. */
const LAZY_MS = 10_000;

async function mountEditor(path = '/suites/invoices-v1/draft/tasks/overdue_count') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes,
  });
  await router.push(path);
  const root = mount(
    { render: () => h(RouterView) },
    { global: { plugins: [createPinia(), router] }, attachTo: document.body },
  );
  await flushPromises();
  await vi.waitFor(
    () =>
      expect(
        root
          .find('[data-testid="task-key"], [data-testid="task-loading"], [role="alert"]')
          .exists(),
      ).toBe(true),
    { timeout: LAZY_MS },
  );
  await flushPromises();
  return { root, router };
}

const tab = (root: ReturnType<typeof mount>, label: string) =>
  root.findAll('nav[aria-label="Task views"] button').find((b) => b.text() === label)!;

beforeEach(() => {
  useScenario(null);
  resetDraftFixtures();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('TaskEditorPage', () => {
  it('draws the Form tab: head, sections and the readiness panel', async () => {
    const { root } = await mountEditor();
    expect(root.get('[data-testid="task-key"]').text()).toBe('overdue_count');
    expect(root.get('[data-testid="task-change"]').text()).toBe('added');
    expect(root.get('[data-testid="save-line"]').text()).toBe('draft · saved 16:31');
    expect(root.findAll('[data-section]').map((s) => s.attributes('data-section'))).toEqual([
      'task',
      'prompt',
      'workspace',
      'answer',
      'reference',
      'checks',
      'limits',
    ]);
    expect(root.get('[data-section="prompt"]').text()).toContain('Visible to the agent');
    expect(root.get('[data-section="reference"]').text()).toContain('Hidden from the agent');
    expect(root.get('[data-testid="readiness-head"]').text()).toContain('Ready to save');
    expect(root.get('[data-testid="mentioned-files"]').text()).toContain('invoices.csv');
    expect(root.get('[data-testid="reference-values"]').text()).toContain(
      'answer reads overdue_count → 17',
    );
    root.unmount();
  });

  it('keeps the form and task.yaml in step', async () => {
    const { root, router } = await mountEditor();
    await root.get('#te-sum').setValue('Count overdue invoices');
    expect(root.get('[data-testid="save-line"]').text()).toBe('draft · saving…');
    await tab(root, 'task.yaml').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query.tab).toBe('yaml'), {
      timeout: LAZY_MS,
    });
    await flushPromises();
    const yaml = root.get('[data-testid="yaml-editor"] textarea');
    expect((yaml.element as HTMLTextAreaElement).value).toContain(
      'summary: Count overdue invoices',
    );
    await yaml.setValue(
      (yaml.element as HTMLTextAreaElement).value.replace('max_turns: 20', 'max_turns: 40'),
    );
    await tab(root, 'Form').trigger('click');
    await vi.waitFor(
      () => expect((root.get('#te-turns').element as HTMLInputElement).value).toBe('40'),
      { timeout: LAZY_MS },
    );
    root.unmount();
  });

  it('locks the form while task.yaml has an error and leads to the task.yaml tab', async () => {
    useScenario('task-yaml-error');
    resetDraftFixtures();
    const { root, router } = await mountEditor();
    const lock = root.get('[data-testid="form-lock"]');
    expect(lock.text()).toContain('task.yaml has an error on line 10.');
    expect(lock.text()).toContain('Fix it in the task.yaml tab to keep editing in the form.');
    expect(root.get('[data-testid="form-sections"]').attributes('inert')).toBeDefined();
    expect(root.get('#te-sum').attributes('readonly')).toBeDefined();
    expect(root.get('[data-rule="task_yaml"]').text()).toContain('unknown key prmary');
    await lock.get('button').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query.tab).toBe('yaml'), {
      timeout: LAZY_MS,
    });
    await flushPromises();
    expect(root.get('[data-testid="yaml-error"]').text()).toContain('Did you mean primary?');
    await root.get('[data-testid="yaml-error"] button').trigger('click');
    await vi.waitFor(
      () => expect(root.get('[data-testid="yaml-status"]').text()).toBe('valid · written as shown'),
      { timeout: LAZY_MS },
    );
    root.unmount();
  });

  it('marks both primary lines while task.yaml marks two checks primary', async () => {
    const { root } = await mountEditor('/suites/invoices-v1/draft/tasks/overdue_count?tab=yaml');
    const yaml = root.get('[data-testid="yaml-editor"] textarea');
    const text = (yaml.element as HTMLTextAreaElement).value;
    const twice = `${text.trimEnd()}\n  - key: second\n    type: exact_match\n    primary: true\n`;
    await yaml.setValue(twice);
    const lines = twice
      .split('\n')
      .flatMap((line, i) => (/primary: true/.test(line) ? [String(i + 1)] : []));
    expect(lines).toHaveLength(2);
    await vi.waitFor(
      () =>
        expect(
          root
            .findAll('[data-testid="yaml-editor"] [data-marked]')
            .map((l) => l.attributes('data-line')),
        ).toEqual(lines),
      { timeout: LAZY_MS },
    );
    expect(root.get('[data-testid="yaml-error"]').text()).toContain(
      'a second check is marked primary. Mark exactly one check as primary.',
    );
    root.unmount();
  });

  it('shows problems where they arise, and Fix goes to the field', async () => {
    useScenario('task-problems');
    resetDraftFixtures();
    const { root } = await mountEditor();
    expect(root.get('[data-testid="readiness-head"]').text()).toMatch(
      /2 problems\s*·\s*2 warnings/,
    );
    expect(root.get('[data-testid="no-answer-block"]').text()).toContain(
      "The prompt doesn't ask for a fenced json block.",
    );
    expect(root.get('[data-testid="mentioned-files"]').text()).toContain(
      'ledger.csv: not in workspace files',
    );
    expect(root.get('[data-section="reference"]').text()).toContain(
      'answer reads overdue → no value.',
    );
    expect(root.get('[data-testid="section-index"]').findAll('[data-mark]').length).toBeGreaterThan(
      0,
    );
    await root.get('[data-rule="reference_paths"] button').trigger('click');
    await flushPromises();
    expect(document.activeElement?.id).toBe('te-path');
    await root.get('[data-testid="no-answer-block"] button').trigger('click');
    expect((root.get('textarea#te-prompt').element as HTMLTextAreaElement).value).toContain(
      'End your reply with your answer as a fenced JSON block, exactly in this shape:',
    );
    // Let the debounced write land here, not in the fixture world of the next test.
    await vi.waitFor(
      () => expect(root.get('[data-testid="save-line"]').text()).toMatch(/^draft · saved /),
      { timeout: LAZY_MS },
    );
    root.unmount();
  });

  it('says what each check reads when no answer check reads the reference', async () => {
    const { root } = await mountEditor('/suites/invoices-v1/draft/tasks/summary_file');
    expect(root.get('[data-testid="reference-values"]').text()).toContain(
      'No answer check reads the reference. summary reads the workspace; answer (verifier script) gets the answer and the workspace.',
    );
    root.unmount();
  });

  it('lists the whole folder on the Files tab', async () => {
    const { root } = await mountEditor('/suites/invoices-v1/draft/tasks/summary_file?tab=files');
    const folder = root.get('[data-testid="task-folder"]');
    expect(folder.text()).toContain('verify/check_summary.py');
    expect(folder.text()).toContain('expected/summary.csv');
    expect(root.get('[data-testid="readiness-head"]').text()).toContain(
      'Self-check not run since your last change',
    );
    root.unmount();
  });

  it('moves the address to the new key after a rename', async () => {
    // Real timers: the write goes out once TASK_DEBOUNCE_MS has passed.
    const { root, router } = await mountEditor();
    await root.get('#te-key').setValue('overdue_total');
    await vi.waitFor(() => expect(router.currentRoute.value.params.key).toBe('overdue_total'), {
      timeout: LAZY_MS + TASK_DEBOUNCE_MS,
    });
    expect(root.get('[data-testid="task-key"]').text()).toBe('overdue_total');
    root.unmount();
  });

  it('asks before leaving while an upload runs', async () => {
    const { root, router } = await mountEditor();
    const tools = useDraftTaskToolsStore();
    tools.uploads.push({
      id: 1,
      name: 'invoices-2025.csv',
      target: '/workspace/invoices-2025.csv',
      kind: 'fixture',
      loaded: 11_500_000,
      total: 18_600_000,
      controller: new AbortController(),
    });
    await root
      .findAll('a')
      .find((a) => a.text() === 'Back to suite')!
      .trigger('click');
    await flushPromises();
    const ask = root.get('[data-testid="leave-during-upload"]');
    expect(ask.text()).toContain('1 upload is still running. Leave anyway?');
    expect(ask.text()).toContain(
      "invoices-2025.csv won't be added. Everything else in the draft is kept.",
    );
    expect(router.currentRoute.value.name).toBe('draft-task');
    tools.uploads.splice(0);
    await ask
      .findAll('button')
      .find((b) => b.text() === 'Leave anyway')!
      .trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('suite-draft'), {
      timeout: LAZY_MS,
    });
    root.unmount();
  });

  it('keeps its layout while loading and says the draft is kept when loading fails', async () => {
    useScenario('loading');
    const loading = await mountEditor();
    expect(loading.root.find('[data-testid="task-loading"]').exists()).toBe(true);
    loading.root.unmount();
    useScenario('error');
    const failed = await mountEditor();
    expect(failed.root.text()).toContain('Could not load overdue_count');
    expect(failed.root.text()).toContain(
      'GET /api/suites/invoices-v1/draft/tasks/overdue_count → 502',
    );
    expect(failed.root.text()).toContain('Retry loads it again.');
    failed.root.unmount();
  });
});
