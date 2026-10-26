/**
 * Try it (SA.7) without HTTP: each answer check type on the reference and
 * on pasted replies, the threshold shown where it can be fractional, and
 * the refusals for checks Try it cannot run.
 */
import { describe, expect, it } from 'vitest';
import { TryCheckResultSchema, type TryCheckResult } from '@hermes-evals/shared';
import { tryCheck, type TryRefusal } from './try-check.js';

const yaml = (checks: string, answerPath = '') => `summary: x
limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: [file] }
answer:
  format: fenced_json
${answerPath ? `  path: ${answerPath}\n` : ''}verification:
${checks}`;

const VENDORS = {
  'Fjord Software': 3,
  'Granite Office': 2,
  'Helios Energy': 4,
  'Cobalt Print Co': 1,
  'Nordlys Freight': 7,
};
const reference = JSON.stringify({
  overdue_by_vendor: VENDORS,
  rule: 'Invoices unpaid 30 days after the due date are charged a late fee of 1.5% per month.',
});

function run(checks: string, key: string, reply: string | null, answerPath = ''): TryCheckResult {
  const result = tryCheck({ taskYaml: yaml(checks, answerPath), reference }, { key, reply });
  return TryCheckResultSchema.parse(result);
}

const reply = (value: unknown, key = 'overdue_by_vendor') =>
  `Counted.\n\n\`\`\`json\n${JSON.stringify({ [key]: value })}\n\`\`\`\n`;

describe('tryCheck', () => {
  const json =
    '  - key: answer\n    type: json_match\n    primary: true\n    params: { pass_at: 0.8 }\n';

  it('scores JSON match key by key, with its threshold', () => {
    expect(run(json, 'answer', null, 'overdue_by_vendor')).toMatchObject({
      against: 'reference',
      status: 'passed',
      score: 1,
      passAt: 0.8,
      path: 'overdue_by_vendor',
    });
    const a = run(json, 'answer', reply({ ...VENDORS, 'Granite Office': 3 }), 'overdue_by_vendor');
    expect(a).toMatchObject({ status: 'passed', score: 0.8, passAt: 0.8, against: 'reply' });
    const b = run(
      json,
      'answer',
      reply({ ...VENDORS, 'Granite Office': 3, 'Nordlys Freight': 8 }),
      'overdue_by_vendor',
    );
    expect(b).toMatchObject({ status: 'failed', score: 0.6 });
    expect(b.comment).toMatch(/3 of 5 keys match/);
  });

  it('finds phrases with Text match', () => {
    const text =
      '  - key: late_fee_rule\n    type: text_match\n    primary: true\n    params: { path: rule, contains: ["1.5%", "30 days"] }\n';
    expect(run(text, 'late_fee_rule', null)).toMatchObject({
      status: 'passed',
      score: 1,
      passAt: 1,
    });
    const failed = run(
      text,
      'late_fee_rule',
      reply('A late fee of 1.5% per month applies.', 'rule'),
    );
    expect(failed).toMatchObject({
      status: 'failed',
      score: 0.5,
      value: '"A late fee of 1.5% per month applies."',
    });
  });

  it('reports a reply whose block is not valid JSON', () => {
    const result = run(
      json,
      'answer',
      'Here:\n\n```json\n{ "overdue_by_vendor": }\n```\n',
      'overdue_by_vendor',
    );
    expect(result).toMatchObject({
      status: 'ungradable',
      score: null,
      extraction: { status: 'invalid', block: '{ "overdue_by_vendor": }' },
    });
    expect(result.comment).toMatch(/^Invalid JSON/);
  });

  it('refuses checks it cannot run, a missing check and a reference that does not parse', () => {
    const tool =
      '  - key: reads\n    type: trajectory_match\n    primary: true\n    params: { tool: read_file }\n';
    const refused = tryCheck(
      { taskYaml: yaml(tool), reference },
      { key: 'reads', reply: null },
    ) as TryRefusal;
    expect(refused.status).toBe(422);
    expect(
      (tryCheck({ taskYaml: yaml(json), reference }, { key: 'nope', reply: null }) as TryRefusal)
        .status,
    ).toBe(404);
    expect(
      (
        tryCheck(
          { taskYaml: yaml(json), reference: '{' },
          { key: 'answer', reply: null },
        ) as TryRefusal
      ).status,
    ).toBe(422);
    expect(
      (
        tryCheck(
          { taskYaml: 'summary: [', reference },
          { key: 'answer', reply: null },
        ) as TryRefusal
      ).status,
    ).toBe(422);
  });

  it('answers error for settings the scorer cannot take', () => {
    const bad =
      '  - key: answer\n    type: numeric_tolerance\n    primary: true\n    params: { path: overdue_by_vendor, abs: -1 }\n';
    expect(run(bad, 'answer', null)).toMatchObject({ status: 'error', score: null });
  });
});
