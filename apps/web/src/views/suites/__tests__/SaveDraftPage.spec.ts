import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { mountAt, settle, unmountPage } from './mountPage';

beforeEach(() => resetDraftFixtures());
afterEach(() => {
  unmountPage();
  vi.unstubAllGlobals();
});

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const PATH = '/suites/invoices-v1/save';

describe('SaveDraftPage (SA.11)', () => {
  it('reviews the draft: its changes against the base, what is written, the label, Save', async () => {
    const { w } = await mountAt(PATH);
    expect(flat(w.get('nav[aria-label="Breadcrumb"]').text())).toBe(
      'Suites / invoices-v1 / Review and save',
    );
    expect(w.get('h1').text()).toBe('Review and save as v2');
    expect(w.get('[data-testid="save-subline"]').text()).toMatch(
      /^Draft based on v1 · \d+ changes? · saved \d\d:\d\d$/,
    );
    const changes = w.get('[data-testid="draft-changes"]');
    expect(changes.text()).toContain('against v1 · each row opens its TaskDiff');
    expect(changes.find('[data-target="overdue_count"]').exists()).toBe(true);
    // The task rows open on their TaskDiff against the base, both at once.
    expect(
      changes
        .findAll('[data-target]')
        .filter((row) => row.find('[data-testid="draft-task-diff"]').exists())
        .map((row) => row.attributes('data-target')),
    ).toEqual(['overdue_count', 'total_due']);
    expect(flat(w.get('[data-testid="writes-caption"]').text())).toMatch(
      /^Writes \d+ files? to \.\/suites\/invoices-v1\/ and removes/,
    );
    expect(w.text()).toContain(
      'Change it if you track your own versions. The platform numbers versions itself: this save creates v2.',
    );
    expect(w.get('[data-testid="save-draft"]').text()).toBe('Save as v2');
  });

  it('saves: the steps, then the version created with Open suite and New experiment on it', async () => {
    const { w } = await mountAt(PATH);
    await w.get('[data-testid="save-draft"]').trigger('click');
    await settle();
    const panel = w.get('[data-testid="save-panel"]');
    expect(panel.attributes('data-phase')).toBe('created');
    expect(w.get('[data-testid="save-created"] b').text()).toBe('v2 saved');
    expect(w.findAll('[data-testid="save-steps"] [data-state="done"]')).toHaveLength(4);
    const next = w.findAll('[data-testid="save-panel"] a');
    expect(next.map((a) => a.text())).toEqual(['Open suite', 'New experiment on v2']);
    expect(next[0]!.attributes('href')).toMatch(/^\/suites\/suite_/);
    expect(next[1]!.attributes('href')).toMatch(/^\/experiments\/new\?suite=suite_/);
  });

  it('asks before saving a task that would be stored invalid', async () => {
    const { w } = await mountAt(PATH, 'draft-invalid-task');
    await w.get('[data-testid="save-draft"]').trigger('click');
    await settle();
    const confirm = w.get('[data-testid="confirm-invalid"]');
    expect(confirm.text()).toContain('Save with 1 invalid task?');
    await confirm.findAll('button')[1]!.trigger('click');
    expect(w.get('[data-testid="save-panel"]').attributes('data-phase')).toBe('review');
    await w.get('[data-testid="save-draft"]').trigger('click');
    await w.get('[data-testid="confirm-invalid"] button').trigger('click');
    await settle();
    expect(w.get('[data-testid="save-panel"]').attributes('data-phase')).toBe('created');
  });

  it('says nothing changed when the files are the base version', async () => {
    const { w } = await mountAt(PATH, 'draft-no-changes');
    expect(w.get('[data-testid="draft-changes"]').text()).toContain(
      'The draft has no changes against v1.',
    );
    await w.get('[data-testid="save-draft"]').trigger('click');
    await settle();
    expect(flat(w.get('[data-testid="save-unchanged"] b').text())).toBe(
      'Nothing changed. invoices-v1 stays at v1.',
    );
  });

  it('keeps the draft when the loader refuses the staging folder: nothing on disk changed', async () => {
    const { w } = await mountAt(PATH, 'save-failed');
    await w.get('[data-testid="save-draft"]').trigger('click');
    await settle();
    expect(flat(w.get('[data-testid="save-failed"]').text())).toBe(
      'Not saved. overdue_count/task.yaml line 9: unknown key prmary. Nothing on disk changed. Your draft is kept.',
    );
    expect(w.get('[data-state="fail"]').attributes('data-step')).toBe('loading');
    expect(w.get('[data-testid="save-panel"] a.btn.primary').attributes('href')).toBe(
      '/suites/invoices-v1/draft',
    );
  });

  it('says saving needs the worker when none runs, with the command and Try again', async () => {
    const { w } = await mountAt(PATH, 'no-worker');
    await w.get('[data-testid="save-draft"]').trigger('click');
    await settle();
    expect(w.get('[data-testid="save-offline"]').text()).toContain('No worker is running.');
    expect(w.get('[data-testid="copy-command"]').text()).toContain('docker compose up -d worker');
  });

  it('does not save over a newer version on disk: back to the draft to combine', async () => {
    const { w } = await mountAt(PATH, 'draft-conflict');
    const notice = w.get('[data-testid="save-conflict"]');
    expect(flat(notice.text())).toContain(
      './suites/invoices-v1 changed on disk after this draft began.',
    );
    expect(w.get('[data-testid="save-draft"]').attributes('aria-disabled')).toBe('true');
    await w.get('[data-testid="save-draft"]').trigger('click');
    expect(w.get('[data-testid="save-panel"]').attributes('data-phase')).toBe('review');
  });

  it('keeps the chrome and says the draft is kept when the review cannot load', async () => {
    const { w } = await mountAt(PATH, 'error');
    const banner = w.get('[data-testid="review-error"]');
    expect(banner.text()).toContain('Could not load the review of the draft');
    expect(banner.text()).toContain(
      'GET /api/suites/invoices-v1/draft/review → 502 · upstream api:8080 connection refused',
    );
    expect(banner.text()).toContain(
      'Nothing was written to ./suites/invoices-v1/. Your draft is kept.',
    );
  });
});
