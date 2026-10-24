import { describe, expect, it } from 'vitest';
import { jsonDiff, sameJson, textDiff } from './diffs.js';
import { changedFiles, fileChanges, suiteChanges, type TaskContent } from './changes.js';

const HEX = (c: string) => c.repeat(64);

describe('textDiff', () => {
  it('numbers lines on each side and puts removals before additions', () => {
    const before =
      'Your directory has invoices.csv.\n\nAn invoice is settled when paid.\n\nAnswer.\n';
    const after =
      'Your directory has invoices.csv.\n\nAn invoice is settled only when paid in full.\n\nAnswer.\n';
    expect(textDiff(before, after)).toEqual([
      { kind: 'same', text: 'Your directory has invoices.csv.', oldLine: 1, newLine: 1 },
      { kind: 'same', text: '', oldLine: 2, newLine: 2 },
      { kind: 'removed', text: 'An invoice is settled when paid.', oldLine: 3, newLine: null },
      {
        kind: 'added',
        text: 'An invoice is settled only when paid in full.',
        oldLine: null,
        newLine: 3,
      },
      { kind: 'same', text: '', oldLine: 4, newLine: 4 },
      { kind: 'same', text: 'Answer.', oldLine: 5, newLine: 5 },
    ]);
  });

  it('handles added and removed tails, CRLF, and missing text', () => {
    expect(textDiff('a\r\nb', 'a\nb\nc\n')).toEqual([
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'same', text: 'b', oldLine: 2, newLine: 2 },
      { kind: 'added', text: 'c', oldLine: null, newLine: 3 },
    ]);
    expect(textDiff('a\nb', 'a')).toEqual([
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'removed', text: 'b', oldLine: 2, newLine: null },
    ]);
    expect(textDiff(null, 'x')).toEqual([{ kind: 'added', text: 'x', oldLine: null, newLine: 1 }]);
    expect(textDiff(null, null)).toEqual([]);
  });
});

describe('jsonDiff', () => {
  it('reports changed scalars by path', () => {
    expect(jsonDiff({ total_due: 48213.65 }, { total_due: 48526.05 })).toEqual([
      { path: 'total_due', kind: 'changed', before: 48213.65, after: 48526.05 },
    ]);
  });

  it('walks nested arrays with index paths', () => {
    const before = {
      duplicates: [
        ['INV-0988', 'INV-1131'],
        ['INV-1042', 'INV-1107'],
      ],
    };
    const after = {
      duplicates: [
        ['INV-0988', 'INV-1131'],
        ['INV-1043', 'INV-1107'],
        ['INV-2', 'INV-3'],
      ],
    };
    expect(jsonDiff(before, after)).toEqual([
      { path: 'duplicates[1][0]', kind: 'changed', before: 'INV-1042', after: 'INV-1043' },
      { path: 'duplicates[2]', kind: 'added', before: null, after: ['INV-2', 'INV-3'] },
    ]);
  });

  it('quotes keys that are not identifiers and reports added and removed keys', () => {
    expect(
      jsonDiff(
        { balances: { 'INV-1031': 310, 'INV-1054': 0 }, note: 'x' },
        { balances: { 'INV-1031': 310, 'INV-1066': 1412.5 }, extra: null },
      ),
    ).toEqual([
      { path: 'balances["INV-1054"]', kind: 'removed', before: 0, after: null },
      { path: 'balances["INV-1066"]', kind: 'added', before: null, after: 1412.5 },
      { path: 'note', kind: 'removed', before: 'x', after: null },
      { path: 'extra', kind: 'added', before: null, after: null },
    ]);
  });

  it('reports a change of kind whole, and the root as $', () => {
    expect(jsonDiff({ a: [1] }, { a: { b: 1 } })).toEqual([
      { path: 'a', kind: 'changed', before: [1], after: { b: 1 } },
    ]);
    expect(jsonDiff(1, '1')).toEqual([{ path: '$', kind: 'changed', before: 1, after: '1' }]);
    expect(jsonDiff({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
  });

  it('sameJson ignores key order but not array order', () => {
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('suiteChanges', () => {
  const t = (key: string, hash: string, valid = true) => ({ key, contentHash: HEX(hash), valid });

  it('lists every task as added on a first version, invalid ones as now invalid', () => {
    expect(suiteChanges(null, [t('a', '1'), t('b', '2', false)])).toEqual({
      added: ['a', 'b'],
      removed: [],
      changed: [],
      nowInvalid: ['b'],
      nowValid: [],
    });
  });

  it('compares content hashes and validity against the previous version', () => {
    const previous = [
      t('total_due', '1'),
      t('late_fees', '2'),
      t('gone', '3'),
      t('fixed', '4', false),
    ];
    const next = [t('total_due', '1'), t('late_fees', '5', false), t('fixed', '6'), t('new', '7')];
    expect(suiteChanges(previous, next)).toEqual({
      added: ['new'],
      removed: ['gone'],
      changed: ['late_fees', 'fixed'],
      nowInvalid: ['late_fees'],
      nowValid: ['fixed'],
    });
  });
});

describe('changedFiles and fileChanges', () => {
  const file = (path: string, c: string, size = 10) => ({ path, sha256: HEX(c), size });
  const v1: TaskContent = {
    prompt: 'Sum it.',
    taskYaml: 'summary: x\n',
    reference: { total_due: 1 },
    files: [file('fixtures/invoices.csv', 'a', 4198), file('verify/check.py', 'b')],
  };

  it('names prompt, reference and task.yaml first, then task files by path', () => {
    const v2: TaskContent = {
      prompt: 'Sum it all.',
      taskYaml: 'summary: x\n',
      reference: { total_due: 2 },
      files: [
        file('fixtures/invoices.csv', 'c', 4276),
        file('fixtures/rates.json', 'd'),
        file('verify/check.py', 'b'),
      ],
    };
    expect(changedFiles(v1, v2)).toEqual([
      'prompt.md',
      'reference.json',
      'fixtures/invoices.csv',
      'fixtures/rates.json',
    ]);
    expect(changedFiles(v1, { ...v1, reference: { total_due: 1 } })).toEqual([]);
  });

  it('marks each file added, removed, changed or unchanged with sizes and hashes', () => {
    expect(
      fileChanges(v1.files, [
        file('fixtures/invoices.csv', 'c', 4276),
        file('fixtures/new.csv', 'e', 5),
      ]),
    ).toEqual([
      {
        path: 'fixtures/invoices.csv',
        change: 'changed',
        before: { sizeBytes: 4198, sha256: HEX('a') },
        after: { sizeBytes: 4276, sha256: HEX('c') },
      },
      {
        path: 'fixtures/new.csv',
        change: 'added',
        before: null,
        after: { sizeBytes: 5, sha256: HEX('e') },
      },
      {
        path: 'verify/check.py',
        change: 'removed',
        before: { sizeBytes: 10, sha256: HEX('b') },
        after: null,
      },
    ]);
    expect(fileChanges(v1.files, v1.files).map((f) => f.change)).toEqual([
      'unchanged',
      'unchanged',
    ]);
  });
});
