/**
 * The params rules task.yaml checks after each type's schema (task-yaml.ts
 * paramRuleIssues): a text_match pattern must compile, a trajectory_match
 * `max_calls` beside `mode` is reported as unused, and a trajectory_match
 * tool named like an MCP tool in a form Hermes never uses is a warning.
 */
import { LoadIssueSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { hermesMcpToolName } from '../../execution/stream-json.js';
import { checkTaskYaml, mcpToolNameProblem, paramRuleIssues } from './task-yaml.js';
import { parseYamlSource } from './yaml-source.js';

const taskYaml = (verification: string) => `summary: State the late-fee rule
limits: { max_turns: 10, run_budget_seconds: 120, toolsets_needed: [file] }
answer: { format: fenced_json, path: rule }
verification:
${verification}`;

function check(source: string) {
  const parsed = parseYamlSource('task.yaml', source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = checkTaskYaml(parsed.value, parsed.doc, parsed.lines);
  for (const issue of result.issues) LoadIssueSchema.parse(issue);
  return result;
}

describe('text_match patterns at load', () => {
  it('accepts a pattern that compiles, and gives the primary the answer path', () => {
    const result = check(
      taskYaml(`  - key: answer
    type: text_match
    primary: true
    params: { contains: ["1.5%", "30 days"], pattern: '\\d+ days' }
`),
    );
    expect(result.issues).toEqual([]);
    expect(result.verification[0]!.params).toEqual({
      contains: ['1.5%', '30 days'],
      pattern: '\\d+ days',
      path: 'rule',
    });
  });

  it('reports a pattern that does not compile as params_invalid, with the reason and the line', () => {
    const result = check(
      taskYaml(`  - key: answer
    type: text_match
    primary: true
    params:
      contains: ["1.5%"]
      pattern: "(per month"
`),
    );
    expect(result.issues).toEqual([
      {
        severity: 'error',
        code: 'params_invalid',
        key: 'answer',
        path: 'task.yaml#verification[0].params.pattern',
        message: 'answer: params.pattern: The pattern is not valid: unterminated group. (line 10)',
      },
    ]);
    // The entry is still listed, as declared.
    expect(result.verification.map((v) => v.key)).toEqual(['answer']);
  });

  it('compiles with the case rule of the key, and reports the schema rules too', () => {
    const result = check(
      taskYaml(`  - key: answer
    type: text_match
    primary: true
    params: { contains: [] }
  - key: escape
    type: text_match
    params: { pattern: 'a\\-b', case_sensitive: true }
`),
    );
    expect(result.issues.map((i) => [i.severity, i.key, i.path, i.message])).toEqual([
      [
        'error',
        'answer',
        'task.yaml#verification[0].params.contains',
        'answer: params.contains: Add at least one phrase or a pattern. (line 8)',
      ],
      [
        'error',
        'escape',
        'task.yaml#verification[1].params.pattern',
        'escape: params.pattern: The pattern is not valid: invalid escape. (line 11)',
      ],
    ]);
  });
});

describe('trajectory_match with a mode', () => {
  it('warns that max_calls is not used, and keeps the task loadable', () => {
    const result = check(
      taskYaml(`  - key: answer
    type: text_match
    primary: true
    params: { contains: ["1.5%"] }
  - key: reads
    type: trajectory_match
    params: { tool: read_file, mode: superset, max_calls: 3 }
`),
    );
    expect(result.issues).toEqual([
      {
        severity: 'warning',
        code: 'params_invalid',
        key: 'reads',
        path: 'task.yaml#verification[1].params.max_calls',
        message:
          'reads: params.max_calls: max_calls is not used with mode: superset; the trajectory is compared with min_calls calls of the tool (line 11)',
      },
    ]);
  });

  it('has nothing to say without a mode or without max_calls', () => {
    expect(paramRuleIssues('trajectory_match', { tool: 'x', min_calls: 1, max_calls: 2 })).toEqual(
      [],
    );
    expect(
      paramRuleIssues('trajectory_match', { tool: 'x', min_calls: 1, mode: 'strict' }),
    ).toEqual([]);
    expect(paramRuleIssues('exact_match', { trim: true, case_sensitive: true })).toEqual([]);
  });
});

describe('trajectory_match tools named like MCP tools', () => {
  it('warns on server.tool with the name Hermes gives that tool, and keeps the task loadable', () => {
    const result = check(
      taskYaml(`  - key: answer
    type: text_match
    primary: true
    params: { contains: ["1.5%"] }
  - key: lists
    type: trajectory_match
    params: { tool: invoice-db.list_invoices }
`),
    );
    expect(result.issues).toEqual([
      {
        severity: 'warning',
        code: 'params_invalid',
        key: 'lists',
        path: 'task.yaml#verification[1].params.tool',
        message:
          "lists: params.tool: invoice-db.list_invoices looks like MCP server invoice-db's tool list_invoices, which Hermes names mcp__invoice_db__list_invoices; no call is named invoice-db.list_invoices, so the key would always fail (line 11)",
      },
    ]);
    expect(result.verification.map((v) => v.key)).toEqual(['answer', 'lists']);
    expect(hermesMcpToolName('invoice-db', 'list_invoices')).toBe('mcp__invoice_db__list_invoices');
  });

  it('warns on mcp_ with one underscore, and on an mcp__ name Hermes would sanitize', () => {
    expect(mcpToolNameProblem('mcp_invoice_db_query')).toMatch(
      /^mcp_invoice_db_query looks like an MCP tool, but Hermes names MCP tools mcp__<server>__<tool>/,
    );
    expect(mcpToolNameProblem('mcp__invoice-db__get_invoice')).toBe(
      'mcp__invoice-db__get_invoice is not a name Hermes gives an MCP tool: it replaces every character outside A-Z, a-z, 0-9 and _ with _, so the tool is mcp__invoice_db__get_invoice',
    );
  });

  it('has nothing to say about Hermes names and built-in tools', () => {
    for (const tool of [
      hermesMcpToolName('invoice-db', 'get_invoice'),
      'mcp__ledger__read_rows',
      'read_file',
      'terminal',
      'mcpserver_tool',
    ]) {
      expect(mcpToolNameProblem(tool)).toBeNull();
    }
  });

  it('reports the name beside an unused max_calls, each at its own field', () => {
    const issues = paramRuleIssues('trajectory_match', {
      tool: 'mcp_ledger_rows',
      min_calls: 1,
      max_calls: 2,
      mode: 'superset',
    });
    expect(issues.map((i) => [i.severity, i.path])).toEqual([
      ['warning', ['tool']],
      ['warning', ['max_calls']],
    ]);
  });
});
