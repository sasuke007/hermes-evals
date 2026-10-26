import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { SUITE_DESCRIPTION, SUITE_V1_ID, SUITE_V2_ID } from '@/fixtures/suites';
import { mountAt, settle, unmountPage } from './mountPage';

beforeEach(() => resetDraftFixtures());
afterEach(() => {
  unmountPage();
  vi.unstubAllGlobals();
});

type Page = Awaited<ReturnType<typeof mountAt>>;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const path = ({ router }: Page) => router.currentRoute.value.fullPath;

async function pickMenu({ w }: Page, trigger: string, item: string): Promise<void> {
  await w.get(trigger).trigger('click');
  await settle();
  await w.get(`[data-testid="action-menu"] [data-item="${item}"]`).trigger('click');
  await settle();
}

describe('Suite detail: authoring entry points (SA.1, SA.3)', () => {
  it('shows the description, Download .zip of the version on screen, and the draft chip', async () => {
    const page = await mountAt(`/suites/${SUITE_V1_ID}`);
    const { w } = page;
    expect(w.get('[data-testid="suite-description"]').text()).toBe(SUITE_DESCRIPTION);
    const zip = w.get('[data-testid="download-zip"]');
    expect(zip.attributes('href')).toBe('/api/suites/invoices-v1/versions/1/zip');
    expect(zip.attributes('download')).toBe('invoices-v1-v1.zip');
    expect(zip.attributes('title')).toBe(
      'Downloads invoices-v1-v1.zip, the files of the version on screen',
    );
    expect(w.get('[data-testid="draft-chip"]').attributes('href')).toBe(
      '/suites/invoices-v1/draft',
    );
  });

  it('adds a blank task through the draft, opening the editor', async () => {
    const page = await mountAt(`/suites/${SUITE_V1_ID}`);
    await pickMenu(page, '[data-testid="add-task"] button', 'blank');
    expect(path(page)).toMatch(/^\/suites\/invoices-v1\/draft\/tasks\/.+/);
  });

  it('imports tasks into the draft, and opens Edit details on it', async () => {
    const page = await mountAt(`/suites/${SUITE_V1_ID}`);
    await pickMenu(page, '[data-testid="add-task"] button', 'import');
    // The import page loads lazily: wait for the navigation to land (longer when every
    // package's tests run at once).
    await vi.waitFor(() => expect(path(page)).toBe('/suites/invoices-v1/import'), {
      timeout: 10_000,
    });
    const again = await mountAt(`/suites/${SUITE_V1_ID}`);
    await again.w.get('[data-testid="edit-details"]').trigger('click');
    await settle();
    expect(path(again)).toBe('/suites/invoices-v1/draft?details=1');
  });

  it('edits, duplicates or removes a task from its row; any of them starts the draft', async () => {
    const page = await mountAt(`/suites/${SUITE_V1_ID}`);
    const row = page.w.get('tr[data-task="total_due"]');
    expect(flat(row.get('[data-testid="row-actions"]').text())).toBe('Edit');
    await row.get('[data-testid="row-actions"] button').trigger('click');
    await settle();
    expect(path(page)).toBe('/suites/invoices-v1/draft/tasks/total_due');

    const menu = await mountAt(`/suites/${SUITE_V1_ID}`);
    await menu.w
      .get('tr[data-task="vat_split"] button[aria-label="More actions for vat_split"]')
      .trigger('click');
    const items = menu.w.get('[data-testid="action-menu"]').findAll('[role="menuitem"]');
    expect(items.map((i) => i.text())).toEqual(['Edit', 'Duplicate', 'Remove from suite']);
    expect(menu.w.get('[data-testid="action-menu"] span').text()).toBe(
      'Any of these starts a draft. Nothing on disk changes until you save.',
    );
    await menu.w.get('[data-testid="action-menu"] [data-item="remove"]').trigger('click');
    await settle();
    expect(path(menu)).toBe('/suites/invoices-v1/draft');
  });

  it('edits a task that failed its self-check from its expanded row', async () => {
    const page = await mountAt(`/suites/${SUITE_V2_ID}`, 'invalid-task');
    await page.w.get('[data-testid="failure-edit"]').trigger('click');
    await settle();
    expect(path(page)).toBe('/suites/invoices-v1/draft/tasks/late_fees');
  });

  it('offers no editing on an older version, which can still be downloaded', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V2_ID}`, 'reverted');
    expect(w.find('[data-testid="add-task"]').exists()).toBe(false);
    expect(w.find('[data-testid="edit-details"]').exists()).toBe(false);
    expect(w.find('[data-testid="row-actions"]').exists()).toBe(false);
    expect(w.get('[data-testid="download-zip"]').attributes('download')).toBe('invoices-v1-v2.zip');
  });
});

describe('Task detail: authoring entry points', () => {
  it('edits or duplicates the current version through the draft', async () => {
    const page = await mountAt(`/suites/${SUITE_V1_ID}/tasks/dup_invoices`);
    await page.w.get('[data-testid="edit-task"]').trigger('click');
    await settle();
    expect(path(page)).toBe('/suites/invoices-v1/draft/tasks/dup_invoices');
    const copy = await mountAt(`/suites/${SUITE_V1_ID}/tasks/dup_invoices`);
    await copy.w.get('[data-testid="duplicate-task"]').trigger('click');
    await settle();
    expect(path(copy)).toMatch(/^\/suites\/invoices-v1\/draft\/tasks\/dup_invoices.+/);
  });

  it('restores an older version into the draft', async () => {
    const page = await mountAt(`/suites/${SUITE_V1_ID}/tasks/total_due`, 'newer-version');
    const { w } = page;
    expect(w.find('[data-testid="edit-task"]').exists()).toBe(false);
    expect(flat(w.get('[data-testid="old-task-version"]').text())).toContain(
      "Versions don't change. Restoring copies v1's files into the suite's draft, where you can review them before saving.",
    );
    await w.get('[data-testid="restore-task"]').trigger('click');
    await settle();
    expect(path(page)).toBe('/suites/invoices-v1/draft');
  });

  it('names the version each experiment ran when the task has several', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V2_ID}/tasks/total_due`, 'newer-version');
    expect(w.text()).toContain('which task version each one ran');
    expect(w.get('[data-testid="usage-note"]').text()).toBe(
      'Every experiment so far ran on task v1. Results on v1 and v2 are not comparable.',
    );
  });
});

describe('Task diff: the root files and small text fixtures', () => {
  it('gives prompt.md, task.yaml and reference.json their sizes and hashes', async () => {
    const { w } = await mountAt(
      `/suites/${SUITE_V2_ID}/tasks/total_due?diff=${SUITE_V1_ID}`,
      'newer-version',
    );
    const cells = (file: string) =>
      w
        .get(`tr[data-file="${file}"]`)
        .findAll('td')
        .map((td) => flat(td.text()));
    expect(cells('prompt.md')).toEqual([
      'changed',
      'prompt.md',
      expect.stringMatching(/^\d+ B → \d+ B$/),
      expect.stringMatching(/^\w{7}→\w{7}$/),
    ]);
    expect(cells('task.yaml')).toEqual([
      'unchanged',
      'task.yaml',
      expect.stringMatching(/^\d+ B$/),
      expect.stringMatching(/^\w{7}$/),
    ]);
  });

  it('line-diffs a changed small text fixture under the files', async () => {
    const { w } = await mountAt(
      `/suites/${SUITE_V2_ID}/tasks/late_fees?diff=${SUITE_V1_ID}`,
      'invalid-task',
    );
    const fixture = w.get('[data-text-diff="fixtures/policy_terms.json"]');
    expect(fixture.text()).toContain('1 line changed');
    expect(fixture.get('[data-changed="true"] [data-kind="removed"]').text()).toContain(
      'late_fee_rate',
    );
    expect(fixture.get('[data-changed="true"] [data-kind="added"]').text()).toContain(
      'fee_rate_monthly',
    );
  });
});
