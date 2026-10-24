import { SCORER_VERSIONS } from '../../scoring/registry.js';
import { checkHash, contentHash, sha256Hex } from './hashing.js';

const a = { path: 'suite.yaml', sha256: sha256Hex('a') };
const b = { path: 'task/prompt.md', sha256: sha256Hex('b') };

describe('contentHash', () => {
  it('does not depend on the order files were found in', () => {
    expect(contentHash([a, b])).toBe(contentHash([b, a]));
    expect(contentHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds each hash to its path', () => {
    const swapped = [
      { path: a.path, sha256: b.sha256 },
      { path: b.path, sha256: a.sha256 },
    ];
    expect(contentHash(swapped)).not.toBe(contentHash([a, b]));
    expect(contentHash([{ ...b, path: 'task/prompt2.md' }, a])).not.toBe(contentHash([a, b]));
  });

  it('cannot confuse a path with a separator', () => {
    // A naive "path sha\n" encoding would make these two lists equal.
    const tricky = [{ path: `x ${sha256Hex('1')}\ny`, sha256: sha256Hex('2') }];
    const plain = [
      { path: 'x', sha256: sha256Hex('1') },
      { path: 'y', sha256: sha256Hex('2') },
    ];
    expect(contentHash(tricky)).not.toBe(contentHash(plain));
  });

  it('is the hash of an empty list for a task with no files', () => {
    expect(contentHash([])).toBe(sha256Hex('[]'));
  });

  it('refuses a path hashed twice', () => {
    expect(() => contentHash([a, a])).toThrow(/hashed twice/);
  });
});

describe('checkHash', () => {
  const base = {
    loaderVersion: 1,
    scorerVersions: SCORER_VERSIONS,
    tasks: [
      { key: 'one', valid: true, selfCheckStatus: 'passed' },
      { key: 'two', valid: false, selfCheckStatus: 'failed' },
    ],
  };

  it('does not depend on task order', () => {
    expect(checkHash(base)).toBe(checkHash({ ...base, tasks: [...base.tasks].reverse() }));
  });

  it('changes with the loader version, any scorer version, validity or self-check status', () => {
    const hash = checkHash(base);
    expect(checkHash({ ...base, loaderVersion: 2 })).not.toBe(hash);
    expect(checkHash({ ...base, scorerVersions: { ...SCORER_VERSIONS, json_match: 2 } })).not.toBe(
      hash,
    );
    const flipped = base.tasks.map((t) => (t.key === 'two' ? { ...t, valid: true } : t));
    expect(checkHash({ ...base, tasks: flipped })).not.toBe(hash);
    const errored = base.tasks.map((t) =>
      t.key === 'two' ? { ...t, selfCheckStatus: 'error' } : t,
    );
    expect(checkHash({ ...base, tasks: errored })).not.toBe(hash);
  });
});
