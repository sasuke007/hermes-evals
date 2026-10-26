/**
 * The words of the Checks section (SA.7, SA.7a): each type's one-line sentence, the rule line
 * of an expanded card, default keys, what a change of type drops, the suggestion, and Try
 * it's result line and key-by-key rows.
 */
import { describe, expect, it } from 'vitest';
import type { TaskFormCheck, TryCheckResult } from '@/api/types/authoring';
import { changeType, checkSentence, defaultCheckKey, ruleLine, suggestion } from '../checkText';
import { detailRows, resultLine } from '../tryText';

const check = (
  type: TaskFormCheck['type'],
  params: TaskFormCheck['params'],
  primary = true,
): TaskFormCheck => ({
  key: 'answer',
  type,
  primary,
  params,
});

describe('a check in one line', () => {
  it.each([
    [check('numeric_tolerance', { abs: 0 }), 'overdue_count', 'on `overdue_count`, abs 0'],
    [
      check('json_match', { pass_at: 0.8 }),
      'overdue_by_vendor',
      'on `overdue_by_vendor`, pass at 0.8',
    ],
    [
      check('json_match', { path: 'duplicates', unordered: true }),
      null,
      'on `duplicates`, unordered, pass at 1.0',
    ],
    [
      check('exact_match', { path: 'top_vendor' }, false),
      null,
      'on `top_vendor`, trimmed, case-sensitive',
    ],
    [
      check('text_match', { path: 'rule', contains: ['1.5%', '30 days'] }),
      null,
      'on `rule`, contains "1.5%", "30 days"',
    ],
    [check('text_match', { path: 'rule' }), null, 'on `rule`, no phrases yet'],
    [
      check('file_check', {
        path: 'summary.csv',
        format: 'csv',
        columns: ['vendor_name', 'total_due'],
        row_count: 9,
      }),
      null,
      'on `summary.csv`, csv, 2 columns, 9 rows',
    ],
    [
      check(
        'trajectory_match',
        { tool: 'read_file', args: { path: 'invoices.csv' }, min_calls: 1 },
        false,
      ),
      null,
      'calls `read_file` with {path: invoices.csv}, at least once',
    ],
    [
      check('llm_judge', { rubric: 'rubric.md', pass_at: 0.7 }, false),
      null,
      'with `rubric.md`, pass at 0.7',
    ],
    [
      check('verifier_script', { script: 'check_summary.py' }, false),
      null,
      'runs `verify/check_summary.py`, pass at 1, timeout 30 s',
    ],
  ])('%#', (c, answerPath, sentence) => {
    expect(checkSentence(c, answerPath)).toBe(sentence);
  });
});

describe('the rule line', () => {
  it('restates each type with the reference value', () => {
    expect(ruleLine(check('numeric_tolerance', { abs: 0 }), 17)).toBe(
      'Passes when |answer − `17`| ≤ `0`. With neither tolerance: passes only when the numbers are equal. Scores 1 or 0.',
    );
    const vendors = { a: 3, b: 2, c: 4, d: 1, e: 7 };
    expect(ruleLine(check('json_match', { pass_at: 0.8 }), vendors)).toBe(
      'Scores the share of keys that match. Passes at 0.80 or above: here, 4 of the 5 keys.',
    );
    expect(ruleLine(check('json_match', {}), vendors)).toBe('Passes only when every key matches.');
    expect(ruleLine(check('json_match', { unordered: true }), [['a']])).toBe(
      'Passes only when every item matches, in any order.',
    );
    expect(ruleLine(check('exact_match', {}), 'x')).toBe(
      'Passes when the text equals the reference exactly, after trimming. Scores 1 or 0.',
    );
    expect(ruleLine(check('text_match', { contains: ['1.5%', '30 days'] }), 'x')).toBe(
      'Passes when the text contains "1.5%" and "30 days".',
    );
    expect(ruleLine(check('text_match', { contains: ['1.5%'], pass_at: 0.5 }), 'x')).toBe(
      'Scores the share of phrases found. Passes at 0.50 or above.',
    );
    expect(ruleLine(check('text_match', {}), 'x')).toBe(
      'Add a phrase or a pattern to see when this check passes.',
    );
    expect(
      ruleLine(
        check('file_check', {
          path: 'summary.csv',
          format: 'csv',
          columns: ['vendor_name', 'total_due'],
          row_count: 9,
        }),
        undefined,
      ),
    ).toBe(
      'Passes when `summary.csv` exists, is CSV, has columns `vendor_name`, `total_due` and 9 data rows.',
    );
    expect(
      ruleLine(
        check('trajectory_match', { tool: 'read_file', args: { path: 'invoices.csv' } }),
        undefined,
      ),
    ).toBe(
      'Passes when the run calls `read_file` with `{path: invoices.csv}` at least once. Scores 1 or 0.',
    );
    expect(ruleLine(check('llm_judge', {}), undefined)).toBe(
      'A model scores the final reply against this rubric, 0 to 1. Passes at `0.7` or above.',
    );
    expect(ruleLine(check('verifier_script', {}), undefined)).toBeNull();
  });
});

describe('keys, type changes and suggestions', () => {
  it('names new checks answer, file, tool_use, judge, script, then _2', () => {
    expect(defaultCheckKey('json_match', [])).toBe('answer');
    expect(defaultCheckKey('numeric_tolerance', ['answer'])).toBe('answer_2');
    expect(defaultCheckKey('trajectory_match', ['answer'])).toBe('tool_use');
    expect(defaultCheckKey('file_check', ['file', 'file_2'])).toBe('file_3');
  });

  it('keeps key, primary and path across answer types and lists what it drops', () => {
    const from = check('json_match', { path: 'overdue_by_vendor', pass_at: 0.8 });
    const { check: next, dropped } = changeType(from, 'exact_match');
    expect(next).toEqual({
      key: 'answer',
      type: 'exact_match',
      primary: true,
      params: { path: 'overdue_by_vendor' },
    });
    expect(dropped).toEqual(['share of keys']);
  });

  it('suggests from the reference value at the answer path', () => {
    expect(suggestion({ a: 1 }, 'overdue_by_vendor')).toEqual({
      type: 'json_match',
      reason: 'the reference at `overdue_by_vendor` is an object',
    });
    expect(suggestion(17, 'overdue_count')).toEqual({
      type: 'numeric_tolerance',
      reason: 'the reference at `overdue_count` is a number',
    });
    expect(suggestion(undefined, null)).toBeNull();
  });
});

describe('Try it', () => {
  const base: TryCheckResult = {
    key: 'answer',
    type: 'json_match',
    against: 'reply',
    extraction: { status: 'found', block: '{}', error: null },
    path: 'overdue_by_vendor',
    value: '{}',
    status: 'passed',
    score: 0.8,
    comment: '4 of 5 keys match',
    passAt: 0.8,
    evidence: {
      json_match: { unit: 'keys', matched: 4, total: 5, mismatches: ['Granite Office'] },
    },
    expected: { 'Fjord Software': 3, 'Granite Office': 2 },
    observed: { 'Fjord Software': 3, 'Granite Office': 3 },
  };

  it('reads "what was compared · score · status (needs threshold)"', () => {
    expect(resultLine(base)).toBe('4 of 5 keys match · score 0.80 · passed (needs 0.80)');
    expect(
      resultLine({
        ...base,
        type: 'numeric_tolerance',
        passAt: null,
        score: 1,
        comment: '|17 − 17| = 0 ≤ 0',
        evidence: null,
      }),
    ).toBe('|17 − 17| = 0 ≤ 0 · score 1 · passed');
    expect(
      resultLine({
        ...base,
        type: 'text_match',
        passAt: 1,
        score: 0.5,
        status: 'failed',
        comment: 'Found 1 of 2',
      }),
    ).toBe('Found 1 of 2 · score 0.50 · failed (needs 1.00)');
    expect(
      resultLine({
        ...base,
        score: null,
        status: 'ungradable',
        comment: 'No fenced json block found in the reply',
      }),
    ).toBe('No fenced json block found in the reply · no score · ungradable');
  });

  it('lists keys with their values, and mismatches with what was expected', () => {
    expect(detailRows(base)).toEqual({
      title: 'Key by key',
      rows: [
        { label: 'Fjord Software', ok: true, note: '3' },
        { label: 'Granite Office', ok: false, note: 'expected 2, got 3' },
      ],
    });
    const nested = detailRows({
      ...base,
      evidence: {
        json_match: { unit: 'keys', matched: 8, total: 9, mismatches: ['bands[2].net'] },
      },
      expected: { bands: [{}, {}, { net: 1840 }] },
      observed: { bands: [{}, {}, { net: 1804 }] },
    });
    expect(nested.title).toBe('Key by key · mismatches shown with their path');
    expect(nested.rows).toEqual([
      { label: 'bands[2].net', ok: false, note: 'expected 1840, got 1804' },
      { label: '8 other keys', ok: true, note: 'match' },
    ]);
  });
});
