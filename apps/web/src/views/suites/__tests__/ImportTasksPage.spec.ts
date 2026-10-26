import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { mountAt, settle, unmountPage } from './mountPage';

beforeEach(() => resetDraftFixtures());
afterEach(() => {
  unmountPage();
  vi.unstubAllGlobals();
});

type Page = Awaited<ReturnType<typeof mountAt>>;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const PATH = '/suites/invoices-v1/import';

async function upload({ w }: Page, name: string, size = 410): Promise<void> {
  const file = new File(['key,question,expected\n'], name, { type: 'text/csv' });
  Object.defineProperty(file, 'size', { value: size });
  const input = w.get<HTMLInputElement>('[data-testid="task-file-input"]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await settle();
}
const next = async ({ w }: Page): Promise<void> => {
  await w.get('[data-testid="next-step"]').trigger('click');
  await settle();
};
const current = ({ w }: Page) => w.get('li[aria-current="step"]').text().replace(/^\d/, '');

describe('ImportTasksPage (SA.9)', () => {
  it('reads a CSV, refuses other files, and maps its columns', async () => {
    const page = await mountAt(PATH);
    const { w } = page;
    expect(flat(w.get('nav[aria-label="Breadcrumb"]').text())).toBe(
      'Suites / invoices-v1 / Import tasks',
    );
    expect(w.get('h1').text()).toBe('Import tasks from CSV or JSONL');
    expect(current(page)).toBe('Upload');
    expect(w.get('[data-testid="next-step"]').attributes('disabled')).toBeDefined();

    await upload(page, 'questions.xlsx');
    const rejected = w.get('[data-testid="task-file-rejected"]');
    expect(rejected.get('span').text()).toBe('Rejected files are not read');
    expect(flat(rejected.get('[role="alert"]').text())).toBe('questions.xlsx: use CSV or JSONL.');
    expect(rejected.get('[role="alert"] code').text()).toBe('questions.xlsx');
    await upload(page, 'all_questions.csv');
    expect(w.get('[data-testid="task-file-rejected"]').text()).toContain(
      'all_questions.csv: 1,240 rows. The limit is 500 per import.',
    );
    await upload(page, 'overdue_questions.csv');
    expect(
      w
        .get('[data-testid="task-file"]')
        .findAll('td')
        .map((td) => flat(td.text())),
    ).toEqual(['overdue_questions.csv', '6', 'key, question, expected', '410 B', 'read']);

    await next(page);
    expect(current(page)).toBe('Map columns');
    expect(
      w.findAll('[data-testid="column-use"]').map((s) => (s.element as HTMLSelectElement).value),
    ).toEqual(['task_key', 'prompt', 'reference_value']);
    // Without a prompt the next step waits.
    await w.findAll('[data-testid="column-use"]')[1]!.setValue('ignore');
    await settle();
    expect(w.get('[data-severity="problem"]').text()).toBe('Map one column to Prompt.');
    expect(w.get('[data-testid="next-step"]').attributes('disabled')).toBeDefined();
    await w.findAll('[data-testid="column-use"]')[1]!.setValue('prompt');
    await settle();
    expect(w.get('[data-testid="next-step"]').attributes('disabled')).toBeUndefined();
  });

  it('shares workspace files, the answer path, a suggested check and the answer paragraph', async () => {
    const page = await mountAt(PATH);
    await upload(page, 'overdue_questions.csv');
    await next(page);
    await next(page);
    const { w } = page;
    expect(current(page)).toBe('Shared settings');
    expect(w.get('[data-testid="new-check"]').text()).toContain('numeric_tolerance');
    expect(w.text()).toContain('New Number within tolerance');
    expect(flat(w.text())).toContain('Each reference becomes { "answer": <expected> }.');
    expect(w.get('[data-testid="instructions-preview"]').text()).toBe(
      'End your reply with your answer as a fenced JSON block, exactly in this shape:\n\n```json\n{ "answer": 0 }\n```',
    );
  });

  it('previews the tasks, takes a key fix inline, then adds them to the draft', async () => {
    const page = await mountAt(PATH);
    await upload(page, 'overdue_questions.csv');
    await next(page);
    await next(page);
    await next(page);
    const { w, router } = page;
    expect(current(page)).toBe('Preview');
    expect(w.findAll('[data-testid="import-preview"] tbody tr')).toHaveLength(6);
    const fixRow = w.get('[data-row="4"]');
    expect(flat(fixRow.text())).toContain(
      'Row 4: key overdue 90 has a space. Use letters, digits, ., _ and -.',
    );
    expect(w.get('[data-testid="fix-line"]').text()).toBe('1 row needs a fix');
    expect(w.get('[data-testid="add-tasks"]').text()).toBe('Add 6 tasks to the draft');
    expect(w.get('[data-testid="add-tasks"]').attributes('disabled')).toBeDefined();

    await fixRow.get('[data-testid="key-fix"]').setValue('overdue_90');
    await fixRow.get('[data-testid="key-fix"]').trigger('change');
    await settle();
    expect(w.find('[data-testid="fix-line"]').exists()).toBe(false);
    expect(w.get('[data-row="4"]').text()).toContain('overdue_90');
    await w.get('[data-testid="add-tasks"]').trigger('click');
    await settle();
    expect(router.currentRoute.value.path).toBe('/suites/invoices-v1/draft');
  });
});
