import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import SkillDetailDrawer from '../SkillDetailDrawer.vue';
import { SKILL_INVOICE_METHOD_ID } from '@/fixtures/resources';
import { mountResources } from './mountResources';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
});

async function drawer(file: string | null = null, skillId = SKILL_INVOICE_METHOD_ID) {
  const mounted = await mountResources(SkillDetailDrawer, { props: { skillId, file } });
  w = mounted.w;
  await flushPromises();
  return mounted;
}
const content = () => w!.get('[data-testid="skill-content"]');

describe('Skill detail', () => {
  it('names the version, its hash, when it was uploaded and who uses it', async () => {
    await drawer();
    const dialog = w!.get('[role="dialog"]');
    expect(
      document.getElementById(dialog.attributes('aria-labelledby')!)?.textContent?.trim(),
    ).toBe('invoice-method');
    expect(w!.findAll('[data-testid="tag"]').map((t) => t.text())).toEqual([
      '1.0.0',
      'sha256:9c41e07d',
    ]);
    expect(w!.get('[data-testid="skill-meta"]').text()).toBe(
      'Uploaded 22 Oct 09:48 · 4 files · used by with-skill',
    );
    expect(w!.get('a.btn').text()).toBe('Download zip');
    expect(w!.get('a.btn').attributes('href')).toBe(
      `/api/resources/skills/${SKILL_INVOICE_METHOD_ID}/zip`,
    );
  });

  it('lists the files and renders SKILL.md: front matter as written, then its Markdown', async () => {
    await drawer();
    const files = w!.get('nav[aria-label="Files"]').findAll('button');
    expect(files.map((b) => b.find('span').text())).toEqual([
      'SKILL.md',
      'checklist.md',
      'examples/reconcile.py',
      'examples/sample.csv',
    ]);
    expect(files.map((b) => b.findAll('span')[1]!.text())).toEqual([
      '2.1 KB',
      '1.4 KB',
      '9.8 KB',
      '4.9 KB',
    ]);
    expect(files[0]!.attributes('aria-current')).toBe('true');
    expect(content().get('[data-testid="code-block"]').text()).toBe(
      'name: invoice-method\nversion: 1.0.0\ndescription: Method for reconciling vendor invoices: always check credit notes, duplicates and partial payments before totalling',
    );
    expect(content().get('h3').text()).toBe('Invoice method');
    const steps = content().findAll('ol li');
    expect(steps).toHaveLength(5);
    expect(steps[0]!.text()).toBe(
      'Load the whole file with read_file. Do not sample it with head.',
    );
    expect(steps[0]!.findAll('code').map((c) => c.text())).toEqual(['read_file', 'head']);
    await files[1]!.trigger('click');
    expect(w!.emitted('update:file')?.[0]).toEqual(['checklist.md']);
  });

  it('shows a Markdown file, code as written, and CSV as a table', async () => {
    await drawer('checklist.md');
    expect(content().get('h3').text()).toBe('Columns this method expects');
    expect(content().findAll('ul li')).toHaveLength(5);

    w!.unmount();
    await drawer('examples/reconcile.py');
    expect(content().get('[data-testid="code-block"]').text()).toContain('def duplicates(rows):');

    w!.unmount();
    await drawer('examples/sample.csv');
    const table = content().get('table');
    expect(table.findAll('th').map((th) => th.text())).toEqual([
      'invoice_no',
      'vendor_name',
      'amount',
      'po_number',
      'status',
    ]);
    expect(table.findAll('tbody tr')).toHaveLength(2);
  });

  it('closes on Esc and on ×', async () => {
    await drawer();
    await w!.get('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(w!.emitted('close')).toBeTruthy();
    await w!.get('button[aria-label="Close"]').trigger('click');
    expect(w!.emitted('close')!.length).toBeGreaterThanOrEqual(2);
  });

  it('says when the skill cannot be loaded', async () => {
    await drawer(null, 'skill_missing');
    expect(w!.get('[role="alert"]').text()).toContain(
      'GET /api/resources/skills/skill_missing → 404 · skill skill_missing not found',
    );
  });
});
