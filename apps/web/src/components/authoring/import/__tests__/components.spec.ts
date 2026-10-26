import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { TaskTableColumn } from '@/api/types/authoring';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { testRoutes } from '@/views/suites/__tests__/mountPage';
import ColumnMapper from '../ColumnMapper.vue';
import type { ColumnMapping } from '../columnMapping';
import ImportSuiteDialog from '../ImportSuiteDialog.vue';

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  useScenario(null);
  resetDraftFixtures();
  setActivePinia(createPinia());
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const columns: TaskTableColumn[] = [
  { name: 'key', samples: ['overdue_fjord', 'overdue_granite', 'overdue_over_5000'] },
  { name: 'question', samples: ['How many overdue invoices does Fjord Software have?'] },
  { name: 'expected', samples: ['3', '2', '6'] },
];
const map = (...uses: ColumnMapping['use'][]): ColumnMapping[] =>
  columns.map((c, i) => ({ column: c.name, use: uses[i]! }));
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('ColumnMapper (SA.9 step 2)', () => {
  it('draws each column with its samples, its use and where it goes', () => {
    wrapper = mount(ColumnMapper, {
      props: { columns, mapping: map('task_key', 'prompt', 'reference_value'), keyPrefix: '' },
    });
    const rows = wrapper.findAll('tbody tr');
    expect(rows.map((r) => r.attributes('data-column'))).toEqual(['key', 'question', 'expected']);
    expect(rows[0]!.findAll('td')[1]!.findAll('span')).toHaveLength(3);
    expect(rows[1]!.get('[data-zone="visible"]').text()).toBe('Agent sees · prompt.md');
    expect(rows[2]!.get('[data-zone="hidden"]').text()).toBe('Hidden · checks only');
    expect(flat(rows[0]!.findAll('td')[3]!.text())).toBe('Platform metadata');
    expect(wrapper.find('[data-testid="key-prefix"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="mapping-messages"]').text()).toBe(
      'No column is mapped to Summary. Summaries are taken from the first 80 characters of each prompt.',
    );
  });

  it('outlines the column at fault and says what is missing (question set to Ignore)', () => {
    wrapper = mount(ColumnMapper, {
      props: { columns, mapping: map('task_key', 'ignore', 'reference_value'), keyPrefix: '' },
    });
    const selects = wrapper.findAll('select');
    expect(selects.map((s) => s.attributes('aria-invalid'))).toEqual(['false', 'true', 'false']);
    const problem = wrapper.get('[data-severity="problem"]');
    expect(problem.text()).toBe('Map one column to Prompt.');
    expect(problem.attributes('role')).toBe('alert');
  });

  it('asks for a key prefix when no column is the Task key, and changes a use', async () => {
    wrapper = mount(ColumnMapper, {
      props: {
        columns,
        mapping: map('ignore', 'prompt', 'reference_value'),
        keyPrefix: 'overdue_q',
        'onUpdate:mapping': (m: ColumnMapping[]) => wrapper!.setProps({ mapping: m }),
      },
    });
    expect(flat(wrapper.get('[data-testid="key-prefix"]').text())).toContain(
      'No column is mapped to Task key, so keys are generated: overdue_q01, overdue_q02, …',
    );
    await wrapper.findAll('select')[0]!.setValue('task_key');
    await nextTick();
    expect(wrapper.find('[data-testid="key-prefix"]').exists()).toBe(false);
  });
});

async function mountDialog() {
  const router = createRouter({ history: createMemoryHistory(), routes: testRoutes() });
  await router.push('/suites');
  wrapper = mount(ImportSuiteDialog, {
    props: { open: true },
    global: { plugins: [router] },
    attachTo: document.body,
  });
  await flushPromises();
  return router;
}

async function drop(name: string, size = 26_000): Promise<void> {
  const file = new File(['x'], name, { type: 'application/zip' });
  Object.defineProperty(file, 'size', { value: size });
  const input = document.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await flushPromises();
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const cellsOf = (selector: string) => [...q(selector)!.children].map((c) => flat(c.textContent!));

describe('ImportSuiteDialog (SA.10)', () => {
  it('reads a zip without scripts: valid, its task, no code panel, Import as a draft', async () => {
    const router = await mountDialog();
    expect(q('[data-testid="step-label"]')!.textContent).toBe('Step 1 of 2 · choose file');
    await drop('vendor-statements-v1.zip');
    expect(q('[data-testid="step-label"]')!.textContent).toBe('Step 2 of 2 · review');
    expect(q('[data-testid="zip-chip"]')!.textContent).toBe('valid');
    expect(cellsOf('[data-testid="zip-summary"]')).toEqual([
      'Suite name',
      'vendor-statements-v1',
      'Label',
      '0.1',
      'Tasks',
      '1 · 1 valid',
    ]);
    expect(flat(q('[data-testid="zip-tasks"]')!.textContent!)).toBe(
      'unmatched_lines · valid · 2 workspace files · 1 check',
    );
    expect(q('[data-testid="zip-scripts"]')).toBeNull();
    const importButton = q('[data-testid="zip-import"]')!;
    expect(importButton.getAttribute('aria-disabled')).toBeNull();
    importButton.click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/suites/vendor-statements-v1/draft');
  });

  it('shows a taken name first, then the code panel, and waits for the trust tick', async () => {
    await mountDialog();
    await drop('invoices-v1-v6.zip', 68_400);
    expect(q('[data-testid="zip-name-taken"]')!.textContent).toBe('invoices-v1 already exists.');
    expect(q<HTMLInputElement>('[data-testid="zip-new-name"]')!.value).toBe('invoices-v1-copy');
    q('[data-testid="zip-continue"]')!.click();
    await flushPromises();
    expect(flat(q('[data-testid="zip-summary"]')!.textContent!)).toContain(
      'invoices-v1-copy (renamed from invoices-v1)',
    );
    expect(q('[data-testid="zip-chip"]')!.textContent).toBe('1 invalid task');
    const panel = q('[data-testid="zip-scripts"]')!;
    expect(panel.getAttribute('aria-label')).toBe('This suite contains code');
    expect(panel.textContent).toContain(
      '2 verifier scripts will run in the worker when the suite is checked and when runs are scored. Import only suites you trust.',
    );
    const scripts = [...document.querySelectorAll('[data-testid="zip-script"]')].map((s) =>
      [...s.children].map((c) => flat(c.textContent!)),
    );
    expect(scripts).toEqual([
      ['late_fees/verify/check_late_fees.py', '2.4 KB', 'e81f0c2'],
      ['summary_file/verify/check_summary.py', '1.2 KB', '9b14e0d'],
    ]);
    const importButton = q('[data-testid="zip-import"]')!;
    expect(importButton.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(importButton.getAttribute('aria-describedby')!)!.textContent,
    ).toBe('Confirm the verifier scripts first.');
    const tick = q<HTMLInputElement>('[data-testid="trust-scripts"]')!;
    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    await flushPromises();
    expect(q('[data-testid="zip-import"]')!.getAttribute('aria-disabled')).toBeNull();
    expect(q('[data-task="late_fees"]')!.getAttribute('data-readiness')).toBe('problems');
  });

  it('refuses a name that is taken or not a folder name', async () => {
    await mountDialog();
    await drop('invoices-v1-v6.zip');
    const input = q<HTMLInputElement>('[data-testid="zip-new-name"]')!;
    input.value = 'Invoices v2';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(q('[data-testid="zip-continue"]')!.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain(
      'Use letters, digits, ., _ and -, starting with a letter or digit.',
    );
  });

  it('draws each rejection with what to do, and Choose another file', async () => {
    await mountDialog();
    await drop('with-link.zip');
    const alert = q('[data-testid="zip-rejected"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(flat(alert.querySelector('b')!.textContent!)).toBe(
      'The zip has a symbolic link at total_due/fixtures/data.csv. Links are not allowed.',
    );
    expect(flat(alert.querySelector('.text-text-2')!.textContent!)).toBe(
      'Replace the link with the file itself, then zip the folder again.',
    );
    expect(alert.querySelector('code')!.textContent).toBe('total_due/fixtures/data.csv');
    const footer = q('[data-testid="dialog-footer"]')!;
    expect(flat(footer.textContent!)).toBe('Choose another file');
    footer.querySelector('button')!.click();
    await flushPromises();
    expect(q('[data-testid="step-label"]')!.textContent).toBe('Step 1 of 2 · choose file');
  });

  it('refuses a zip over 100 MB before sending it', async () => {
    await mountDialog();
    await drop('huge.zip', 101 * 1024 * 1024);
    expect(q('[data-testid="zip-rejected"]')!.textContent).toContain('is over the 100 MB limit.');
  });
});
