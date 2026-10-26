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
const hint = ({ w }: Page) => w.get('[data-testid="create-hint"]');

async function typeName(page: Page, name: string): Promise<void> {
  await page.w.get('[data-testid="suite-name"]').setValue(name);
  await settle();
}

describe('NewSuitePage (SA.2)', () => {
  it('starts empty: a 640px form, the folder placeholder, Create blocked until there is a name', async () => {
    const page = await mountAt('/suites/new');
    const { w } = page;
    expect(flat(w.get('nav[aria-label="Breadcrumb"]').text())).toBe('Suites / New');
    expect(w.get('h1').text()).toBe('New suite');
    expect(w.get('[data-testid="new-suite-form"]').classes()).toContain('w-640');
    expect(w.get<HTMLInputElement>('[data-testid="version-label"]').element.value).toBe('0.1');
    expect(flat(w.get('[data-testid="folder-line"]').text())).toBe(
      'Folder: ./suites/<name>/ · Fixed after the first save.',
    );
    expect(w.text()).toContain('The suite opens as a draft with no tasks. Add them next.');
    expect(w.get('[data-testid="create-suite"]').attributes('aria-disabled')).toBe('true');
    expect(hint(page).text()).toBe('Enter a name to create the suite.');
  });

  it('checks the name as it is typed: taken, not a folder name, then free', async () => {
    const page = await mountAt('/suites/new');
    await typeName(page, 'invoices-v1');
    expect(flat(page.w.get('[data-testid="name-problem"]').text())).toBe(
      'invoices-v1 is already used by ./suites/invoices-v1.',
    );
    expect(page.w.get('[data-testid="suite-name"]').attributes('aria-invalid')).toBe('true');
    expect(hint(page).text()).toBe('Choose another name to create the suite.');
    expect(hint(page).classes()).toContain('text-fail-text');

    await typeName(page, 'Invoices v2');
    expect(flat(page.w.get('[data-testid="name-problem"]').text())).toBe(
      'Use letters, digits, ., _ and -, starting with a letter or digit.',
    );
    expect(hint(page).text()).toBe('Fix the name to create the suite.');

    await typeName(page, 'vendor-statements-v2');
    expect(page.w.find('[data-testid="name-problem"]').exists()).toBe(false);
    expect(flat(page.w.get('[data-testid="folder-line"]').text())).toBe(
      'Folder: ./suites/vendor-statements-v2/ · Fixed after the first save.',
    );
    expect(page.w.text()).toContain(
      'Saved as files in ./suites/vendor-statements-v2/ on this machine. Edit them here or on disk, and commit them with git like any other file.',
    );
    expect(hint(page).text()).toBe('Opens vendor-statements-v2 as a draft with no tasks.');
    expect(page.w.get('[data-testid="create-suite"]').attributes('aria-disabled')).toBeUndefined();
  });

  it('copies a suite: every task at its current version', async () => {
    const page = await mountAt('/suites/new');
    await typeName(page, 'invoices-v2');
    await page.w.get('[data-testid="from-copy"]').trigger('click');
    expect(page.w.get('[data-testid="from-copy"]').attributes('aria-pressed')).toBe('true');
    expect(page.w.get('[data-testid="copy-source"]').text()).toBe('invoices-v1 · v1 · 12 tasks');
    expect(page.w.text()).toContain(
      'Every task is copied at its current version, with its files. The copy starts as a draft, so nothing is written until you save v1.',
    );
    expect(hint(page).text()).toBe('Copies 12 tasks into a draft of invoices-v2.');
  });

  it('blocks Create while the label is empty', async () => {
    const page = await mountAt('/suites/new');
    await typeName(page, 'invoices-v2');
    await page.w.get('[data-testid="version-label"]').setValue('');
    expect(hint(page).text()).toBe('Add a version label.');
    expect(page.w.get('[data-testid="create-suite"]').attributes('aria-disabled')).toBe('true');
  });

  it('creates the draft and opens it', async () => {
    const page = await mountAt('/suites/new');
    await typeName(page, 'vendor-statements-v2');
    await page.w.get('[data-testid="new-suite-form"]').trigger('submit');
    await settle();
    expect(page.router.currentRoute.value.path).toBe('/suites/vendor-statements-v2/draft');
  });

  it('opens the zip import from Start from › A .zip file', async () => {
    const page = await mountAt('/suites/new');
    await page.w.get('[data-testid="from-zip"]').trigger('click');
    expect(document.querySelector('[data-testid="import-suite-dialog"]')).not.toBeNull();
  });

  it('keeps the page chrome and quotes the request when the suite list cannot load', async () => {
    const { w } = await mountAt('/suites/new', 'error');
    const banner = w.get('[data-testid="new-suite-error"]');
    expect(banner.text()).toContain('Could not load suites');
    expect(banner.text()).toContain('GET /api/suites → 502 · upstream api:8080 connection refused');
    expect(banner.text()).toContain(
      'The form needs the suite list to check names and to offer "Copy of a suite". Check that the api service is running: docker compose ps api',
    );
  });

  it('draws the form skeleton while loading', async () => {
    const { w } = await mountAt('/suites/new', 'loading');
    expect(w.get('[data-testid="new-suite-loading"]').attributes('aria-busy')).toBe('true');
  });
});
