import { describe, expect, it } from 'vitest';
import type { ScorerType } from '@hermes-evals/shared';
import type { SuiteListRow, TextDiffLine } from '@/api/types/suites';
import { suiteListFixture } from '@/fixtures/suites';
import { diffFileRows } from '../diffFiles';
import { diffCaption, foldRows, sideBySide } from '../diffRows';
import {
  changePhrases,
  formatJson,
  keysText,
  lastLoadLine,
  reloadLine,
  taskFolderOf,
  taskVersionTitle,
  versionLabel,
} from '../suiteFormat';
import { sentenceSegments } from '../verificationSentence';

const values = (type: ScorerType, params: Record<string, never> | object, sentence: string) =>
  sentenceSegments({ type, params: params as never, sentence })
    .filter((s) => s.kind === 'value')
    .map((s) => s.text);

describe('VerificationSentence segments, for all eight check types', () => {
  it('json_match: the type, then the path in code', () => {
    const segs = sentenceSegments({
      type: 'json_match',
      params: { path: 'duplicates', unordered: true, pass_at: 1 },
      sentence: 'json_match on duplicates, unordered, pass at 1.0',
    });
    expect(segs).toEqual([
      { text: 'json_match', kind: 'type' },
      { text: ' on ', kind: 'text' },
      { text: 'duplicates', kind: 'value' },
      { text: ', unordered, pass at 1.0', kind: 'text' },
    ]);
  });

  it('numeric_tolerance names the answer path the API filled in', () => {
    expect(
      values(
        'numeric_tolerance',
        { abs: 0.01 },
        'numeric_tolerance on total_due, within ±0.01 of the reference',
      ),
    ).toEqual(['total_due']);
    expect(
      values(
        'numeric_tolerance',
        {},
        'numeric_tolerance on the whole answer, equal to the reference',
      ),
    ).toEqual([]);
  });

  it('exact_match', () => {
    expect(
      values(
        'exact_match',
        { path: 'missing_po', trim: true },
        'exact_match on missing_po, whitespace trimmed, case-sensitive',
      ),
    ).toEqual(['missing_po']);
  });

  it('file_check: the file and its columns', () => {
    expect(
      values(
        'file_check',
        { path: 'summary.csv', format: 'csv', columns: ['vendor', 'outstanding'], row_count: 5 },
        'file_check: summary.csv exists with columns vendor, outstanding; 5 rows',
      ),
    ).toEqual(['summary.csv', 'vendor', 'outstanding']);
  });

  it('trajectory_match: the tool and its argument, never inside another word', () => {
    expect(
      values(
        'trajectory_match',
        { tool: 'read_file', args: { path: 'invoices.csv' }, min_calls: 1 },
        'trajectory_match: calls read_file on invoices.csv at least once',
      ),
    ).toEqual(['read_file', 'invoices.csv']);
    // "file" is a value, but not inside "read_file" or "file_check".
    expect(
      values('trajectory_match', { tool: 'file' }, 'trajectory_match: calls file at least once'),
    ).toEqual(['file']);
  });

  it('verifier_script and llm_judge: the script, the rubric and the judge model', () => {
    expect(
      values(
        'verifier_script',
        { script: 'check_late_fees.py', timeout_s: 30 },
        'verifier_script check_late_fees.py returns score ≥ 1.0, timeout 30 s',
      ),
    ).toEqual(['check_late_fees.py']);
    expect(
      values(
        'llm_judge',
        { rubric: 'credit_method.md', model: 'mock/judge' },
        'llm_judge with rubric credit_method.md, pass at score ≥ 0.7, judged by mock/judge',
      ),
    ).toEqual(['credit_method.md', 'mock/judge']);
  });

  it('text_match: the quoted phrases and the pattern', () => {
    expect(
      values(
        'text_match',
        { path: 'rule', contains: ['1.5%', '30 days'], pattern: 'grace\\s+period' },
        'text_match on rule, contains "1.5%", "30 days", matches /grace\\s+period/',
      ),
    ).toEqual(['rule', '"1.5%"', '"30 days"', '/grace\\s+period/']);
  });
});

describe('side-by-side diff', () => {
  const lines: TextDiffLine[] = [
    { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'removed', text: 'settled when paid.', oldLine: 2, newLine: null },
    { kind: 'added', text: 'settled when paid. Others are due.', oldLine: null, newLine: 2 },
    { kind: 'added', text: 'new line', oldLine: null, newLine: 3 },
    { kind: 'same', text: 'z', oldLine: 3, newLine: 4 },
  ];

  it('pairs a changed line with its replacement and marks what differs', () => {
    const rows = sideBySide(lines);
    expect(rows).toHaveLength(4);
    expect(rows[1]!.left).toMatchObject({ n: 2, kind: 'removed' });
    expect(rows[1]!.right.parts).toEqual([
      { text: 'settled when paid.', marked: false },
      { text: ' Others are due.', marked: true },
    ]);
    expect(rows[2]).toMatchObject({
      left: { kind: 'empty', n: null },
      right: { n: 3, kind: 'added' },
    });
    expect(diffCaption(lines)).toBe('2 lines changed');
  });

  it('words a new file and plain additions', () => {
    const added = (n: number): TextDiffLine => ({
      kind: 'added',
      text: `l${n}`,
      oldLine: null,
      newLine: n,
    });
    expect(diffCaption([added(1), added(2)])).toBe('new file');
    expect(diffCaption([lines[0]!, added(2)])).toBe('1 line added');
  });

  it('folds long unchanged stretches, keeping three lines around a change', () => {
    const same = (n: number): TextDiffLine => ({
      kind: 'same',
      text: `l${n}`,
      oldLine: n,
      newLine: n,
    });
    const many: TextDiffLine[] = [
      ...Array.from({ length: 10 }, (_, i) => same(i + 1)),
      { kind: 'added', text: 'x', oldLine: null, newLine: 11 },
    ];
    const items = foldRows(sideBySide(many));
    expect(items[0]).toMatchObject({ kind: 'fold' });
    expect(items[0]!.kind === 'fold' && items[0]!.rows).toHaveLength(7);
    expect(items.filter((i) => i.kind === 'row')).toHaveLength(4);
  });
});

describe('suite wording', () => {
  const row = (state: Parameters<typeof suiteListFixture>[0]): SuiteListRow =>
    suiteListFixture(state)[0]!;

  it('words versions and folders', () => {
    expect(versionLabel(2, true)).toBe('v2 (reverted)');
    expect(taskFolderOf('./suites/invoices-v1/dup_invoices/task.yaml')).toBe(
      './suites/invoices-v1/dup_invoices/',
    );
  });

  it('puts what became invalid first, and counts a first load', () => {
    const phrases = changePhrases({
      added: [],
      removed: [],
      changed: ['late_fees'],
      nowInvalid: ['late_fees'],
      nowValid: [],
    });
    expect(phrases.map((p) => p.kind)).toEqual(['now invalid', 'changed']);
    expect(keysText({ kind: 'added', keys: Array.from({ length: 12 }, (_, i) => `t${i}`) })).toBe(
      '12 tasks',
    );
    expect(keysText({ kind: 'changed', keys: ['a', 'b', 'c', 'd'] })).toBe('a, b, c +1');
  });

  it('says how the last load went', () => {
    expect(lastLoadLine(row('v1'))).toEqual({ text: 'All self-checks passed', problem: false });
    expect(lastLoadLine(row('invalid-task'))).toEqual({
      text: 'Created v2 · 1 task now invalid',
      problem: true,
    });
    expect(lastLoadLine(row('reload-failed'))).toEqual({ text: 'Could not reload', problem: true });
    expect(lastLoadLine(row('reverted')).text).toBe('Reverted to v1 · late_fees valid again');
  });

  it('prefixes a created reload with its version', () => {
    expect(
      reloadLine({
        sourcePath: './suites/invoices-v1',
        name: 'invoices-v1',
        outcome: 'created',
        suiteId: 's',
        versionNumber: 6,
        changes: { added: [], removed: [], changed: [], nowInvalid: ['late_fees'], nowValid: [] },
        message: '1 task now invalid: late_fees',
        error: null,
      }),
    ).toEqual({ text: 'Created v6 · 1 task now invalid: late_fees', problem: true });
  });

  it('titles task versions', () => {
    const entry = {
      version: 2,
      contentHash: '',
      suiteId: '',
      introducedInSuiteVersion: 2,
      loadedAt: '',
      current: true,
    };
    expect(taskVersionTitle({ ...entry, changedFiles: [] }, true)).toBe('First version');
    expect(
      taskVersionTitle({ ...entry, changedFiles: ['fixtures/policy_terms.json'] }, false),
    ).toBe('Changed fixtures/policy_terms.json only');
    expect(
      taskVersionTitle({ ...entry, changedFiles: ['prompt.md', 'reference.json'] }, false),
    ).toBe('Changed prompt.md, reference.json');
  });

  it('prints reference.json with lists of plain values on one line', () => {
    expect(formatJson({ duplicates: [['INV-0988', 'INV-1131']], total: 1.5 })).toBe(
      '{\n  "duplicates": [\n    ["INV-0988", "INV-1131"]\n  ],\n  "total": 1.5\n}',
    );
  });
});

describe('diffFileRows: a side the loader never recorded (Phase 5b question 9)', () => {
  const notRecorded = {
    sizeBytes: null,
    sha256: null,
    notRecorded: 'loaded_before_phase_5b' as const,
  };
  const recorded = { sizeBytes: 47, sha256: 'ab'.repeat(32) };
  const rowsOf = (before: typeof recorded | typeof notRecorded, change: 'changed' | 'unchanged') =>
    diffFileRows({
      files: [
        { path: 'reference.json', change, before, after: change === 'changed' ? recorded : before },
      ],
      prompt: [],
      taskYaml: [],
      referenceChanged: change === 'changed',
      allAdded: false,
    }).find((r) => r.path === 'reference.json')!;

  it('says "not recorded" for the older side of a changed file', () => {
    expect(rowsOf(notRecorded, 'changed')).toEqual({
      path: 'reference.json',
      change: 'changed',
      size: 'not recorded → 47 B',
      from: 'not recorded',
      to: 'abababa',
    });
  });

  it('says "not recorded" for both size and hash of an unchanged file', () => {
    expect(rowsOf(notRecorded, 'unchanged')).toMatchObject({
      size: 'not recorded',
      from: null,
      to: 'not recorded',
    });
  });
});
