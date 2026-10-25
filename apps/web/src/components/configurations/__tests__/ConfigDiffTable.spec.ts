import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { diffConfigurations } from '@/api/configurations';
import ConfigDiffTable from '@/components/configurations/ConfigDiffTable.vue';
import { CONFIG_VERSION_IDS } from '@/fixtures/configurations';
import { setScenario } from '@/api/__tests__/scenario';

const { baseline, 'with-skill': withSkill, 'with-mcp': withMcp } = CONFIG_VERSION_IDS;

beforeEach(() => setScenario(null));

describe('ConfigDiffTable', () => {
  it('counts and names the fields that differ, with the reference first', async () => {
    const diff = await diffConfigurations([baseline, withSkill, withMcp]);
    const w = mount(ConfigDiffTable, { props: { diff } });
    expect(w.get('[data-testid="diff-line"]').text()).toBe(
      `${diff.differing.length} fields differ: ${diff.differing.join(', ')}`,
    );
    expect(w.attributes('data-differing')).toBe(String(diff.differing.length));
    expect(w.findAll('thead th').map((th) => th.text())).toEqual([
      'Field',
      ...diff.columns.map((c) => `${c.name} v${c.version}`),
    ]);
    // `name` is the header, never a row.
    expect(w.find('[data-field="name"]').exists()).toBe(false);
    const skills = w.get('[data-field="skills"]');
    expect(skills.attributes('data-differs')).toBe('true');
    expect(skills.classes()).toContain('[&>td]:bg-accent-soft');
    expect(skills.text()).toContain('≠');
    const cells = skills.findAll('td').slice(1);
    // The reference column is never bold; a cell that differs from it is.
    expect(cells[0]!.classes()).not.toContain('font-semibold');
    expect(cells[1]!.classes()).toContain('font-semibold');
  });

  it('says one field differs in the singular, and hides equal rows on request', async () => {
    const diff = await diffConfigurations([baseline, withSkill]);
    const w = mount(ConfigDiffTable, { props: { diff, onlyDifferences: false } });
    expect(w.get('[data-testid="diff-line"]').text()).toBe('1 field differs: skills');
    const all = w.findAll('tbody tr').length;
    await w.setProps({ onlyDifferences: true });
    expect(w.findAll('tbody tr').map((tr) => tr.attributes('data-field'))).toEqual(['skills']);
    expect(all).toBeGreaterThan(1);
  });

  it('inline: roles under the names, and what the count means for a verdict', async () => {
    const one = await diffConfigurations([baseline, withSkill]);
    const w = mount(ConfigDiffTable, {
      props: { diff: one, variant: 'inline', roles: ['baseline', 'candidate'] },
    });
    expect(w.text()).toContain('This experiment is controlled: one variable changes.');
    expect(w.findAll('thead th').map((th) => th.text())).toEqual([
      'Field',
      'baseline baseline',
      'with-skill candidate',
    ]);
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    const many = await diffConfigurations([baseline, withSkill, withMcp]);
    await w.setProps({ diff: many, roles: null });
    expect(w.text()).toContain(
      'More than one variable changes. A verdict will not tell you which one mattered.',
    );
  });

  it('asks for two configurations when there is nothing to compare', () => {
    const w = mount(ConfigDiffTable, { props: { diff: null, variant: 'inline' } });
    expect(w.text()).toBe('Pick two configurations to compare.');
    expect(w.find('table').exists()).toBe(false);
  });
});
