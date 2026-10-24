import { describe, expect, it } from 'vitest';
import { AnswerPathError, parseAnswerPath, resolveAnswerPath } from './answer-path.js';

describe('parseAnswerPath', () => {
  it('reads dotted keys and list indices', () => {
    expect(parseAnswerPath('total_due')).toEqual([{ key: 'total_due' }]);
    expect(parseAnswerPath('totals.vat')).toEqual([{ key: 'totals' }, { key: 'vat' }]);
    expect(parseAnswerPath('duplicates[0][1]')).toEqual([
      { key: 'duplicates' },
      { index: 0 },
      { index: 1 },
    ]);
    expect(parseAnswerPath('bands[2].net')).toEqual([
      { key: 'bands' },
      { index: 2 },
      { key: 'net' },
    ]);
    expect(parseAnswerPath('[0]')).toEqual([{ index: 0 }]);
    expect(parseAnswerPath('vendor name')).toEqual([{ key: 'vendor name' }]);
  });

  it.each(['', '.', 'a.', '.a', 'a..b', 'a[', 'a[x]', 'a[-1]', 'a]', 'a.[0]', '[0]a', 'a[0]b'])(
    'refuses %j',
    (path) => {
      expect(() => parseAnswerPath(path)).toThrow(AnswerPathError);
    },
  );
});

describe('resolveAnswerPath', () => {
  const value = {
    totals: { vat: 20 },
    duplicates: [['A', 'B']],
    items: [1, 2],
    zero: 0,
    nil: null,
  };

  it('returns the whole value without a path', () => {
    expect(resolveAnswerPath(value, undefined)).toEqual({ found: true, value });
  });

  it('finds nested keys, indices and falsy values', () => {
    expect(resolveAnswerPath(value, 'totals.vat')).toEqual({ found: true, value: 20 });
    expect(resolveAnswerPath(value, 'duplicates[0][1]')).toEqual({ found: true, value: 'B' });
    expect(resolveAnswerPath(value, 'zero')).toEqual({ found: true, value: 0 });
    expect(resolveAnswerPath(value, 'nil')).toEqual({ found: true, value: null });
    expect(resolveAnswerPath([{ a: 1 }], '[0].a')).toEqual({ found: true, value: 1 });
  });

  it('does not find what is not there, or the wrong kind of step', () => {
    expect(resolveAnswerPath(value, 'totals.net')).toEqual({ found: false });
    expect(resolveAnswerPath(value, 'items[2]')).toEqual({ found: false });
    // A key never indexes a list, an index never reads an object.
    expect(resolveAnswerPath(value, 'items.0')).toEqual({ found: false });
    expect(resolveAnswerPath({ a: { 0: 'x' } }, 'a[0]')).toEqual({ found: false });
    expect(resolveAnswerPath(value, 'zero.x')).toEqual({ found: false });
    expect(resolveAnswerPath(value, 'nil.x')).toEqual({ found: false });
    expect(resolveAnswerPath(value, 'toString')).toEqual({ found: false });
    expect(resolveAnswerPath('text', 'length')).toEqual({ found: false });
  });
});
