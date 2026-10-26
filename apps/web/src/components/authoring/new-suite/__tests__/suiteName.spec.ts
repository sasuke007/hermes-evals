import { describe, expect, it } from 'vitest';
import { folderLine, nameHolders, suiteNameProblem } from '../suiteName';

const suites = [
  { name: 'invoices-v1', path: './suites/invoices-v1', lastLoad: { outcome: 'unchanged' } },
  { name: 'zz-smoke-1', path: './suites/zz-smoke-1', lastLoad: { outcome: 'missing' } },
];
const drafts = [{ folder: 'vendor-statements-v1', path: './suites/vendor-statements-v1' }];

describe('a new suite name (SA.2)', () => {
  const holders = nameHolders(suites, drafts);

  it('is held by every suite on disk and every open draft; a missing folder releases it', () => {
    expect(holders.map((h) => [h.name, h.draft])).toEqual([
      ['invoices-v1', false],
      ['vendor-statements-v1', true],
    ]);
    expect(suiteNameProblem('zz-smoke-1', holders)).toBeNull();
  });

  it('must be a folder name and free', () => {
    expect(suiteNameProblem('', holders)).toEqual({ kind: 'empty' });
    expect(suiteNameProblem('Invoices v2', holders)).toEqual({ kind: 'invalid' });
    expect(suiteNameProblem('invoices-v1', holders)).toEqual({
      kind: 'taken',
      path: './suites/invoices-v1',
      draft: false,
    });
    expect(suiteNameProblem('vendor-statements-v1', holders)).toMatchObject({ draft: true });
    expect(suiteNameProblem('invoices-v2', holders)).toBeNull();
  });

  it('shows the folder it becomes, or the placeholder', () => {
    expect(folderLine('invoices-v2', true)).toBe('./suites/invoices-v2/');
    expect(folderLine('Invoices v2', false)).toBe('./suites/<name>/');
  });
});
