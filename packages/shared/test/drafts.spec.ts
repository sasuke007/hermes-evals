/**
 * The suite draft's contracts (plan 4.6; SA.1 to SA.3, SA.11, SA.12): create
 * and edit a draft, add tasks, review, save with its 409 and 422, rebase.
 * Samples are the boards' own: invoices-v1 based on v6 with overdue_count
 * added, total_due changed and the label 0.3 → 0.4.
 */
import { describe, expect, it } from 'vitest';
import {
  CreateDraftTaskRequestSchema,
  CreateSuiteDraftRequestSchema,
  DIRECTORY_KEY_MESSAGE,
  DRAFT_CHANGE_KINDS,
  DraftConflictBodySchema,
  DraftReviewSchema,
  DraftSaveFailureBodySchema,
  DraftSaveResultSchema,
  DraftSummarySchema,
  DraftTaskCreateResultSchema,
  RebaseSuiteDraftRequestSchema,
  SAVE_STEPS,
  SaveSuiteDraftRequestSchema,
  SuiteDraftViewSchema,
  UpdateSuiteDraftRequestSchema,
  type DraftConflict,
  type SuiteDraftView,
} from '../src/index.js';

const hash = (c: string) => c.repeat(64);
const AT = '2026-10-26T16:31:00.000Z';
const NO_CHANGES = { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] };

const ref = (versionNumber: number, label = '0.3') => ({
  suiteId: `suite-v${versionNumber}`,
  name: 'invoices-v1',
  versionNumber,
  versionLabel: label,
  contentHash: hash(String(versionNumber % 10)),
});

const row = (key: string, state: string, baseVersion: number | null) => ({
  key,
  position: 0,
  state,
  summary: 'Count invoices past due as of 1 Oct 2026',
  verificationTypes: ['numeric_tolerance'],
  fixtureCount: 1,
  baseVersion,
  restoredFrom: null,
  readiness: 'ready',
  updatedAt: AT,
});

const DRAFT: SuiteDraftView = SuiteDraftViewSchema.parse({
  id: 'draft-1',
  folder: 'invoices-v1',
  path: './suites/invoices-v1',
  name: 'invoices-v1',
  origin: 'edit',
  base: ref(6),
  nextVersion: 7,
  versionLabel: '0.4',
  description: 'Accounts-payable questions over one ledger export.',
  changes: [
    { kind: 'added', key: 'overdue_count', renamedFrom: null },
    { kind: 'changed', key: 'total_due' },
    { kind: 'label', from: '0.3', to: '0.4' },
  ],
  tasks: [
    row('total_due', 'changed', 2),
    { ...row('overdue_count', 'added', null), position: 1 },
    { ...row('currency_mix', 'removed', 2), position: 2 },
  ],
  problems: [],
  conflict: null,
  saving: null,
  revision: 12,
  createdAt: AT,
  updatedAt: AT,
});

const CONFLICT: DraftConflict = {
  cause: 'version_moved',
  baseVersion: 6,
  current: { ...ref(7), loadedAt: '2026-10-26T16:40:00.000Z' },
  diskChanges: { ...NO_CHANGES, changed: ['late_fees'], nowValid: ['late_fees'] },
  draftKeys: ['overdue_count', 'total_due'],
  overlap: [],
};

describe('creating a draft (SA.2, SA.10)', () => {
  const body = { name: 'vendor-statements-v1', versionLabel: '0.1', from: { kind: 'empty' } };

  it('starts empty, as a copy of a suite version, or from a validated zip', () => {
    expect(CreateSuiteDraftRequestSchema.parse(body).from.kind).toBe('empty');
    const copy = { ...body, from: { kind: 'copy', suite: 'invoices-v1', versionNumber: 6 } };
    expect(CreateSuiteDraftRequestSchema.parse(copy).from).toMatchObject({ suite: 'invoices-v1' });
    const zip = { ...body, from: { kind: 'zip', token: 'tok', trustScripts: true } };
    expect(CreateSuiteDraftRequestSchema.parse(zip).from).toMatchObject({ trustScripts: true });
    expect(
      CreateSuiteDraftRequestSchema.safeParse({ ...body, from: { kind: 'zip', token: 'tok' } })
        .success,
    ).toBe(false);
    expect(
      CreateSuiteDraftRequestSchema.safeParse({ ...body, from: { kind: 'blank' } }).success,
    ).toBe(false);
  });

  it('refuses a name that is not a folder name and an empty label, in the form’s words', () => {
    const name = CreateSuiteDraftRequestSchema.safeParse({ ...body, name: 'Invoices v2' });
    expect(name.error?.issues[0]?.message).toBe(DIRECTORY_KEY_MESSAGE);
    const label = CreateSuiteDraftRequestSchema.safeParse({ ...body, versionLabel: '  ' });
    expect(label.error?.issues[0]?.message).toBe('Add a version label.');
  });
});

describe('editing a draft (SA.3)', () => {
  it('stores an empty label, which blocks review, and refuses a key twice in the order', () => {
    expect(UpdateSuiteDraftRequestSchema.parse({ versionLabel: '' }).versionLabel).toBe('');
    expect(
      UpdateSuiteDraftRequestSchema.safeParse({ order: ['total_due', 'total_due'] }).success,
    ).toBe(false);
    expect(UpdateSuiteDraftRequestSchema.safeParse({ name: 'renamed' }).success).toBe(false);
  });

  it('adds a blank, duplicated, restored or copied task', () => {
    const kinds = [
      { kind: 'blank' },
      { kind: 'duplicate', from: 'total_due' },
      { kind: 'restore', suiteVersion: 1, key: 'total_due' },
      { kind: 'copy', suite: 'invoices-v1', keys: ['total_due', 'late_fees'] },
    ];
    for (const body of kinds)
      expect(CreateDraftTaskRequestSchema.safeParse(body).success).toBe(true);
    expect(
      CreateDraftTaskRequestSchema.safeParse({ kind: 'copy', suite: 'invoices-v1', keys: [] })
        .success,
    ).toBe(false);
    expect(
      CreateDraftTaskRequestSchema.safeParse({ kind: 'blank', key: 'overdue 90' }).success,
    ).toBe(false);
    const result = DraftTaskCreateResultSchema.parse({ keys: ['new_task'], draft: DRAFT });
    expect(result.draft.nextVersion).toBe(7);
  });

  it('lists every change kind of the plan, and a restored task names its versions', () => {
    expect(DRAFT_CHANGE_KINDS).toEqual([
      'added',
      'changed',
      'removed',
      'restored',
      'label',
      'description',
      'order',
    ]);
    const restored = SuiteDraftViewSchema.parse({
      ...DRAFT,
      changes: [{ kind: 'restored', key: 'total_due', fromTaskVersion: 1, fromSuiteVersion: 1 }],
      tasks: [
        { ...row('total_due', 'restored', 2), restoredFrom: { taskVersion: 1, suiteVersion: 1 } },
      ],
    });
    expect(restored.tasks[0]?.restoredFrom).toEqual({ taskVersion: 1, suiteVersion: 1 });
  });

  it('summarises a draft for the suite list chip', () => {
    const summary = DraftSummarySchema.parse({
      id: 'draft-1',
      folder: 'invoices-v1',
      path: './suites/invoices-v1',
      name: 'invoices-v1',
      origin: 'edit',
      baseVersion: 6,
      changeCount: 3,
      taskCount: 13,
      conflict: false,
      updatedAt: AT,
    });
    expect(summary.changeCount).toBe(3);
  });

  it('carries a new suite without a base, its suite-level problems and a save in progress', () => {
    const fresh = SuiteDraftViewSchema.parse({
      ...DRAFT,
      origin: 'empty',
      base: null,
      nextVersion: 1,
      changes: [],
      tasks: [],
      problems: [{ code: 'no_tasks', message: 'Add at least one task to save v1.' }],
      saving: { startedAt: AT, step: 'self_checks', selfChecks: { done: 1, total: 2 } },
    });
    expect(fresh.problems[0]?.code).toBe('no_tasks');
    expect(SAVE_STEPS).toEqual(['staging', 'loading', 'self_checks', 'moving']);
  });
});

describe('review and save (SA.11)', () => {
  it('describes what is written and which tasks would be invalid', () => {
    const review = DraftReviewSchema.parse({
      draft: DRAFT,
      changes: [
        {
          change: { kind: 'added', key: 'overdue_count', renamedFrom: null },
          detail: 'new task · 4 files · 1 check',
        },
        { change: { kind: 'label', from: '0.3', to: '0.4' }, detail: 'suite.yaml label 0.3 → 0.4' },
      ],
      writes: [
        {
          op: 'add',
          path: './suites/invoices-v1/overdue_count/prompt.md',
          beforeBytes: null,
          afterBytes: 346,
          note: null,
        },
        {
          op: 'change',
          path: './suites/invoices-v1/suite.yaml',
          beforeBytes: 210,
          afterBytes: 236,
          note: 'version_label 0.3 → 0.4 · tasks + overdue_count',
        },
      ],
      readiness: [
        {
          key: 'overdue_count',
          state: 'added',
          readiness: 'problems',
          note: 'self-check failed',
        },
      ],
      invalid: [{ key: 'overdue_count', reason: 'self-check failed' }],
    });
    expect(review.invalid).toHaveLength(1);
  });

  it('saves with the reviewed revision and reports the new version', () => {
    expect(SaveSuiteDraftRequestSchema.parse({ versionLabel: '0.4', revision: 12 })).toEqual({
      versionLabel: '0.4',
      revision: 12,
    });
    expect(SaveSuiteDraftRequestSchema.safeParse({ versionLabel: '' }).success).toBe(false);
    const saved = DraftSaveResultSchema.parse({
      outcome: 'created',
      suite: ref(7, '0.4'),
      changes: { ...NO_CHANGES, added: ['overdue_count'], changed: ['total_due'] },
      taskCount: 13,
      validCount: 12,
      invalid: [{ key: 'overdue_count', reason: 'self-check failed' }],
    });
    expect(saved.suite.versionNumber).toBe(7);
    expect(DraftSaveResultSchema.safeParse({ ...saved, outcome: 'error' }).success).toBe(false);
  });

  it('answers 409 with the version to combine onto and the overlapping tasks', () => {
    const body = DraftConflictBodySchema.parse({
      statusCode: 409,
      message: './suites/invoices-v1 changed on disk after this draft began.',
      conflict: { ...CONFLICT, overlap: ['total_due'] },
    });
    expect(body.conflict.current.versionNumber).toBe(7);
    expect(DraftConflictBodySchema.safeParse({ ...body, statusCode: 422 }).success).toBe(false);
    expect(SuiteDraftViewSchema.parse({ ...DRAFT, conflict: CONFLICT }).conflict?.cause).toBe(
      'version_moved',
    );
  });

  it('answers 422 with the loader’s located error when staging fails', () => {
    const body = DraftSaveFailureBodySchema.parse({
      statusCode: 422,
      message: 'Not saved. Nothing on disk changed. Your draft is kept.',
      step: 'loading',
      error: {
        file: 'overdue_count/task.yaml',
        line: 9,
        column: 7,
        message: 'unknown key prmary',
        excerpt: [{ line: 9, text: '    prmary: true', highlight: true }],
      },
    });
    expect(body.error.line).toBe(9);
  });

  it('combines onto a version with one choice per overlapping task', () => {
    const body = RebaseSuiteDraftRequestSchema.parse({
      onto: 7,
      choices: [{ key: 'total_due', keep: 'mine' }],
    });
    expect(body.choices[0]?.keep).toBe('mine');
    expect(
      RebaseSuiteDraftRequestSchema.safeParse({
        onto: 7,
        choices: [
          { key: 'total_due', keep: 'mine' },
          { key: 'total_due', keep: 'disk' },
        ],
      }).success,
    ).toBe(false);
  });
});
