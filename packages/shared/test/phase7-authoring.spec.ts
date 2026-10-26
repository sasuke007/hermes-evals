/**
 * Phase 7's authoring contracts, the Phase 5b follow-ups (phase-5b.md
 * section 6.4): `self_check.answers_from_fixtures` (question 1), a zip's
 * root files and verify/ counts (2, 12), skill and document rows in use by
 * any version (8), "not recorded" in a task diff (9), an upload refused for
 * its size (11) and texts too large to edit (18).
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORING_LIMITS,
  DocumentRowSchema,
  DraftFileViewSchema,
  DraftRefusedUploadSchema,
  FILE_NOT_RECORDED_REASONS,
  isRecordedFileVersion,
  refusedUploadMessage,
  SkillDetailSchema,
  SkillRowSchema,
  SuiteZipValidationSchema,
  TaskDiffSchema,
  TaskFileChangeSchema,
  TaskFileVersionSchema,
  TaskFormSchema,
  TaskYamlSchema,
  type TaskForm,
} from '../src/index.js';

const hash = (c: string) => c.repeat(64);
const AT = '2026-10-26T16:31:00.000Z';

describe('self_check.answers_from_fixtures', () => {
  const task = {
    summary: 'Which invoices are past due?',
    limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
    answer: { format: 'fenced_json', path: 'overdue' },
    verification: [{ key: 'answer', type: 'json_match', primary: true, params: {} }],
  };

  it('is an optional flag of self_check, on its own or beside the expected folders', () => {
    const flagged = TaskYamlSchema.parse({ ...task, self_check: { answers_from_fixtures: true } });
    expect(flagged.self_check?.answers_from_fixtures).toBe(true);
    expect(TaskYamlSchema.parse(task).self_check).toBeUndefined();
    const both = {
      ...task,
      self_check: { expected_workspace: 'expected', answers_from_fixtures: false },
    };
    expect(TaskYamlSchema.parse(both).self_check?.answers_from_fixtures).toBe(false);
  });

  it('refuses another value or a misspelt key', () => {
    for (const self_check of [{ answers_from_fixtures: 'yes' }, { answer_from_fixtures: true }]) {
      expect(TaskYamlSchema.safeParse({ ...task, self_check }).success).toBe(false);
    }
  });

  it('is a form field the API sends and a form may leave out', () => {
    const form: TaskForm = {
      summary: 'Which invoices are past due?',
      maxTurns: 20,
      runBudgetSeconds: 300,
      toolsetsNeeded: ['file'],
      answerPath: 'overdue',
      checks: [{ key: 'answer', type: 'json_match', primary: true, params: {} }],
      expectedWorkspace: null,
      expectedHome: null,
      negativeControl: null,
    };
    expect(TaskFormSchema.parse(form)).not.toHaveProperty('answersFromFixtures');
    for (const value of [true, false, null]) {
      expect(
        TaskFormSchema.parse({ ...form, answersFromFixtures: value }).answersFromFixtures,
      ).toBe(value);
    }
    expect(TaskFormSchema.safeParse({ ...form, answers_from_fixtures: true }).success).toBe(false);
  });
});

describe('a zip: files left out at its root, and what is under verify/', () => {
  const zip = {
    token: 'zip-token',
    fileName: 'tools-v1.zip',
    sizeBytes: 1_200_000,
    outcome: 'valid',
    suite: { name: 'tools-v1', versionLabel: '0.1', description: null },
    nameTaken: null,
    tasks: [],
    scripts: [
      { path: 'reshape/verify/check.py', sizeBytes: 900, sha256: hash('a'), runByCheck: true },
      { path: 'stock/verify/check.py', sizeBytes: 800, sha256: hash('b'), runByCheck: true },
      {
        path: 'stock/verify/expected_stock.json',
        sizeBytes: 300,
        sha256: hash('c'),
        runByCheck: false,
      },
    ],
    verifyCounts: { files: 3, checkScripts: 2 },
    rootFilesNotKept: [
      { path: 'README.md', sizeBytes: 1_024 },
      { path: 'LICENSE', sizeBytes: 1_071 },
    ],
    fileCount: 120,
    unpackedBytes: 3_000_000,
    problems: [],
  };

  it('lists the root files the import will not keep', () => {
    expect(SuiteZipValidationSchema.parse(zip).rootFilesNotKept.map((f) => f.path)).toEqual([
      'README.md',
      'LICENSE',
    ]);
    const { rootFilesNotKept: _, ...withoutList } = zip;
    expect(SuiteZipValidationSchema.safeParse(withoutList).success).toBe(false);
  });

  it('counts the files under verify/ and, apart, the scripts a check runs', () => {
    expect(SuiteZipValidationSchema.parse(zip).verifyCounts).toEqual({ files: 3, checkScripts: 2 });
    const wrongFiles = { ...zip, verifyCounts: { files: 2, checkScripts: 2 } };
    const wrongScripts = { ...zip, verifyCounts: { files: 3, checkScripts: 3 } };
    for (const wrong of [wrongFiles, wrongScripts]) {
      expect(SuiteZipValidationSchema.safeParse(wrong).success).toBe(false);
    }
    const unmarked = {
      ...zip,
      scripts: zip.scripts.map((s) => ({ path: s.path, sizeBytes: s.sizeBytes, sha256: s.sha256 })),
    };
    expect(SuiteZipValidationSchema.safeParse(unmarked).success).toBe(false);
  });
});

describe('skills and documents named by any configuration version', () => {
  const link = { configurationId: '01JCFG', name: 'baseline' };
  const skill = {
    id: '01JSKILL',
    name: 'invoice-method',
    version: '1.0.0',
    description: 'How to read the ledger',
    contentHash: hash('d'),
    fileCount: 3,
    unpackedBytes: 4_096,
    uploadedAt: AT,
    usedBy: [],
    inUse: true,
    inUseBy: [link],
  };

  it('says whether any version names the resource, and which configurations', () => {
    expect(SkillRowSchema.parse(skill).inUseBy).toEqual([link]);
    expect(SkillRowSchema.parse({ ...skill, inUse: false, inUseBy: [] }).inUse).toBe(false);
    for (const wrong of [
      { ...skill, inUse: false },
      { ...skill, inUseBy: [] },
    ]) {
      expect(SkillRowSchema.safeParse(wrong).success).toBe(false);
    }
    const { inUse: _, ...without } = skill;
    expect(SkillRowSchema.safeParse(without).success).toBe(false);
  });

  it('holds on the skill detail and the document row too', () => {
    const detail = { ...skill, files: [], skillMd: { frontMatter: 'name: x', body: '' } };
    expect(SkillDetailSchema.parse(detail).inUse).toBe(true);
    expect(SkillDetailSchema.safeParse({ ...detail, inUse: false }).success).toBe(false);
    const document = {
      id: '01JDOC',
      filename: 'payment-terms.pdf',
      sizeBytes: 52_000,
      mediaType: 'application/pdf',
      typeLabel: 'PDF · 2 pages',
      sha256: hash('e'),
      uploadedAt: AT,
      attachedTo: [],
      inUse: false,
      inUseBy: [],
    };
    expect(DocumentRowSchema.parse(document).inUse).toBe(false);
    expect(DocumentRowSchema.safeParse({ ...document, inUseBy: [link] }).success).toBe(false);
  });
});

describe('a task diff of a version loaded before Phase 5b', () => {
  const notRecorded = { sizeBytes: null, sha256: null, notRecorded: 'loaded_before_phase_5b' };

  it('says reference.json was not recorded rather than leaving it out', () => {
    expect(FILE_NOT_RECORDED_REASONS).toEqual(['loaded_before_phase_5b']);
    const row = {
      path: 'reference.json',
      change: 'changed',
      before: notRecorded,
      after: { sizeBytes: 24, sha256: hash('f') },
    };
    expect(TaskFileChangeSchema.parse(row).before).toEqual(notRecorded);
    const diff = {
      key: 'total_due',
      from: { suiteId: '01JS1', suiteVersion: 1, taskVersion: 1 },
      to: { suiteId: '01JS2', suiteVersion: 2, taskVersion: 2 },
      prompt: [],
      taskYaml: [],
      reference: [],
      files: [row],
      textFiles: [],
    };
    expect(TaskDiffSchema.parse(diff).files[0]?.after).toEqual(row.after);
  });

  it('tells a recorded side from one not recorded', () => {
    const recorded = { sizeBytes: 24, sha256: hash('f') };
    expect(isRecordedFileVersion(recorded)).toBe(true);
    expect(isRecordedFileVersion(TaskFileVersionSchema.parse(notRecorded))).toBe(false);
    expect(isRecordedFileVersion(null)).toBe(false);
  });

  it('never has a half-recorded side, or a null one without its reason', () => {
    for (const side of [
      { sizeBytes: null, sha256: null },
      { sizeBytes: 24, sha256: null, notRecorded: 'loaded_before_phase_5b' },
      { sizeBytes: null, sha256: hash('f'), notRecorded: 'loaded_before_phase_5b' },
      { sizeBytes: null, sha256: null, notRecorded: 'unknown' },
    ]) {
      const row = { path: 'reference.json', change: 'changed', before: side, after: null };
      expect(TaskFileChangeSchema.safeParse(row).success, JSON.stringify(side)).toBe(false);
    }
  });
});

describe('an upload refused for its size', () => {
  const refused = {
    path: 'fixtures/ledger-2025.parquet',
    kind: 'fixture',
    sizeBytes: 32_715_571,
    limitBytes: AUTHORING_LIMITS.suiteMaxFileBytes,
    refusedAt: AT,
  };

  it('is kept on the draft task with where it would have gone', () => {
    expect(DraftRefusedUploadSchema.parse(refused)).toEqual(refused);
    expect(DraftRefusedUploadSchema.parse({ ...refused, sizeBytes: null }).sizeBytes).toBeNull();
    for (const wrong of [
      { ...refused, kind: 'verifier' },
      { ...refused, path: '' },
    ]) {
      expect(DraftRefusedUploadSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it('reads as the file_limits row the board draws', () => {
    expect(refusedUploadMessage(refused)).toBe('`ledger-2025.parquet` is over 25 MB.');
    expect(refusedUploadMessage({ path: 'notes.txt', limitBytes: 1.5 * 1024 * 1024 })).toBe(
      '`notes.txt` is over 1.5 MB.',
    );
  });
});

describe('a text too large to edit', () => {
  it('is an other file marked read-only', () => {
    const file = {
      path: 'prompt.md',
      kind: 'other',
      visibility: 'agent',
      agentPath: 'task.txt',
      sizeBytes: 1_300_000,
      sha256: hash('9'),
      typeLabel: 'Markdown · 1.3 MB',
      tooLargeToEdit: true,
    };
    expect(DraftFileViewSchema.parse(file).tooLargeToEdit).toBe(true);
    const { tooLargeToEdit: _, ...plain } = file;
    expect(DraftFileViewSchema.parse(plain)).not.toHaveProperty('tooLargeToEdit');
  });
});
