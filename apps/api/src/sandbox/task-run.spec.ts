import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractAnswer } from '../scoring/extraction.js';
import { loadTaskFolder, toExtraction } from './task-run.js';

// Extraction and the answer scorers are tested in src/scoring; this harness only wires them.

describe('toExtraction', () => {
  it('keeps the shape the sandbox CLI prints', () => {
    const text = 'Done.\n```json\n{"total_due": 2.5}\n```\n';
    const found = toExtraction(extractAnswer(text));
    expect(found).toMatchObject({ ok: true, value: { total_due: 2.5 } });
    if (found.ok) expect(text.slice(found.start, found.end)).toBe('{"total_due": 2.5}');
    expect(toExtraction(extractAnswer('The total is 3.'))).toEqual({
      ok: false,
      reason: 'no fenced JSON block found in final response',
    });
    expect(toExtraction(extractAnswer('```json\n{"a": 1}\n'))).toEqual({
      ok: false,
      reason: 'the last ```json block is not closed',
    });
  });
});

describe('loadTaskFolder', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function task(
    name: string,
    options: { yamlParams: string; answerPath?: string; reference: string; type?: string },
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
        `  - { key: answer, type: ${options.type ?? 'numeric_tolerance'}, primary: true, params: ${options.yamlParams} }`,
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

  it('checks a json_match primary and refuses types it cannot check', async () => {
    const loaded = await loadTaskFolder(
      task('json', {
        type: 'json_match',
        yamlParams: '{ path: overdue, unordered: true }',
        reference: '{"overdue": ["INV-2", "INV-1"]}',
      }),
    );
    expect(loaded.primary).toMatchObject({
      type: 'json_match',
      params: { path: 'overdue', unordered: true, pass_at: 1 },
    });
    await expect(
      loadTaskFolder(
        task('file', {
          type: 'file_check',
          yamlParams: '{ path: summary.csv }',
          reference: '{}',
        }),
      ),
    ).rejects.toThrow(/does not check file_check yet/);
  });
});
