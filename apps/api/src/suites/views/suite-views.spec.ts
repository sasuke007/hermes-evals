import { describe, expect, it } from 'vitest';
import {
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  type SuiteChanges,
} from '@hermes-evals/shared';
import {
  lastLoadView,
  loadErrorView,
  suiteDetail,
  suiteHistory,
  suiteListRow,
  verificationTypesByUse,
  versionOptions,
} from './suite-views.js';
import { T0, T1, T2, T3, hash, sourceRow, suiteRow } from './test-rows-spec.js';
import type { TaskState } from './changes.js';

const changes = (over: Partial<SuiteChanges> = {}): SuiteChanges => ({
  added: [],
  removed: [],
  changed: [],
  now_invalid: [],
  now_valid: [],
  ...over,
});

const state = (key: string, version: string, valid = true): TaskState => ({
  key,
  contentHash: hash(`${key} ${version}`),
  valid,
});

describe('loadErrorView', () => {
  it('reads numbered excerpt lines and highlights the error line', () => {
    const view = loadErrorView({
      file: 'vat_split/task.yaml',
      line: 14,
      column: 9,
      message: 'mapping values are not allowed here',
      excerpt: '13 |   - key: answer\n14 |     type: json_match: x\n15 |     primary: true\n',
    });
    expect(view.excerpt).toEqual([
      { line: 13, text: '  - key: answer', highlight: false },
      { line: 14, text: '    type: json_match: x', highlight: true },
      { line: 15, text: '    primary: true', highlight: false },
    ]);
    expect(view).toMatchObject({ file: 'vat_split/task.yaml', line: 14, column: 9 });
  });

  it("reads the loader's stored form: marked failing line, then the caret line", () => {
    const view = loadErrorView({
      file: 'vat_split/task.yaml',
      line: 14,
      column: 9,
      message: 'mapping values are not allowed here',
      excerpt: '   9 | verification:\n  13 |   - key: answer\n> 14 |     type: a: b\n        ^',
    });
    expect(view.excerpt).toEqual([
      { line: 9, text: 'verification:', highlight: false },
      { line: 13, text: '  - key: answer', highlight: false },
      { line: 14, text: '    type: a: b', highlight: true },
      { line: null, text: '        ^', highlight: false },
    ]);
  });

  it('counts lines back from a caret excerpt', () => {
    const view = loadErrorView({
      file: 'suite.yaml',
      line: 3,
      column: 7,
      message: 'bad indentation',
      excerpt: 'name: invoices-v1\ntasks:\n  - a: b: c\n      ^\n',
    });
    expect(view.excerpt).toEqual([
      { line: 1, text: 'name: invoices-v1', highlight: false },
      { line: 2, text: 'tasks:', highlight: false },
      { line: 3, text: '  - a: b: c', highlight: true },
      { line: null, text: '      ^', highlight: false },
    ]);
  });

  it('shows an absent excerpt as no lines', () => {
    expect(
      loadErrorView({ file: 'suite.yaml', line: null, column: null, message: 'x', excerpt: null })
        .excerpt,
    ).toEqual([]);
  });
});

describe('lastLoadView', () => {
  it('names the version still served after a failed reload', () => {
    const v1 = suiteRow(1);
    const view = lastLoadView(
      sourceRow(v1, {
        lastOutcome: 'error',
        lastAttemptedAt: T2,
        lastError: { file: 'suite.yaml', line: 1, column: 1, message: 'bad', excerpt: null },
      }),
      v1,
    );
    expect(view).toMatchObject({
      outcome: 'error',
      at: T2.toISOString(),
      servedVersion: { versionNumber: 1, contentHash: v1.contentHash, loadedAt: T0.toISOString() },
    });
    expect(view.error?.message).toBe('bad');
  });

  it('maps the stored change set to the view', () => {
    const v1 = suiteRow(1);
    const view = lastLoadView(
      sourceRow(v1, {
        lastOutcome: 'created',
        lastChanges: changes({ now_invalid: ['late_fees'] }),
      }),
      v1,
    );
    expect(view.changes).toEqual({
      added: [],
      removed: [],
      changed: [],
      nowInvalid: ['late_fees'],
      nowValid: [],
    });
    expect(view.servedVersion).toBeNull();
  });
});

describe('verificationTypesByUse', () => {
  it('orders types by how many entries use them, ties alphabetical', () => {
    const tasks = [
      { verification: [{ key: 'a', type: 'json_match' as const, primary: true, params: {} }] },
      {
        verification: [
          { key: 'a', type: 'numeric_tolerance' as const, primary: true, params: {} },
          { key: 'b', type: 'llm_judge' as const, primary: false, params: {} },
        ],
      },
      {
        verification: [
          { key: 'a', type: 'json_match' as const, primary: true, params: {} },
          { key: 'b', type: 'file_check' as const, primary: false, params: {} },
        ],
      },
    ];
    expect(verificationTypesByUse(tasks)).toEqual([
      'json_match',
      'file_check',
      'llm_judge',
      'numeric_tolerance',
    ]);
  });
});

describe('suiteListRow', () => {
  it('shows the current version at the time the last load confirmed it', () => {
    const v1 = suiteRow(1);
    const row = suiteListRow(v1, sourceRow(v1, { lastAttemptedAt: T1 }), []);
    expect(SuiteListRowSchema.parse(row)).toMatchObject({
      suiteId: v1.id,
      path: './suites/invoices-v1',
      loadedAt: T1.toISOString(),
      verificationTypes: [],
    });
  });

  it('keeps the version load time when the last load failed', () => {
    const v1 = suiteRow(1);
    const row = suiteListRow(
      v1,
      sourceRow(v1, {
        lastOutcome: 'error',
        lastAttemptedAt: T2,
        lastError: { file: 'suite.yaml', line: null, column: null, message: 'bad', excerpt: null },
      }),
      [],
    );
    expect(row.loadedAt).toBe(T0.toISOString());
    expect(row.lastLoad.at).toBe(T2.toISOString());
  });
});

describe('versionOptions', () => {
  it('lists the current version first, then the rest newest first', () => {
    const versions = [suiteRow(1), suiteRow(2, { loadedAt: T2 }), suiteRow(3, { loadedAt: T3 })];
    const options = versionOptions(versions, sourceRow(versions[2]!));
    expect(options.map((o) => [o.versionNumber, o.current, o.reverted])).toEqual([
      [3, true, false],
      [2, false, false],
      [1, false, false],
    ]);
  });

  it('marks a current version older than the newest as reverted, at the revert time', () => {
    const v1 = suiteRow(1);
    const v2 = suiteRow(2, { loadedAt: T2 });
    const options = versionOptions(
      [v1, v2],
      sourceRow(v1, { lastOutcome: 'reverted', lastAttemptedAt: T3 }),
    );
    expect(options).toEqual([
      expect.objectContaining({
        suiteId: v1.id,
        current: true,
        reverted: true,
        loadedAt: T3.toISOString(),
      }),
      expect.objectContaining({
        suiteId: v2.id,
        current: false,
        reverted: false,
        loadedAt: T2.toISOString(),
      }),
    ]);
  });
});

describe('suiteDetail', () => {
  it('describes an older version: not current, its own load time, the hash it replaced', () => {
    const v1 = suiteRow(1);
    const v2 = suiteRow(2, { loadedAt: T2 });
    const v3 = suiteRow(3, { loadedAt: T3 });
    const detail = suiteDetail({
      suite: v2,
      source: sourceRow(v3, { lastAttemptedAt: T3 }),
      versions: [v1, v2, v3],
      taskRows: [],
      verification: [],
    });
    expect(SuiteDetailSchema.parse(detail)).toMatchObject({
      suiteId: v2.id,
      current: false,
      loadedAt: T2.toISOString(),
      previousContentHash: v1.contentHash,
    });
    expect(detail.versions[0]!.suiteId).toBe(v3.id);
  });

  it('has no previous hash for a first version', () => {
    const v1 = suiteRow(1);
    const detail = suiteDetail({
      suite: v1,
      source: sourceRow(v1),
      versions: [v1],
      taskRows: [],
      verification: [],
    });
    expect(detail).toMatchObject({ current: true, previousContentHash: null });
  });
});

describe('suiteHistory', () => {
  const v1 = suiteRow(1);
  const v2 = suiteRow(2, { loadedAt: T2 });
  const tasksBySuite = new Map([
    [v1.id, [state('total_due', 'v1'), state('late_fees', 'v1')]],
    [v2.id, [state('total_due', 'v1'), state('late_fees', 'v2', false)]],
  ]);
  const none = new Map<string, { id: string; name: string }[]>();

  it('gives a first version every task as added', () => {
    const entries = suiteHistory({
      versions: [v1],
      source: sourceRow(v1, { lastOutcome: 'unchanged' }),
      tasksBySuite,
      experimentsBySuite: none,
    });
    expect(SuiteHistoryEntrySchema.array().parse(entries)).toEqual([
      expect.objectContaining({
        suiteId: v1.id,
        outcome: 'created',
        current: true,
        changes: {
          added: ['total_due', 'late_fees'],
          removed: [],
          changed: [],
          nowInvalid: [],
          nowValid: [],
        },
        sameFilesAs: null,
      }),
    ]);
  });

  it('lists versions newest first with changes against the version before', () => {
    const entries = suiteHistory({
      versions: [v2, v1],
      source: sourceRow(v2, { lastOutcome: 'unchanged' }),
      tasksBySuite,
      experimentsBySuite: new Map([[v1.id, [{ id: 'exp_1', name: 'Skill vs no skill' }]]]),
    });
    expect(entries.map((e) => [e.versionNumber, e.outcome, e.current])).toEqual([
      [2, 'created', true],
      [1, 'created', false],
    ]);
    expect(entries[0]!.changes).toEqual({
      added: [],
      removed: [],
      changed: ['late_fees'],
      nowInvalid: ['late_fees'],
      nowValid: [],
    });
    expect(entries[1]!.experiments).toEqual([{ id: 'exp_1', name: 'Skill vs no skill' }]);
  });

  it("uses the loader's own change set for the version the last load created", () => {
    const recorded = changes({
      changed: ['late_fees'],
      now_invalid: ['late_fees'],
      removed: ['old'],
    });
    const entries = suiteHistory({
      versions: [v1, v2],
      source: sourceRow(v2, { lastOutcome: 'created', lastChanges: recorded }),
      tasksBySuite,
      experimentsBySuite: none,
    });
    expect(entries[0]!.changes.removed).toEqual(['old']);
  });

  it('puts a reverted entry on top, current, with the changes back', () => {
    const entries = suiteHistory({
      versions: [v1, v2],
      source: sourceRow(v1, {
        lastOutcome: 'reverted',
        lastAttemptedAt: T3,
        lastChanges: changes({ changed: ['late_fees'], now_valid: ['late_fees'] }),
      }),
      tasksBySuite,
      experimentsBySuite: none,
    });
    expect(entries.map((e) => [e.versionNumber, e.outcome, e.current, e.loadedAt])).toEqual([
      [1, 'reverted', true, T3.toISOString()],
      [2, 'created', false, T2.toISOString()],
      [1, 'created', false, T0.toISOString()],
    ]);
    expect(entries[0]!.changes).toEqual({
      added: [],
      removed: [],
      changed: ['late_fees'],
      nowInvalid: [],
      nowValid: ['late_fees'],
    });
  });

  it('computes the revert changes when a later failed load replaced the record', () => {
    const entries = suiteHistory({
      versions: [v1, v2],
      source: sourceRow(v1, {
        lastOutcome: 'error',
        lastError: { file: 'suite.yaml', line: null, column: null, message: 'bad', excerpt: null },
      }),
      tasksBySuite,
      experimentsBySuite: none,
    });
    expect(entries[0]).toMatchObject({
      outcome: 'reverted',
      loadedAt: T0.toISOString(),
      changes: { changed: ['late_fees'], nowValid: ['late_fees'] },
    });
  });

  it('names the earlier version with the same files when only the checks differ', () => {
    const v2Same = suiteRow(2, { loadedAt: T2, contentHash: v1.contentHash });
    const entries = suiteHistory({
      versions: [v1, v2Same],
      source: sourceRow(v2Same),
      tasksBySuite,
      experimentsBySuite: none,
    });
    expect(entries.map((e) => e.sameFilesAs)).toEqual([1, null]);
  });
});
