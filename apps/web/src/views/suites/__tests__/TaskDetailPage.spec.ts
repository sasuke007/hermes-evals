import { afterEach, describe, expect, it, vi } from 'vitest';
import * as suitesApi from '@/api/suites';
import { SUITE_V1_ID, SUITE_V2_ID } from '@/fixtures/suites';
import { mountAt, settle, unmountPage } from './mountPage';

afterEach(() => {
  unmountPage();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type W = Awaited<ReturnType<typeof mountAt>>['w'];
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const text = (w: W, selector: string) => flat(w.get(selector).text());
/** Text with a space at every element boundary, as a reader sees separate blocks. */
function spaced(el: { element: Element }): string {
  const out: string[] = [];
  const walker = document.createTreeWalker(el.element, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n.textContent ?? '');
  return flat(out.join(' '));
}

describe('TaskDetailPage', () => {
  it('refetches the task on every visit: the experiments that ran it move', async () => {
    const get = vi.spyOn(suitesApi, 'getTask');
    const { w, router } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/dup_invoices`);
    expect(get).toHaveBeenCalledTimes(1);
    await router.push(`/suites/${SUITE_V1_ID}`);
    await settle();
    await router.push(`/suites/${SUITE_V1_ID}/tasks/dup_invoices`);
    await settle();
    expect(get).toHaveBeenCalledTimes(2);
    expect(w.get('h1').text()).toBe('dup_invoices');
  });

  it('shows dup_invoices as the TaskDetail board draws it', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/dup_invoices`);
    expect(flat(w.get('nav[aria-label="Breadcrumb"]').text())).toBe(
      'Suites / invoices-v1 / dup_invoices',
    );
    expect(w.get('h1').text()).toBe('dup_invoices');
    expect(text(w, '[data-testid="task-version"]')).toBe('v1');
    expect(text(w, '[data-testid="version-note"]')).toBe('unchanged since suite v1');
    expect(w.text()).toContain('Find invoices billed twice by the same vendor');
    expect(w.text()).toContain('./suites/invoices-v1/dup_invoices/');
    expect(w.find('[data-testid="old-task-version"]').exists()).toBe(false);

    // Prompt: what the agent receives, inline code kept.
    const prompt = w.get('[data-testid="prompt"]');
    expect(prompt.findAll('p')).toHaveLength(3);
    expect(prompt.get('code').text()).toBe('invoices.csv');
    expect(w.text()).toContain("Sent as task.txt in the agent's home");

    // Fixtures, with the preview open on the first rows.
    const fixture = w.get('tr[data-fixture="invoices.csv"]');
    expect(fixture.findAll('td').map((td) => flat(td.text()))).toEqual([
      '/workspace/invoices.csv',
      'CSV · 48 rows · 8 columns',
      '4.1 KB',
      'sha256:51e0a9c3…0d17',
      'Hide preview',
    ]);
    const preview = w.get('[data-testid="fixture-preview"]');
    expect(preview.text()).toContain('First 5 of 48 rows');
    expect(preview.findAll('tbody tr')).toHaveLength(5);
    await fixture.get('button').trigger('click');
    expect(w.find('[data-testid="fixture-preview"]').exists()).toBe(false);
    expect(fixture.get('button').attributes('aria-expanded')).toBe('false');

    // Verification: the sentence with its values in code, the primary's YAML open.
    expect(w.text()).toContain('2 checks · scored in this order');
    const answer = w.get('[data-check="answer"]');
    expect(flat(answer.get('[data-testid="verification-sentence"]').text())).toBe(
      'json_match on duplicates, unordered, pass at 1.0',
    );
    expect(answer.get('[data-testid="sentence-value"]').text()).toBe('duplicates');
    expect(answer.get('details').attributes('open')).toBeDefined();
    expect(w.get('[data-check="reads_fixture"] details').attributes('open')).toBeUndefined();
    expect(
      w
        .get('[data-check="reads_fixture"]')
        .findAll('[data-testid="sentence-value"]')
        .map((v) => v.text()),
    ).toEqual(['read_file', 'invoices.csv']);

    // The hidden reference, the verifier (none), the self-check, limits.
    const reference = w.get('[data-testid="reference"]');
    expect(reference.text()).toContain('Hidden from the agent');
    expect(reference.get('pre').text()).toBe(
      '{\n  "duplicates": [\n    ["INV-0988", "INV-1131"],\n    ["INV-1042", "INV-1107"]\n  ]\n}',
    );
    expect(w.text()).toContain("None. This task's checks use built-in types only.");
    expect(text(w, '[data-testid="self-check-status"]')).toBe('passed');
    expect(
      w
        .get('[data-result="answer"]')
        .findAll('span')
        .map((x) => x.text()),
    ).toEqual(['answer', 'passed1.00', 'passed', '1.00', 'scored against the reference answer']);
    expect(w.text()).toContain(
      'Ran 23 Oct 09:12 on suite reload. Each check is scored against the reference answer.',
    );
    expect(w.text()).toContain('Max turns20Time budget300 sToolsets neededfile');

    // History and the experiments that ran this version.
    const versions = w.findAll('a[data-version]');
    expect(versions.map(spaced)).toEqual([
      'v1 First version suite v1 · 21 Oct 15:31 current View files',
    ]);
    expect(versions[0]!.attributes('href')).toBe(
      `/suites/${SUITE_V1_ID}/tasks/dup_invoices?diff=${SUITE_V1_ID}`,
    );
    const usage = w.get('table[aria-label="Experiments that ran this task"]');
    expect(usage.findAll('tbody tr').map(spaced)).toContain(
      'Skill vs no skill, invoices-v1 baseline 0.20',
    );
    expect(w.text()).toContain('Every experiment so far ran on task v1.');
  });

  it('shows late_fees failing its own reference answer (Flow D, step 4)', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V2_ID}/tasks/late_fees`, 'invalid-task');
    expect(text(w, '[data-testid="version-note"]')).toBe('changed in suite v2');
    expect(text(w, '[data-testid="self-check-status"]')).toBe('failed');
    expect(
      w
        .get('[data-result="check"]')
        .findAll('span')
        .map((x) => x.text()),
    ).toEqual(['check', 'error–', 'error', '–', 'printed no result line on the reference answer']);
    expect(w.get('[data-testid="self-check-transcript"]').text()).toContain(
      "KeyError: 'late_fee_rate'",
    );
    expect(w.text()).toContain(
      'Ran 23 Oct 15:41 on suite reload. Previous run 23 Oct 09:12 passed.',
    );
    expect(flat(w.text())).toContain(
      'Same output as on Suite detail. Until this passes, late_fees cannot be selected in a new experiment.',
    );
    expect(flat(w.get('tr[data-fixture="policy_terms.json"]').text())).toContain(
      '/workspace/policy_terms.json changed in v2',
    );
    // The verifier's source, with its path and hash.
    const source = w.get('[role="region"][aria-label="Source of verify/check_late_fees.py"]');
    expect(source.findAll('[data-line]').length).toBe(15);
    // The traceback names line 11, the statement that raised.
    expect(source.get('[data-marked="true"]').attributes('data-line')).toBe('11');
    expect(w.text()).toContain('Verifier scripts are edited on disk.');
    const history = w.findAll('a[data-version]').map(spaced);
    expect(history[0]).toBe(
      'v2 Changed fixtures/policy_terms.json only suite v2 · 23 Oct 15:41 · now invalid current Diff with v1',
    );
  });

  it('marks an older task version and links back to the current one', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/total_due`, 'newer-version');
    const notice = w.get('[data-testid="old-task-version"]');
    expect(notice.attributes('role')).toBe('status');
    expect(flat(notice.text())).toContain(
      "You are viewing v1 of total_due. The current version is v2. Versions don't change.",
    );
    expect(notice.get('a').attributes('href')).toBe(`/suites/${SUITE_V2_ID}/tasks/total_due`);
    expect(text(w, '[data-testid="version-note"]')).toBe('replaced by v2 in suite v2');
    expect(flat(w.get('a[data-version="1"]').text())).toContain('First version · viewing');
  });

  it('shows the diff of total_due v1 → v2 (TaskDiff, changed)', async () => {
    const { w } = await mountAt(`/suites/${SUITE_V2_ID}/tasks/total_due`, 'newer-version');
    await w.get('a[data-version="2"]').trigger('click');
    await settle();
    expect(flat(w.get('nav[aria-label="Breadcrumb"]').text())).toBe(
      'Suites / invoices-v1 / total_due / v1 → v2',
    );
    expect(w.text()).toContain('Diff of task v1 and v2');
    const diff = w.get('[data-testid="task-diff"]');
    expect(text(w, '[data-testid="diff-count"]')).toBe('3 files changed · 1 unchanged');
    expect(
      diff
        .findAll('tr[data-file]')
        .map((r) => [r.attributes('data-file'), r.attributes('data-change')]),
    ).toEqual([
      ['prompt.md', 'changed'],
      ['task.yaml', 'unchanged'],
      ['reference.json', 'changed'],
      ['fixtures/invoices.csv', 'changed'],
    ]);
    expect(flat(diff.get('tr[data-file="fixtures/invoices.csv"]').text())).toContain(
      '4.1 KB → 4.2 KB',
    );
    expect(diff.text()).toContain('1 line changed');
    const changedRow = diff.get('[role="table"] [data-changed="true"]');
    expect(changedRow.get('[data-kind="removed"]').text()).toContain('An invoice is settled');
    expect(changedRow.get('[data-kind="added"] [data-marked="true"]').text()).toBe(
      'and invoices paid in part',
    );
    expect(spaced(diff.get('[data-testid="reference-diff"]'))).toContain(
      'total_due: 48213.65 total_due: 48526.05',
    );
    expect(diff.text()).toContain('Results on v1 and v2 are not comparable.');
    expect(diff.get('a.btn').attributes('href')).toBe(`/suites/${SUITE_V2_ID}/tasks/total_due`);
  });

  it("lists a first version's files as added", async () => {
    const { w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/dup_invoices?diff=${SUITE_V1_ID}`);
    expect(w.text()).toContain('Files of task v1');
    expect(flat(w.get('[data-testid="diff-notice"]').text())).toBe(
      'This is the first version of dup_invoices. There is no earlier version to compare with, so every file is listed as added.',
    );
    const files = w.findAll('tr[data-file]');
    expect(files.map((r) => r.attributes('data-change'))).toEqual([
      'added',
      'added',
      'added',
      'added',
    ]);
    expect(text(w, '[data-testid="diff-count"]')).toBe('4 files');
    expect(w.text()).toContain('Open a file from the task page to read it.');
  });

  it('says when only fixtures changed (TaskDiff, fixtures only)', async () => {
    const { w } = await mountAt(
      `/suites/${SUITE_V2_ID}/tasks/late_fees?diff=${SUITE_V1_ID}`,
      'invalid-task',
    );
    expect(flat(w.get('[data-testid="diff-notice"]').text())).toBe(
      'Only fixtures changed. The prompt, task.yaml, the reference answer and the verifier script are the same as v1. The self-check on v2 failed.',
    );
    expect(text(w, '[data-testid="diff-count"]')).toBe('1 file changed · 5 unchanged');
  });

  it('draws skeletons while loading, and quotes the server when it fails', async () => {
    let { w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/total_due`, 'loading');
    expect(w.find('[data-testid="task-loading"]').exists()).toBe(true);
    unmountPage();
    ({ w } = await mountAt(`/suites/${SUITE_V1_ID}/tasks/total_due`, 'error'));
    const banner = w.get('[role="alert"]');
    expect(banner.text()).toContain('Could not load total_due');
    expect(banner.text()).toContain(
      `GET /api/suites/${SUITE_V1_ID}/tasks/total_due → 502 · upstream api:8080 connection refused`,
    );
  });
});
