import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkPrimary, extractAnswer, loadTaskFolder } from './task-run.js';

const numeric = {
  key: 'answer',
  type: 'numeric_tolerance' as const,
  primary: true,
  params: { path: 'total_due', abs: 0.01 },
};
const block = (json: string) => `Done.\n\`\`\`json\n${json}\n\`\`\`\n`;

describe('extractAnswer', () => {
  it('takes the last fenced json block and reports its range', () => {
    const text =
      'Draft:\n```json\n{"total_due": 1}\n```\nFinal:\n```json\n{"total_due": 2.5}\n```\n';
    const answer = extractAnswer(text);
    expect(answer).toMatchObject({ ok: true, value: { total_due: 2.5 } });
    if (answer.ok)
      expect(text.slice(answer.start, answer.end)).toBe('```json\n{"total_due": 2.5}\n```');
  });

  it('reports a missing block and invalid JSON', () => {
    expect(extractAnswer('The total is 3.')).toMatchObject({ ok: false, reason: /no fenced JSON/ });
    expect(extractAnswer('```json\n{total: 3}\n```')).toMatchObject({
      ok: false,
      reason: /invalid JSON/,
    });
    expect(extractAnswer(null)).toMatchObject({ ok: false });
  });

  it('does not fall back to an earlier block when the last one is not closed', () => {
    const text =
      'Shape:\n```json\n{"total_due": 0.00}\n```\nAnswer:\n```json\n{"total_due": 99760.52}\n';
    expect(extractAnswer(text)).toMatchObject({ ok: false, reason: /not closed/ });
  });

  it('ignores a json fence quoted inside a longer fence', () => {
    const text =
      '```json\n{"total_due": 99760.52}\n```\nFor reference, the template was:\n' +
      '````markdown\n```json\n{"total_due": 0.00}\n```\n````\n';
    expect(extractAnswer(text)).toMatchObject({ ok: true, value: { total_due: 99760.52 } });
  });

  it('finds a fence indented inside a list item', () => {
    const text = '1. Total:\n\n    ```json\n    {"total_due": 5}\n    ```\n';
    expect(extractAnswer(text)).toMatchObject({ ok: true, value: { total_due: 5 } });
  });

  it('accepts tilde fences and CRLF line endings', () => {
    expect(extractAnswer('~~~json\r\n{"a": 1}\r\n~~~\r\n')).toMatchObject({
      ok: true,
      value: { a: 1 },
    });
  });
});

describe('checkPrimary', () => {
  const reference = { total_due: 99760.52 };
  const grade = (json: string) =>
    checkPrimary(numeric, extractAnswer(block(json)), reference).status;

  it('accepts exactly one cent either way and rejects more', () => {
    expect(grade('{"total_due": 99760.52}')).toBe('passed');
    expect(grade('{"total_due": 99760.53}')).toBe('passed');
    expect(grade('{"total_due": 99760.51}')).toBe('passed');
    expect(grade('{"total_due": 99760.50}')).toBe('failed');
    expect(grade('{"total_due": 185908.80}')).toBe('failed');
  });

  it('keeps the tolerance tight for large values', () => {
    const big = {
      key: 'answer',
      type: 'numeric_tolerance' as const,
      primary: true,
      params: { abs: 0.01 },
    };
    expect(checkPrimary(big, extractAnswer(block('1000000000.5')), 1e9).status).toBe('failed');
    expect(checkPrimary(big, extractAnswer(block('1000000000.01')), 1e9).status).toBe('passed');
  });

  it('coerces numeric strings and fails other values', () => {
    expect(grade('{"total_due": "99760.52"}')).toBe('passed');
    expect(grade('{"total_due": "about 99760"}')).toBe('failed');
    expect(grade('{"total_due": null}')).toBe('failed');
  });

  it('fails an answer without the key, and errors on a reference without it', () => {
    expect(grade('{"total": 99760.52}')).toBe('failed');
    expect(checkPrimary(numeric, extractAnswer(block('{"total_due": 1}')), {}).status).toBe(
      'error',
    );
  });

  it('checks exact matches without crashing on a missing key', () => {
    const exact = {
      key: 'ids',
      type: 'exact_match' as const,
      primary: true,
      params: { path: 'ids' },
    };
    const ref = { ids: 'A,B' };
    expect(checkPrimary(exact, extractAnswer(block('{"ids": " A,B "}')), ref).status).toBe(
      'passed',
    );
    expect(checkPrimary(exact, extractAnswer(block('{"ids": "a,b"}')), ref).status).toBe('failed');
    expect(checkPrimary(exact, extractAnswer(block('{"other": 1}')), ref).status).toBe('failed');
  });

  it('is ungradable without an answer block', () => {
    expect(checkPrimary(numeric, extractAnswer('no block'), reference).status).toBe('ungradable');
  });
});

describe('loadTaskFolder', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function task(
    name: string,
    options: { yamlParams: string; answerPath?: string; reference: string },
  ) {
    const dir = join(root, name);
    mkdirSync(join(dir, 'fixtures', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'invoices.csv'), 'a,b\n');
    writeFileSync(join(dir, 'fixtures', 'nested', 'rates.json'), '{}');
    writeFileSync(join(dir, 'prompt.md'), 'Answer in a fenced JSON block.');
    writeFileSync(join(dir, 'reference.json'), options.reference);
    writeFileSync(
      join(dir, 'task.yaml'),
      [
        'summary: s',
        'limits: { max_turns: 5, run_budget_seconds: 60, toolsets_needed: [file] }',
        `answer: { format: fenced_json${options.answerPath ? `, path: ${options.answerPath}` : ''} }`,
        'verification:',
        `  - { key: answer, type: numeric_tolerance, primary: true, params: ${options.yamlParams} }`,
        '  - { key: reads, type: trajectory_match, params: { tool: read_file } }',
      ].join('\n'),
    );
    return dir;
  }

  it('reads the task, its fixtures and its single primary key', async () => {
    const loaded = await loadTaskFolder(
      task('ok', { yamlParams: '{ path: total_due, abs: 0.01 }', reference: '{"total_due": 1}' }),
    );
    expect(loaded.fixtures.map((f) => f.path).sort()).toEqual([
      'invoices.csv',
      'nested/rates.json',
    ]);
    expect(loaded.primary.key).toBe('answer');
    expect(loaded.reference).toEqual({ total_due: 1 });
  });

  it("uses the answer's path when the key has none", async () => {
    const loaded = await loadTaskFolder(
      task('answer-path', {
        yamlParams: '{ abs: 0.01 }',
        answerPath: 'total_due',
        reference: '{"total_due": 1}',
      }),
    );
    expect(loaded.primary.params.path).toBe('total_due');
  });

  it('refuses invalid params and a reference that fails its own check', async () => {
    await expect(
      loadTaskFolder(
        task('quoted', {
          yamlParams: "{ path: total_due, abs: '0.01' }",
          reference: '{"total_due": 1}',
        }),
      ),
    ).rejects.toThrow(/invalid params/);
    await expect(
      loadTaskFolder(
        task('negative', {
          yamlParams: '{ path: total_due, abs: -1 }',
          reference: '{"total_due": 1}',
        }),
      ),
    ).rejects.toThrow(/invalid params/);
    await expect(
      loadTaskFolder(
        task('no-key', { yamlParams: '{ path: total_due, abs: 0.01 }', reference: '{"total": 1}' }),
      ),
    ).rejects.toThrow(/self-check failed/);
  });
});
