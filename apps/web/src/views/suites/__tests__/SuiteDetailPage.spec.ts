import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSuiteHistory, reloadSuites } from '@/api/suites';
import { SUITE_V1_ID, SUITE_V2_ID, suiteReloadFixture } from '@/fixtures/suites';
import { mountAt, settle, unmountPage } from './mountPage';

vi.mock('@/api/suites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/suites')>();
  return {
    ...actual,
    reloadSuites: vi.fn<typeof actual.reloadSuites>(actual.reloadSuites),
    getSuiteHistory: vi.fn<typeof actual.getSuiteHistory>(actual.getSuiteHistory),
  };
});

afterEach(() => {
  unmountPage();
  vi.unstubAllGlobals();
});

type W = Awaited<ReturnType<typeof mountAt>>['w'];
const text = (w: W, selector: string) => w.get(selector).text().replace(/\s+/g, ' ').trim();
const taskRow = (w: W, key: string) => w.get(`tr[data-task="${key}"]`);

describe('SuiteDetailPage', () => {
  it('refetches History on every visit: its "Used by experiments" moves', async () => {
    vi.mocked(getSuiteHistory).mockClear();
    const { router } = await mountAt(`/suites/${SUITE_V2_ID}`);
    expect(getSuiteHistory).toHaveBeenCalledTimes(1);
    await router.push('/suites');
    await settle();
    await router.push(`/suites/${SUITE_V2_ID}`);
    await settle();
    expect(getSuiteHistory).toHaveBeenCalledTimes(2);
  });

  it('shows the current version with its tasks and History (SuiteDetail board)', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}`);
    expect(w.get('nav[aria-label="Breadcrumb"]').text().replace(/\s+/g, ' ')).toBe(
      'Suites / invoices-v1',
    );
    expect(w.get('h1').text()).toBe('invoices-v1');
    expect(text(w, '[data-testid="version-select"] b')).toBe('v1 · current');
    expect(text(w, '[data-testid="task-count"]')).toBe('12 tasks · 12 valid');
    expect(text(w, '[data-testid="suite-strip"]')).toBe(
      './suites/invoices-v1 · v1 · loaded 23 Oct 09:12',
    );
    expect(w.findAll('table[aria-label="Tasks"] tbody tr')).toHaveLength(12);
    expect(
      taskRow(w, 'dup_invoices')
        .findAll('td')
        .map((td) => td.text()),
    ).toEqual([
      'dup_invoices',
      'v1',
      'Find invoices billed twice by the same vendor',
      'json_matchtrajectory_match',
      '20',
      '300 s',
      '1',
      'valid',
      'Edit',
    ]);
    expect(w.find('[data-testid="invalid-alert"]').exists()).toBe(false);
    expect(w.find('[data-testid="old-version"]').exists()).toBe(false);
    const history = w.findAll('table[aria-label="Suite versions"] tbody tr');
    expect(history).toHaveLength(1);
    expect(history[0]!.text()).toContain('current');
    expect(history[0]!.text()).toContain('initial load');
    expect(history[0]!.text()).toContain('added 12 tasks');
    expect(history[0]!.attributes('data-viewed')).toBe('true');
  });

  it('flags the task that failed its self-check after the reload (Flow D, step 3)', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V2_ID}`, 'invalid-task');
    const alert = w.get('[data-testid="invalid-alert"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('Reload created v2: 1 task failed self-check');
    expect(alert.text().replace(/\s+/g, ' ')).toContain(
      'late_fees is shown in experiments but cannot be selected until its check passes on its own reference answer.',
    );
    expect(text(w, '[data-testid="task-count"]')).toBe('12 tasks · 11 valid');
    const late = taskRow(w, 'late_fees');
    expect(late.attributes('data-valid')).toBe('false');
    expect(late.get('[data-changed="true"]').text()).toBe('v2');
    const toggle = late.get('[data-testid="validity-toggle"]');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const failure = w.get('[data-testid="self-check-failure"]');
    expect(failure.text()).toContain(
      'verifier_script check_late_fees.py printed no result line on the reference answer · score status error',
    );
    expect(failure.text().replace(/\s+/g, ' ')).toContain(
      'key check · ran 23 Oct 15:41:07 · 0.3 s · previous run 23 Oct 09:12 passed',
    );
    expect(failure.get('[data-testid="failure-transcript"]').text()).toContain(
      "KeyError: 'late_fee_rate'",
    );
    expect(failure.text()).toContain('python3 verify/check_late_fees.py --answer <answer.json>');
    expect(failure.get('a').attributes('href')).toBe(`/suites/${SUITE_V2_ID}/tasks/late_fees`);
    // Collapse, then "Show late_fees" opens it again and moves focus to the chip.
    await toggle.trigger('click');
    expect(w.find('[data-testid="self-check-failure"]').exists()).toBe(false);
    await alert.get('button').trigger('click');
    await settle();
    expect(w.find('[data-testid="self-check-failure"]').exists()).toBe(true);
    expect(document.activeElement).toBe(
      taskRow(w, 'late_fees').get('[data-testid="validity-toggle"]').element,
    );
  });

  it('shows an older version read-only, with the way back (SuiteDetailStates, viewing v3)', async () => {
    const { w, router } = await mountAt(`/suites/${SUITE_V1_ID}`, 'invalid-task');
    const notice = w.get('[data-testid="old-version"]');
    expect(notice.attributes('role')).toBe('status');
    expect(notice.text().replace(/\s+/g, ' ')).toContain(
      "You are viewing v1. The current version is v2. Tasks below are as saved in v1. Versions don't change; to edit, go back to v2.",
    );
    expect(text(w, '[data-testid="suite-strip"]')).toBe(
      "./suites/invoices-v1 · v1 · loaded 21 Oct 15:31 · versions don't change",
    );
    expect(w.find('[data-testid="reload-suite"]').exists()).toBe(false);
    expect(text(w, '[data-testid="version-select"] b')).toBe('v1');
    await notice.get('button').trigger('click');
    await settle();
    expect(router.currentRoute.value.params.id).toBe(SUITE_V2_ID);
    expect(w.find('[data-testid="old-version"]').exists()).toBe(false);
  });

  it('opens another version from the selector, by keyboard', async () => {
    const { w, router } = await mountAt(`/suites/${SUITE_V2_ID}`, 'newer-version');
    const trigger = w.get('[data-testid="version-select"]');
    await trigger.trigger('click');
    const options = w.findAll('[role="option"]');
    expect(options.map((o) => o.findAll('span').map((x) => x.text()))).toEqual([
      ['v2 · current', '23 Oct 15:41'],
      ['v1', '21 Oct 15:31'],
    ]);
    expect(document.activeElement).toBe(options[0]!.element);
    await w.get('[role="listbox"]').trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[1]!.element);
    await w.get('[role="listbox"]').trigger('keydown', { key: 'Escape' });
    expect(w.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    await w.findAll('[role="option"]')[1]!.trigger('click');
    await settle();
    expect(router.currentRoute.value.params.id).toBe(SUITE_V1_ID);
  });

  it('marks a reverted version in the selector and the History (reverted)', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}`, 'reverted');
    expect(text(w, '[data-testid="version-select"] b')).toBe('v1 · current');
    const rows = w.findAll('table[aria-label="Suite versions"] tbody tr');
    expect(rows.map((r) => r.get('td').text().replace(/\s+/g, ' '))).toEqual([
      'v1 (reverted)current',
      'v2',
      'v1',
    ]);
    expect(rows[0]!.text()).toContain('now valid late_fees');
    expect(rows[1]!.text()).toContain('now invalid late_fees');
    expect(rows[0]!.findAll('a').length).toBeGreaterThan(1);
  });

  it('reloads the current version and moves to the version the reload points at', async () => {
    const reverted = suiteReloadFixture('reverted');
    vi.mocked(reloadSuites).mockResolvedValueOnce(reverted);
    const { w, router } = await mountAt(`/suites/${SUITE_V2_ID}`, 'invalid-task');
    await w.get('[data-testid="reload-suite"]').trigger('click');
    await settle();
    expect(reloadSuites).toHaveBeenLastCalledWith('./suites/invoices-v1');
    expect(router.currentRoute.value.params.id).toBe(SUITE_V1_ID);
    expect(text(w, '[data-testid="suite-strip"]')).toContain(
      'Reverted to v1 · late_fees valid again',
    );
  });

  it('stays on the version a reload left unchanged, and says so', async () => {
    const { w, router } = await mountAt(`/suites/${SUITE_V1_ID}`);
    await w.get('[data-testid="reload-suite"]').trigger('click');
    await settle();
    expect(router.currentRoute.value.params.id).toBe(SUITE_V1_ID);
    expect(text(w, '[data-testid="suite-strip"]')).toBe(
      './suites/invoices-v1 · v1 · loaded 23 Oct 09:12 · All self-checks passed',
    );
  });

  it('keeps the served version when the folder could not be reloaded', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}`, 'reload-failed');
    expect(w.get('[data-testid="reload-failed"]').text()).toContain(
      'invoices-v1 could not be reloaded',
    );
  });

  it('draws skeleton rows while loading, and quotes the server when it fails', async () => {
    let { w } = await mountAt(`/suites/${SUITE_V1_ID}`, 'loading');
    expect(w.find('[data-testid="suite-loading"]').exists()).toBe(true);
    expect(w.get('table[aria-label="Tasks"]').attributes('aria-busy')).toBe('true');
    unmountPage();
    ({ w } = await mountAt(`/suites/${SUITE_V1_ID}`, 'error'));
    const banner = w.get('[role="alert"]');
    expect(banner.text()).toContain('Could not load this suite');
    expect(banner.text()).toContain(
      `GET /api/suites/${SUITE_V1_ID} → 502 · upstream api:8080 connection refused`,
    );
  });

  it('answers an unknown version with the 404', async () => {
    const { w } = await mountAt('/suites/suite_nope');
    expect(w.get('[role="alert"]').text()).toContain('→ 404 · suite suite_nope not found');
  });
});
