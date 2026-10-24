import { describe, expect, it } from 'vitest';
import type { VerificationEntry } from '@hermes-evals/shared';
import { answerPathOf, verificationYamlSlices } from './yaml-slice.js';

const entry = (key: string, type: VerificationEntry['type'], params = {}): VerificationEntry => ({
  key,
  type,
  primary: false,
  params,
});

const TASK_YAML = `summary: Find invoices billed twice by the same vendor
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file] # informational
answer:
  format: fenced_json
  path: duplicates
verification:
  # the primary key first
  - key: answer   # what the verdict is computed on
    type: json_match
    primary: true
    params:
      path: duplicates
      unordered: true # pairs in any order
    # a comment after the entry stays with the next one or is dropped
  - { key: reads_fixture, type: trajectory_match, params: { tool: read_file } }

  - key: method
    type: llm_judge
    params:
      rubric: |
        Did the agent
          explain its rule?
      pass_at: 0.7
`;

describe('verificationYamlSlices', () => {
  const entries = [
    entry('answer', 'json_match'),
    entry('reads_fixture', 'trajectory_match'),
    entry('method', 'llm_judge'),
  ];

  it('cuts each block entry from its dash, de-indented, with its comments', () => {
    const [answer] = verificationYamlSlices(TASK_YAML, entries);
    expect(answer).toBe(
      [
        '- key: answer   # what the verdict is computed on',
        '  type: json_match',
        '  primary: true',
        '  params:',
        '    path: duplicates',
        '    unordered: true # pairs in any order',
      ].join('\n'),
    );
  });

  it('keeps a flow entry as written and block scalars with their own indentation', () => {
    const [, flow, judge] = verificationYamlSlices(TASK_YAML, entries);
    expect(flow).toBe(
      '- { key: reads_fixture, type: trajectory_match, params: { tool: read_file } }',
    );
    expect(judge).toBe(
      [
        '- key: method',
        '  type: llm_judge',
        '  params:',
        '    rubric: |',
        '      Did the agent',
        '        explain its rule?',
        '    pass_at: 0.7',
      ].join('\n'),
    );
  });

  it('reads the sample task file as written on disk', () => {
    const text = `verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { path: total_due, abs: 0.01 }
`;
    expect(verificationYamlSlices(text, [entry('answer', 'numeric_tolerance')])).toEqual([
      '- key: answer\n  type: numeric_tolerance\n  primary: true\n  params: { path: total_due, abs: 0.01 }',
    ]);
  });

  it('cuts entries of a flow sequence', () => {
    const text = 'verification: [{ key: a, type: exact_match }, { key: b, type: json_match }]\n';
    expect(
      verificationYamlSlices(text, [entry('b', 'json_match'), entry('a', 'exact_match')]),
    ).toEqual(['{ key: b, type: json_match }', '{ key: a, type: exact_match }']);
  });

  it('writes the stored entry out when task.yaml is missing, unparseable or lacks the key', () => {
    const stored: VerificationEntry = {
      key: 'answer',
      type: 'json_match',
      primary: true,
      params: { path: 'duplicates', pass_at: 1 },
    };
    const expected =
      '- key: answer\n  type: json_match\n  primary: true\n  params:\n    path: duplicates\n    pass_at: 1';
    expect(verificationYamlSlices(null, [stored])).toEqual([expected]);
    expect(verificationYamlSlices('verification: [\n', [stored])).toEqual([expected]);
    expect(
      verificationYamlSlices(TASK_YAML.replace('key: answer', 'key: other'), [stored]),
    ).toEqual([expected]);
    expect(verificationYamlSlices(null, [entry('x', 'llm_judge')])).toEqual([
      '- key: x\n  type: llm_judge',
    ]);
  });
});

describe('answerPathOf', () => {
  it('reads answer.path, or nothing', () => {
    expect(answerPathOf(TASK_YAML)).toBe('duplicates');
    expect(answerPathOf('answer: { format: fenced_json }\n')).toBeUndefined();
    expect(answerPathOf(null)).toBeUndefined();
    expect(answerPathOf(': :\n  - [')).toBeUndefined();
  });
});
