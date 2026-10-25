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
    expect(w.text()).toContain('Suites are folders in ./suites. Edit the files and reload.');
    const [name, version, change, tasks, valid, types, path, loaded, action] = cells(w);
    expect(name).toBe('invoices-v1');
    expect(version).toBe('v1 0.1 3f9c2a1');
    // The last reload found nothing new (the API keeps only the last load's changes).
    expect(change).toBe('Unchanged since v1');
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

  it('explains an empty ./suites, with the folder to copy', async () => {
    const { w } = await mountAt('/suites', 'empty');
    expect(w.text()).toContain('0 suites');
    expect(w.find('table').exists()).toBe(false);
    const empty = w.get('[data-testid="empty-state"]');
    expect(empty.text()).toContain('No suites yet');
    expect(empty.text()).toContain(
      'A suite is a set of tasks your agent is tested on: a prompt, input files, a hidden answer and checks.',
    );
    expect(empty.text()).toContain('Put a suite folder in ./suites and reload.');
    expect(empty.find('button[aria-label="Copy ./suites"]').exists()).toBe(true);
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
