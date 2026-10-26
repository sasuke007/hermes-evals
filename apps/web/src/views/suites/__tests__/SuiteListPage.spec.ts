import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { reloadSuites } from '@/api/suites';
import type { SuiteReloadResult } from '@/api/types/suites';
import { suiteReloadFixture } from '@/fixtures/suites';
import { mountAt, settle, unmountPage } from './mountPage';

vi.mock('@/api/suites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/suites')>();
  return { ...actual, reloadSuites: vi.fn<typeof actual.reloadSuites>(actual.reloadSuites) };
});

afterEach(() => {
  unmountPage();
  vi.unstubAllGlobals();
});

const cells = (w: Awaited<ReturnType<typeof mountAt>>['w']) =>
  w
    .findAll('table[aria-label="Suites"] tbody tr')[0]!
    .findAll('td')
    .map((td) => td.text().replace(/\s+/g, ' '));

describe('SuiteListPage', () => {
  it('lists invoices-v1 at its current version, as SuiteList draws it', async () => {
    const { w } = await mountAt('/suites');
    expect(w.get('h1').text()).toBe('Suites');
    expect(w.text()).toContain('1 suite');
    expect(w.text()).toContain(
      'Suites are folders in ./suites. Create and edit them here, or edit the files and reload.',
    );
    const [name, version, change, tasks, valid, types, path, loaded, action] = cells(w);
    // The editor's draft world holds a draft of invoices-v1 by default.
    expect(name).toMatch(/^invoices-v1draft · 3 changesDraft based on v1, last edited \d\d:\d\d$/);
    expect(version).toBe('v1 0.1 3f9c2a1');
    // The changes that created the current version, even after an unchanged reload.
    expect(change).toBe('12 tasks added');
    expect([tasks, valid]).toEqual(['12', '12 / 12']);
    expect(types).toBe('json_matchnumeric_tolerancellm_judge+4');
    expect(path).toBe('./suites/invoices-v1');
    expect(loaded).toBe('23 Oct 09:12All self-checks passed');
    expect(action).toBe('Reload from disk');
    expect(w.get('a[href^="/suites/suite_"]').attributes('href')).toBe(
      '/suites/suite_01JAT3F9C2A1',
    );
    expect(w.text()).toContain('Experiments keep the version they were created on.');
  });

  it('shows Flow D after a reload: 11 / 12 valid and the now-invalid task', async () => {
    const { w } = await mountAt('/suites', 'invalid-task');
    const [, version, change, , valid, , , loaded] = cells(w);
    expect(version).toBe('v2 0.1 7d20e4b');
    expect(change).toBe('1 now invalid: late_fees');
    expect(valid).toBe('11 / 12');
    expect(loaded).toBe('23 Oct 15:41Created v2 · 1 task now invalid');
    expect(w.get('[data-testid="load-line"]').classes()).toContain('text-fail-text');
  });

  it('reloads every folder: busy, then the reload line under Last loaded', async () => {
    let finish: (r: SuiteReloadResult) => void = () => {};
    vi.mocked(reloadSuites).mockImplementationOnce(
      () => new Promise<SuiteReloadResult>((resolve) => (finish = resolve)),
    );
    const { w } = await mountAt('/suites', 'invalid-task');
    await w.get('[data-testid="reload-all"]').trigger('click');
    expect(reloadSuites).toHaveBeenLastCalledWith(undefined);
    expect(w.get('[data-testid="reload-all"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="reload-all"] svg').attributes('data-spinning')).toBe('true');
    expect(w.get('[data-testid="load-line"]').text()).toBe('Reloading and running self-checks…');
    expect(cells(w)[8]).toBe('Reloading…');
    finish(suiteReloadFixture('invalid-task'));
    await settle();
    expect(w.get('[data-testid="reload-all"]').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-testid="load-line"]').text()).toBe(
      'Created v2 · 1 task now invalid: late_fees',
    );
    // A long reload message wraps inside Last loaded instead of widening the table.
    expect(w.get('[data-testid="load-line"]').classes()).toEqual(
      expect.arrayContaining(['whitespace-normal', 'max-w-240']),
    );
  });

  it('reloads one folder by its path from its row', async () => {
    const { w } = await mountAt('/suites');
    await w.get('button[aria-label="Reload invoices-v1 from disk"]').trigger('click');
    await settle();
    expect(reloadSuites).toHaveBeenLastCalledWith('./suites/invoices-v1');
    expect(w.get('[data-testid="load-line"]').text()).toBe('All self-checks passed');
  });

  it('says why a reload request failed, verbatim, and can try again', async () => {
    vi.mocked(reloadSuites).mockRejectedValueOnce(
      new ApiError(503, 'POST /api/suites/reload', 'No worker is connected'),
    );
    const { w } = await mountAt('/suites');
    await w.get('[data-testid="reload-all"]').trigger('click');
    await settle();
    const banner = w.get('[data-testid="reload-error"]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('Could not reload suites');
    expect(banner.text()).toContain('POST /api/suites/reload → 503 · No worker is connected');
    await banner.get('button').trigger('click');
    await settle();
    expect(w.find('[data-testid="reload-error"]').exists()).toBe(false);
  });

  it('keeps the last good version when a folder could not be reloaded', async () => {
    const { w } = await mountAt('/suites', 'reload-failed');
    const failed = w.get('[data-testid="reload-failed"]');
    expect(failed.text()).toContain('invoices-v1 could not be reloaded');
    expect(failed.text()).toContain(
      './suites/invoices-v1/vat_split/task.yaml:14:9 · mapping values are not allowed here',
    );
    expect(failed.text()).toContain(
      'Nothing changed. The suite still serves v1, loaded 23 Oct 09:12 (3f9c2a1). No new version was created.',
    );
    const excerpt = w.get('[data-testid="reload-excerpt"]');
    expect(excerpt.text()).toContain('14 |     params: tolerance: 0.01');
    expect(excerpt.get('.text-fail-text').text()).toContain('params: tolerance: 0.01');
    expect(cells(w)[7]).toBe('23 Oct 09:12Could not reload');
    await failed.get('button').trigger('click');
    expect(reloadSuites).toHaveBeenLastCalledWith('./suites/invoices-v1');
  });

  it('explains an empty ./suites: Create a suite, Import a .zip, or the folder to copy (SA.1)', async () => {
    const { w } = await mountAt('/suites', 'empty');
    expect(w.text()).toContain('0 suites');
    expect(w.find('table').exists()).toBe(false);
    const empty = w.get('[data-testid="suites-empty"]');
    expect(empty.text()).toContain('No suites yet');
    expect(empty.text()).toContain(
      'A suite is a set of tasks your agent is tested on: a prompt, input files, a hidden answer and checks.',
    );
    expect(empty.get('a.btn.primary').text()).toBe('Create a suite');
    expect(empty.get('a.btn.primary').attributes('href')).toBe('/suites/new');
    expect(empty.findAll('button').map((b) => b.text())).toContain('Import a .zip');
    expect(empty.text()).toContain('Or put a suite folder in ./suites and reload.');
    expect(empty.find('button[aria-label="Copy ./suites"]').exists()).toBe(true);
    const format = empty.get('[data-testid="folder-format"]');
    expect(format.text()).toBe('See the folder format');
    expect(format.attributes('href')).toBe(
      'https://github.com/sasuke007/hermes-evals#suites-generators-and-the-sample-skills',
    );
  });

  it('draws skeleton rows while loading', async () => {
    const { w } = await mountAt('/suites', 'loading');
    expect(w.get('table').attributes('aria-busy')).toBe('true');
    expect(w.findAll('[data-testid="skeleton-row"]')).toHaveLength(2);
  });

  it('quotes the server when the list cannot load, with Retry', async () => {
    const { w } = await mountAt('/suites', 'error');
    const banner = w.get('[role="alert"]');
    expect(banner.text()).toContain('Could not load suites');
    expect(banner.text()).toContain('GET /api/suites → 502 · upstream api:8080 connection refused');
    expect(banner.get('button').text()).toBe('Retry');
  });
});

describe('SuiteListPage: authoring (SA.1)', () => {
  it('starts a suite from the header: New suite, Import .zip, Reload all from disk', async () => {
    const { w } = await mountAt('/suites');
    expect(w.get('[data-testid="new-suite"]').attributes('href')).toBe('/suites/new');
    expect(w.get('[data-testid="new-suite"]').classes()).toContain('primary');
    await w.get('[data-testid="import-zip"]').trigger('click');
    expect(document.querySelector('[data-testid="import-suite-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="step-label"]')?.textContent).toBe(
      'Step 1 of 2 · choose file',
    );
  });

  it('marks a suite with an open draft: the chip links to it and says what it is based on', async () => {
    const { w } = await mountAt('/suites');
    const chip = w.get('[data-testid="draft-chip"]');
    expect(chip.text()).toBe('draft · 3 changes');
    expect(chip.attributes('href')).toBe('/suites/invoices-v1/draft');
    const tip = w.get(`#${chip.attributes('aria-describedby')}`);
    expect(tip.text()).toMatch(/^Draft based on v1, last edited \d\d:\d\d$/);
  });

  it('hides folders gone from disk behind "Show N missing from disk"', async () => {
    const { w } = await mountAt('/suites', 'missing-folders');
    expect(w.text()).toContain('1 suite');
    expect(w.findAll('table[aria-label="Suites"] tbody tr')).toHaveLength(1);
    const toggle = w.get('[data-testid="toggle-missing"]');
    expect(toggle.text()).toBe('Show 3 missing from disk');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    const rows = w.findAll('table[aria-label="Suites"] tbody tr');
    expect(rows).toHaveLength(4);
    expect(rows[1]!.text()).toContain('Missing from disk');
    expect(w.get('[data-testid="toggle-missing"]').text()).toBe('Hide 3 missing from disk');
  });

  it('shows where each folder stands while Reload all runs one folder at a time', async () => {
    let finish: (r: SuiteReloadResult) => void = () => {};
    vi.mocked(reloadSuites).mockImplementationOnce(
      () => new Promise<SuiteReloadResult>((resolve) => (finish = resolve)),
    );
    const { w } = await mountAt('/suites', 'missing-folders');
    await w.get('[data-testid="toggle-missing"]').trigger('click');
    await w.get('[data-testid="reload-all"]').trigger('click');
    await settle();
    const lines = w.findAll('[data-testid="load-line"]').map((l) => l.text());
    expect(lines[0]).toBe('Reloading and running self-checks…');
    // Folders gone from disk are not reloaded: they keep their line.
    expect(lines.slice(1)).toEqual(['Missing from disk', 'Missing from disk', 'Missing from disk']);
    expect(cells(w)[8]).toBe('Reloading…');
    finish(suiteReloadFixture('v1'));
    await settle();
    expect(w.get('[data-testid="load-line"]').text()).toBe('All self-checks passed');
  });
});
