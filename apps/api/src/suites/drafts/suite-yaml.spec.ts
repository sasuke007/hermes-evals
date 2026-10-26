import { describe, expect, it } from 'vitest';
import { renderSuiteYaml } from './suite-yaml.js';

const SOURCE = `# invoices-v1: hand-written, keep this.
name: invoices-v1
version_label: '0.3'   # bumped by hand
description: >-
  Two accounts-payable questions over one family of invoice fixtures,
  generated with a fixed seed.
tasks:
  - total_due
  - overdue_list
`;

const FIELDS = {
  name: 'invoices-v1',
  versionLabel: '0.3',
  description:
    'Two accounts-payable questions over one family of invoice fixtures, generated with a fixed seed.',
  tasks: ['total_due', 'overdue_list'],
};

describe('renderSuiteYaml', () => {
  it('returns the file itself when nothing changed', () => {
    expect(renderSuiteYaml(SOURCE, FIELDS)).toBe(SOURCE);
  });

  it('patches the label and the task list only, comments kept', () => {
    const out = renderSuiteYaml(SOURCE, {
      ...FIELDS,
      versionLabel: '0.4',
      tasks: ['total_due', 'overdue_list', 'overdue_count'],
    });
    expect(out).toBe(
      SOURCE.replace("'0.3'   #", "'0.4'   #").replace(
        '  - overdue_list\n',
        '  - overdue_list\n  - overdue_count\n',
      ),
    );
  });

  it('removes the description, and reads a numeric label as its text', () => {
    expect(renderSuiteYaml(SOURCE, { ...FIELDS, description: null })).not.toContain('description');
    expect(
      renderSuiteYaml('name: a\nversion_label: 1.5\n', {
        name: 'a',
        versionLabel: '1.5',
        description: null,
        tasks: ['a1'],
      }),
    ).toBe('name: a\nversion_label: 1.5\n');
  });

  it('writes a task list only when the order is not the folder-name order', () => {
    const plain = 'name: a\nversion_label: x\n';
    expect(
      renderSuiteYaml(plain, {
        name: 'a',
        versionLabel: 'x',
        description: null,
        tasks: ['a1', 'b2'],
      }),
    ).toBe(plain);
    expect(
      renderSuiteYaml(plain, {
        name: 'a',
        versionLabel: 'x',
        description: null,
        tasks: ['b2', 'a1'],
      }),
    ).toBe(`${plain}tasks:\n  - b2\n  - a1\n`);
  });

  it('writes a new suite in the canonical style', () => {
    expect(
      renderSuiteYaml(null, {
        name: 'vendor-statements-v1',
        versionLabel: '0.1',
        description: 'Reconciling vendor statements against the ledger.',
        tasks: ['unmatched_lines'],
      }),
    ).toBe(`name: vendor-statements-v1
version_label: '0.1'
description: Reconciling vendor statements against the ledger.
tasks:
  - unmatched_lines
`);
  });
});
