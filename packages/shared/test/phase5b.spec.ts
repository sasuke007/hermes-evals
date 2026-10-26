/**
 * Phase 5b's other contracts: the CSV/JSONL and zip imports (SA.9, SA.10),
 * the per-directory reload progress (Phase 4 question 9), and the follow-ups
 * of Phase 5 section 6.4 that change a view (the configuration usage's task
 * count and Δ, the MCP reference's names, the test's definition hash, the
 * resource delete's 409, the suite list's current changes, the task diff's
 * text files, and the task's experiments across versions).
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigurationUsageSchema,
  McpServerRefSchema,
  McpTestViewSchema,
  ResourceInUseBodySchema,
  SUITE_RELOAD_STATES,
  SuiteListRowSchema,
  SuiteReloadProgressSchema,
  SuiteZipImportRequestSchema,
  SuiteZipValidationSchema,
  TASK_IMPORT_COLUMN_USE_LABELS,
  TaskDiffSchema,
  TaskExperimentUsageSchema,
  TaskImportRefusalBodySchema,
  TaskImportSettingsSchema,
  TaskImportValidationSchema,
  type TaskImportSettings,
} from '../src/index.js';

const hash = (c: string) => c.repeat(64);
const AT = '2026-10-26T16:31:00.000Z';
const NO_CHANGES = { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] };

const SETTINGS: TaskImportSettings = {
  mapping: [
    { column: 'key', use: 'task_key' },
    { column: 'question', use: 'prompt' },
    { column: 'expected', use: 'reference_value' },
  ],
  keyPrefix: null,
  answerPath: 'answer',
  workspace: { from: 'task', key: 'total_due' },
  checks: {
    from: 'new',
    checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
  },
  limits: { maxTurns: 20, runBudgetSeconds: 300, toolsetsNeeded: ['file', 'terminal'] },
  appendAnswerInstructions: true,
  keyFixes: [{ row: 4, key: 'overdue_90' }],
};

describe('tasks from CSV or JSONL (SA.9)', () => {
  it('maps columns as ColumnMapper offers them', () => {
    expect(Object.values(TASK_IMPORT_COLUMN_USE_LABELS)).toEqual([
      'Task key',
      'Summary',
      'Prompt',
      'Reference (whole JSON)',
      'Reference value at the answer path',
      'Ignore',
    ]);
    expect(TaskImportSettingsSchema.parse(SETTINGS).keyFixes).toHaveLength(1);
    const twice = { ...SETTINGS, mapping: [...SETTINGS.mapping, { column: 'key', use: 'ignore' }] };
    expect(TaskImportSettingsSchema.safeParse(twice).success).toBe(false);
    const badFix = { ...SETTINGS, keyFixes: [{ row: 4, key: 'overdue 90' }] };
    expect(TaskImportSettingsSchema.safeParse(badFix).success).toBe(false);
    const noChecks = { ...SETTINGS, checks: { from: 'new', checks: [] } };
    expect(TaskImportSettingsSchema.safeParse(noChecks).success).toBe(false);
  });

  it('previews the rows, with a row that needs a fix, and refuses the import while it does', () => {
    const preview = {
      rows: [
        {
          row: 1,
          key: 'overdue_fjord',
          summary: 'How many overdue invoices does Fjord Software have?',
          referenceValue: '3',
          readiness: 'ready',
          problems: [],
          needsFix: false,
        },
        {
          row: 4,
          key: 'overdue 90',
          summary: 'How many invoices are more than 90 days overdue?',
          referenceValue: '1',
          readiness: 'problems',
          problems: [
            {
              field: 'key',
              message: 'Row 4: key overdue 90 has a space. Use letters, digits, ., _ and -.',
            },
          ],
          needsFix: true,
        },
      ],
      addCount: 6,
      fixCount: 1,
      messages: [
        {
          severity: 'info',
          message:
            'No column is mapped to Summary. Summaries are taken from the first 80 characters of each prompt.',
        },
      ],
    };
    const validation = TaskImportValidationSchema.parse({
      file: {
        fileName: 'overdue_questions.csv',
        format: 'csv',
        sizeBytes: 410,
        rowCount: 6,
        columns: [
          { name: 'key', samples: ['overdue_fjord', 'overdue_granite', 'overdue_over_5000'] },
        ],
      },
      problems: [],
      preview,
    });
    expect(validation.preview?.fixCount).toBe(1);
    const refused = TaskImportRefusalBodySchema.parse({
      statusCode: 422,
      message: '1 row needs a fix',
      preview,
    });
    expect(refused.preview.rows[1]?.needsFix).toBe(true);
    const tooMany = TaskImportValidationSchema.parse({
      file: null,
      problems: [
        { title: 'all_questions.csv', detail: '1,240 rows. The limit is 500 per import.' },
      ],
      preview: null,
    });
    expect(tooMany.problems).toHaveLength(1);
  });
});

const ZIP = {
  token: 'zip-token',
  fileName: 'invoices-v1-v6.zip',
  sizeBytes: 70_042,
  outcome: 'valid',
  suite: { name: 'invoices-v1', versionLabel: '0.3', description: null },
  nameTaken: null,
  tasks: [
    {
      key: 'late_fees',
      summary: 'Compute late fees under the vendor-policy-v3 terms',
      readiness: 'not_run',
      problem: null,
      workspaceFiles: 2,
      checks: 2,
    },
  ],
  scripts: [
    {
      path: 'late_fees/verify/check_late_fees.py',
      sizeBytes: 2458,
      sha256: hash('e'),
      runByCheck: true,
    },
  ],
  verifyCounts: { files: 1, checkScripts: 1 },
  rootFilesNotKept: [],
  fileCount: 61,
  unpackedBytes: 180_000,
  problems: [],
};

describe('a suite from a .zip (SA.10)', () => {
  it('lists the scripts for the code panel and keeps a token to import with', () => {
    expect(SuiteZipValidationSchema.parse(ZIP).scripts[0]?.path).toBe(
      'late_fees/verify/check_late_fees.py',
    );
    const taken = {
      ...ZIP,
      outcome: 'name_taken',
      nameTaken: { path: './suites/invoices-v1', suggestion: 'invoices-v1-copy' },
    };
    expect(SuiteZipValidationSchema.parse(taken).nameTaken?.suggestion).toBe('invoices-v1-copy');
    expect(SuiteZipValidationSchema.safeParse({ ...ZIP, outcome: 'name_taken' }).success).toBe(
      false,
    );
  });

  it('has no token when rejected, and says why', () => {
    const rejected = {
      ...ZIP,
      token: null,
      outcome: 'rejected',
      suite: null,
      tasks: [],
      scripts: [],
      verifyCounts: { files: 0, checkScripts: 0 },
      problems: [
        {
          title:
            'The zip has a symbolic link at total_due/fixtures/data.csv. Links are not allowed.',
          detail: 'Replace the link with the file itself, then zip the folder again.',
        },
      ],
    };
    expect(SuiteZipValidationSchema.parse(rejected).problems).toHaveLength(1);
    expect(SuiteZipValidationSchema.safeParse({ ...rejected, token: 'x' }).success).toBe(false);
  });

  it('imports under a name, with the scripts confirmed or not', () => {
    const body = { token: 'zip-token', name: 'invoices-v1-copy', trustScripts: true };
    expect(SuiteZipImportRequestSchema.parse(body).trustScripts).toBe(true);
    expect(
      SuiteZipImportRequestSchema.safeParse({ ...body, trustScripts: undefined }).success,
    ).toBe(false);
  });
});

describe('Reload all, one job per directory (Phase 4 question 9)', () => {
  const entry = {
    sourcePath: './suites/invoices-v1',
    name: 'invoices-v1',
    outcome: 'unchanged',
    suiteId: 'suite-v6',
    versionNumber: 6,
    changes: NO_CHANGES,
    message: 'All self-checks passed',
    error: null,
  };

  it('shows each folder queued, loading, done with its entry, or failed with a message', () => {
    expect(SUITE_RELOAD_STATES).toEqual(['queued', 'loading', 'done', 'failed']);
    const progress = SuiteReloadProgressSchema.parse({
      active: true,
      startedAt: AT,
      finishedAt: null,
      directories: [
        {
          sourcePath: './suites/invoices-v1',
          name: 'invoices-v1',
          state: 'done',
          entry,
          error: null,
        },
        {
          sourcePath: './suites/mcp-v1',
          name: 'mcp-v1',
          state: 'loading',
          entry: null,
          error: null,
        },
        {
          sourcePath: './suites/new',
          name: null,
          state: 'failed',
          entry: null,
          error: 'timed out',
        },
      ],
    });
    expect(progress.directories.map((d) => d.state)).toEqual(['done', 'loading', 'failed']);
    const bad = (d: object) =>
      SuiteReloadProgressSchema.safeParse({ ...progress, directories: [d] }).success;
    expect(bad({ ...progress.directories[0], entry: null })).toBe(false);
    expect(bad({ ...progress.directories[1], entry })).toBe(false);
    expect(bad({ ...progress.directories[2], error: null })).toBe(false);
  });
});

describe('the follow-ups of Phase 5 section 6.4', () => {
  it('counts the tasks of a configuration’s experiment and gives the verdict’s Δ', () => {
    const usage = {
      experimentId: 'exp-1',
      experimentName: 'Skill vs no skill',
      role: 'candidate',
      status: 'completed',
      version: 1,
      repetitions: 3,
      passRate: 0.7,
      scored: 36,
      total: 36,
      verdict: 'inconclusive',
      verdictReason: null,
      baselinePassRate: 0.644,
      taskCount: 12,
      delta: 0.056,
    };
    expect(ConfigurationUsageSchema.parse(usage).delta).toBe(0.056);
    const { taskCount: _t, ...withoutCount } = usage;
    expect(ConfigurationUsageSchema.safeParse(withoutCount).success).toBe(false);
    expect(ConfigurationUsageSchema.safeParse({ ...usage, delta: 1.5 }).success).toBe(false);
  });

  it('names each MCP reference’s own variables and headers', () => {
    const ref = McpServerRefSchema.parse({
      mcpServerId: 'mcp-1',
      versionId: 'mcpv-1',
      name: 'vendor-directory',
      version: 2,
      transport: 'http',
      envNames: [],
      headers: [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' }],
    });
    expect(ref.headers[0]?.env).toBe('VENDOR_DIRECTORY_TOKEN');
    const { envNames: _e, ...withoutNames } = ref;
    expect(McpServerRefSchema.safeParse(withoutNames).success).toBe(false);
  });

  it('returns the tested definition’s hash with a test of an unsaved form', () => {
    const passed = {
      status: 'passed',
      definitionHash: hash('d'),
      requestedAt: AT,
      finishedAt: AT,
      startedMs: 640,
      tools: [],
    };
    expect(McpTestViewSchema.parse(passed)).toMatchObject({ definitionHash: hash('d') });
    const { definitionHash: _d, ...saved } = passed;
    expect(McpTestViewSchema.safeParse(saved).success).toBe(true);
    expect(McpTestViewSchema.safeParse({ ...passed, definitionHash: 'abc' }).success).toBe(false);
  });

  it('refuses to delete a skill or document in use, naming who uses it', () => {
    const body = {
      statusCode: 409,
      message: 'invoice-method 1.0.0 is used by 1 configuration',
      usedBy: [{ configurationId: 'cfg-1', name: 'with-skill' }],
    };
    expect(ResourceInUseBodySchema.parse(body).usedBy).toHaveLength(1);
    expect(ResourceInUseBodySchema.safeParse({ ...body, usedBy: [] }).success).toBe(false);
  });

  it('keeps the changes that created a suite’s current version on its list row', () => {
    const row = {
      suiteId: 'suite-v6',
      name: 'invoices-v1',
      versionNumber: 6,
      versionLabel: '0.3',
      contentHash: hash('7'),
      path: './suites/invoices-v1',
      description: 'Accounts-payable questions over one ledger export.',
      taskCount: 12,
      validCount: 11,
      verificationTypes: ['json_match'],
      loadedAt: AT,
      lastLoad: {
        outcome: 'unchanged',
        at: AT,
        changes: NO_CHANGES,
        error: null,
        servedVersion: null,
      },
      currentChanges: { ...NO_CHANGES, changed: ['late_fees'], nowInvalid: ['late_fees'] },
    };
    expect(SuiteListRowSchema.parse(row).currentChanges.changed).toEqual(['late_fees']);
    const { currentChanges: _c, ...withoutChanges } = row;
    expect(SuiteListRowSchema.safeParse(withoutChanges).success).toBe(false);
  });

  it('diffs small text fixtures line by line, and lists the root files', () => {
    const side = (n: number) => ({ suiteId: `suite-v${n}`, suiteVersion: n, taskVersion: n - 2 });
    const diff = TaskDiffSchema.parse({
      key: 'late_fees',
      from: side(5),
      to: side(6),
      prompt: [],
      taskYaml: [],
      reference: [],
      files: [
        {
          path: 'prompt.md',
          change: 'unchanged',
          before: { sizeBytes: 356, sha256: hash('7') },
          after: { sizeBytes: 356, sha256: hash('7') },
        },
      ],
      textFiles: [
        {
          path: 'fixtures/policy_terms.json',
          lines: [
            { kind: 'removed', text: '  "late_fee_rate": 0.015,', oldLine: 2, newLine: null },
            { kind: 'added', text: '  "fee_rate_monthly": 0.015,', oldLine: null, newLine: 2 },
          ],
        },
      ],
    });
    expect(diff.textFiles[0]?.lines).toHaveLength(2);
  });

  it('names the task and suite versions each experiment of a task ran', () => {
    const usage = {
      experimentId: 'exp-1',
      experimentName: 'Skill vs no skill, invoices-v1',
      status: 'completed',
      taskVersion: 1,
      suiteVersion: 4,
      rows: [],
    };
    expect(TaskExperimentUsageSchema.parse(usage).suiteVersion).toBe(4);
    const { taskVersion: _v, ...withoutVersion } = usage;
    expect(TaskExperimentUsageSchema.safeParse(withoutVersion).success).toBe(false);
  });
});
