import { noChanges, suiteChanges } from './changes.js';
import { createdMessage, errorMessage, revertedMessage, unchangedMessage } from './messages.js';
import { locatedError } from './yaml-source.js';

const tasks = (n: number, invalid: string[] = []) =>
  Array.from({ length: n }, (_, i) => `t${i}`)
    .concat(invalid)
    .map((key) => ({ key, valid: !invalid.includes(key) }));

describe('createdMessage', () => {
  it('counts the self-checks of a first version', () => {
    expect(
      createdMessage({ first: true, changes: noChanges(), tasks: tasks(12), sameFilesAs: null }),
    ).toBe('All 12 self-checks passed');
    expect(
      createdMessage({ first: true, changes: noChanges(), tasks: tasks(1), sameFilesAs: null }),
    ).toBe('The self-check passed');
    expect(
      createdMessage({ first: true, changes: noChanges(), tasks: [], sameFilesAs: null }),
    ).toBe('No tasks found');
  });

  it('names what changed and what became invalid', () => {
    const changes = { ...noChanges(), now_invalid: ['late_fees'] };
    expect(
      createdMessage({ first: true, changes, tasks: tasks(11, ['late_fees']), sameFilesAs: null }),
    ).toBe('1 task now invalid: late_fees');
    expect(
      createdMessage({
        first: false,
        changes: { ...noChanges(), changed: ['total_due'] },
        tasks: tasks(12),
        sameFilesAs: null,
      }),
    ).toBe('1 task changed: total_due · all self-checks passed');
    expect(
      createdMessage({
        first: false,
        changes: { ...noChanges(), added: ['a', 'b'], removed: ['c'], now_valid: ['d'] },
        tasks: tasks(3, ['e']),
        sameFilesAs: null,
      }),
    ).toBe('2 tasks added: a, b · 1 task removed: c · d valid again · 1 task still invalid: e');
  });

  it('says when only the check changed', () => {
    expect(
      createdMessage({ first: false, changes: noChanges(), tasks: tasks(3), sameFilesAs: 4 }),
    ).toBe('Same files as v4, re-checked · all self-checks passed');
  });

  it('shortens long key lists', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(
      createdMessage({
        first: false,
        changes: { ...noChanges(), changed: keys },
        tasks: tasks(7),
        sameFilesAs: null,
      }),
    ).toBe('7 tasks changed: a, b, c, d, e and 2 more · all self-checks passed');
  });
});

describe('other outcomes', () => {
  it('words unchanged, reverted and error results', () => {
    expect(unchangedMessage(3)).toBe('Unchanged since v3');
    expect(revertedMessage(2, noChanges())).toBe('Reverted to v2');
    expect(revertedMessage(1, { ...noChanges(), now_valid: ['late_fees'] })).toBe(
      'Reverted to v1 · late_fees valid again',
    );
    expect(
      errorMessage(locatedError('suite.yaml', 'a\nb: [\n', { line: 2, column: 4 }, 'bad')),
    ).toBe('Could not reload: suite.yaml:2:4 · bad');
    expect(errorMessage(locatedError('suite.yaml', '', null, 'suite.yaml not found'))).toBe(
      'Could not reload: suite.yaml not found',
    );
  });
});

describe('suiteChanges', () => {
  const state = (key: string, contentHash: string, valid = true) => ({ key, contentHash, valid });

  it('lists every task of a first version as added, and invalid ones as now invalid', () => {
    expect(suiteChanges(null, [state('a', 'x'), state('b', 'y', false)])).toEqual({
      added: ['a', 'b'],
      removed: [],
      changed: [],
      now_invalid: ['b'],
      now_valid: [],
    });
  });

  it('compares content hashes and validity against the previous version', () => {
    const before = [state('a', 'x'), state('b', 'y', false), state('c', 'z')];
    const after = [state('a', 'x2', false), state('b', 'y'), state('d', 'w')];
    expect(suiteChanges(before, after)).toEqual({
      added: ['d'],
      removed: ['c'],
      changed: ['a'],
      now_invalid: ['a'],
      now_valid: ['b'],
    });
  });
});
