import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { patchYaml, renderYaml, YamlPatchError } from './yaml-patch.js';

const TASK = `# Hand-written: keep this comment.
summary: Total amount still due   # shown in lists
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
  path: total_due
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { path: total_due, abs: 0.01 }
  # the trajectory check
  - key: reads_ledger
    type: trajectory_match
    params:
      tool: read_file   # Hermes's file tool
      min_calls: 1
`;

const value = (text: string) => parse(text) as Record<string, unknown>;

/** The file with `edit` applied to its parsed value. */
function edited(source: string, edit: (v: Record<string, unknown>) => void): string {
  const next = value(source);
  edit(next);
  const out = patchYaml(source, next);
  expect(value(out)).toEqual(next);
  return out;
}

describe('patchYaml', () => {
  it('leaves an unchanged file byte for byte', () => {
    expect(patchYaml(TASK, value(TASK))).toBe(TASK);
  });

  it('changes one scalar and nothing else, keeping its comment', () => {
    const out = edited(TASK, (v) => {
      v.summary = 'Total still due';
    });
    expect(out).toBe(TASK.replace('Total amount still due   #', 'Total still due   #'));
  });

  it('re-prints a flow mapping in its own style', () => {
    const out = edited(TASK, (v) => {
      const checks = v.verification as Array<{ params: Record<string, unknown> }>;
      checks[0]!.params.abs = 0.005;
    });
    expect(out).toBe(TASK.replace('abs: 0.01 }', 'abs: 0.005 }'));
  });

  it('patches a block mapping key by key', () => {
    const out = edited(TASK, (v) => {
      const checks = v.verification as Array<{ params: Record<string, unknown> }>;
      checks[1]!.params.min_calls = 2;
      checks[1]!.params.max_calls = 4;
    });
    expect(out).toContain(
      "      tool: read_file   # Hermes's file tool\n      min_calls: 2\n      max_calls: 4\n",
    );
  });

  it('removes a key with its line, and adds one after the last key', () => {
    const out = edited(TASK, (v) => {
      const answer = v.answer as Record<string, unknown>;
      delete answer.path;
      v.self_check = { expected_workspace: 'expected', negative_control: true };
    });
    expect(out).toContain('answer:\n  format: fenced_json\nverification:');
    expect(
      out.endsWith('self_check:\n  expected_workspace: expected\n  negative_control: true\n'),
    ).toBe(true);
    expect(out.startsWith('# Hand-written: keep this comment.\n')).toBe(true);
  });

  it('appends a check in the canonical style', () => {
    const out = edited(TASK, (v) => {
      (v.verification as unknown[]).push({
        key: 'vendor',
        type: 'exact_match',
        params: { path: 'top_vendor' },
      });
    });
    expect(out).toContain(
      '      min_calls: 1\n  - key: vendor\n    type: exact_match\n    params: { path: top_vendor }\n',
    );
    expect(out).toContain('# the trajectory check');
  });

  it('reorders checks with their own text and comments', () => {
    const out = edited(TASK, (v) => {
      (v.verification as unknown[]).reverse();
    });
    expect(out).toContain(
      "verification:\n  # the trajectory check\n  - key: reads_ledger\n    type: trajectory_match\n    params:\n      tool: read_file   # Hermes's file tool\n      min_calls: 1\n  - key: answer\n",
    );
  });

  it('removes a check and keeps a renamed one in its place', () => {
    const out = edited(TASK, (v) => {
      const checks = v.verification as Array<Record<string, unknown>>;
      checks.splice(0, 1);
      checks[0]!.key = 'reads_invoices';
    });
    expect(out).toContain('verification:\n  # the trajectory check\n  - key: reads_invoices\n');
    expect(out).not.toContain('numeric_tolerance');
  });

  it('writes an emptied list as [] and a scalar over a block mapping', () => {
    const out = edited(TASK, (v) => {
      v.verification = [];
      v.limits = 'none';
    });
    expect(out).toContain('limits: none\nanswer:');
    expect(out.endsWith('verification: []\n')).toBe(true);
  });

  it('writes the first content of an empty [] or {} in the canonical style', () => {
    const blank = 'summary: x   # kept\nlimits: {}\nverification: []\n';
    const out = edited(blank, (v) => {
      v.limits = { max_turns: 12 };
      v.verification = [{ key: 'answer', type: 'numeric_tolerance', params: { abs: 0.01 } }];
    });
    expect(out).toBe(
      'summary: x   # kept\nlimits:\n  max_turns: 12\nverification:\n  - key: answer\n    type: numeric_tolerance\n    params: { abs: 0.01 }\n',
    );
    // A list of scalars stays on one line, as the sample suites write toolsets.
    expect(edited('toolsets: []\n', (v) => (v.toolsets = ['file']))).toBe('toolsets: [file]\n');
  });

  it('keeps the quoting and folding of suite.yaml', () => {
    const suite = `name: invoices-v1
version_label: '0.3'
description: >-
  Twelve accounts-payable questions over one family of invoice fixtures,
  generated with a fixed seed.
tasks:
  - total_due
  - overdue_list
`;
    const out = edited(suite, (v) => {
      v.version_label = '0.4';
      v.description =
        'Thirteen accounts-payable questions over one family of invoice fixtures, generated with a fixed seed by a script that also computes every reference.';
      v.tasks = ['overdue_list', 'total_due', 'overdue_count'];
    });
    expect(out).toBe(`name: invoices-v1
version_label: '0.4'
description: >-
  Thirteen accounts-payable questions over one family of invoice fixtures,
  generated with a fixed seed by a script that also computes every reference.
tasks:
  - overdue_list
  - total_due
  - overdue_count
`);
  });

  it('renders a new file in the canonical style', () => {
    expect(
      renderYaml({
        summary: 'Count overdue invoices',
        limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file', 'terminal'] },
        answer: { format: 'fenced_json', path: 'overdue_count' },
        verification: [
          { key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } },
        ],
      }),
    ).toBe(`summary: Count overdue invoices
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
  path: overdue_count
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0 }
`);
  });

  it('quotes what YAML would read as another type', () => {
    const out = edited('version_label: x\n', (v) => {
      v.version_label = '0.10';
    });
    expect(out).toBe("version_label: '0.10'\n");
  });

  it('refuses a file that does not parse or is not a mapping', () => {
    expect(() => patchYaml('a: [1\n', { a: 1 })).toThrow(YamlPatchError);
    expect(() => patchYaml('- a\n', { a: 1 })).toThrow(YamlPatchError);
  });

  it('writes an empty file from scratch', () => {
    expect(patchYaml('', { summary: 'x' })).toBe('summary: x\n');
  });
});
