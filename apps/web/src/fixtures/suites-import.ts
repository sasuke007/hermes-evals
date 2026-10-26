/**
 * Import fixtures (Phase 5b; boards SA.9 and SA.10): a CSV of six overdue
 * questions read into the draft of invoices-v1, and the zip validations of
 * ImportSuiteDialog, chosen by the file's name as the board names them:
 * - `vendor-statements-v1.zip` (and any other name): valid, no scripts;
 * - `invoices-v1-v6.zip`: valid but the name is taken, 2 verifier scripts, 1 invalid task;
 * - `stock-tools-v1.zip`: valid, 2 files under verify/ of which a check runs 1 (Phase 7,
 *   question 12), and a README and a LICENSE at the root that the import leaves out
 *   (question 2);
 * - a name with `link`, `payables.zip`, `statements-draft.zip`, `ledger-archive.zip`:
 *   the four rejections.
 * A task file named `*.xlsx` is refused, and `all_questions.csv` is over 500 rows.
 */
import {
  DIRECTORY_KEY_PATTERN,
  generatedTaskKey,
  summaryFromPrompt,
  type JsonValue,
} from '@hermes-evals/shared';
import type {
  SuiteZipTask,
  SuiteZipValidation,
  TaskImportPreview,
  TaskImportPreviewRow,
  TaskImportSettings,
  TaskImportValidation,
  TaskTableFile,
} from '@/api/types/authoring';
import { mappingMessages } from '@/components/authoring/import/columnMapping';
import { SUITE_DESCRIPTION, TASK_KEYS, sha, ulid } from './suites';

// ---------------------------------------------------------------------------
// Tasks from a CSV or JSONL file (SA.9)
// ---------------------------------------------------------------------------

/** The board's file: key, question, expected. Row 4's key has a space. */
export const IMPORT_ROWS: { key: string; question: string; expected: string }[] = [
  {
    key: 'overdue_fjord',
    question: 'How many overdue invoices does Fjord Software have?',
    expected: '3',
  },
  {
    key: 'overdue_granite',
    question: 'How many overdue invoices does Granite Office have?',
    expected: '2',
  },
  {
    key: 'overdue_over_5000',
    question: 'How many overdue invoices are over 5,000 EUR?',
    expected: '6',
  },
  {
    key: 'overdue 90',
    question: 'How many invoices are more than 90 days overdue?',
    expected: '1',
  },
  { key: 'overdue_disputed', question: 'How many overdue invoices are disputed?', expected: '2' },
  {
    key: 'overdue_no_po',
    question: 'How many overdue invoices have no purchase order?',
    expected: '5',
  },
];

const COLUMNS = ['key', 'question', 'expected'] as const;

function tableFile(fileName: string, sizeBytes: number): TaskTableFile {
  return {
    fileName,
    format: fileName.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'csv',
    sizeBytes,
    rowCount: IMPORT_ROWS.length,
    columns: COLUMNS.map((name) => ({
      name,
      samples: IMPORT_ROWS.slice(0, 3).map((row) => row[name]),
    })),
  };
}

const parseValue = (text: string): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
};

/** The preview of the board's rows under `settings`; keys of the draft are taken. */
export function importPreviewFixture(
  settings: TaskImportSettings,
  takenKeys: readonly string[],
): TaskImportPreview {
  const use = (name: string) => settings.mapping.find((m) => m.column === name)?.use ?? 'ignore';
  const columnFor = (wanted: string) => COLUMNS.find((c) => use(c) === wanted) ?? null;
  const keyColumn = columnFor('task_key');
  const promptColumn = columnFor('prompt');
  const summaryColumn = columnFor('summary');
  const valueColumn = columnFor('reference_value') ?? columnFor('reference');
  const taken = new Set(takenKeys);
  const rows = IMPORT_ROWS.map((source, i): TaskImportPreviewRow => {
    const row = i + 1;
    const fixed = settings.keyFixes.find((f) => f.row === row)?.key;
    const key =
      fixed ??
      (keyColumn
        ? source[keyColumn as keyof typeof source]
        : generatedTaskKey(settings.keyPrefix ?? 'task_', row, IMPORT_ROWS.length));
    const prompt = promptColumn ? source[promptColumn as keyof typeof source] : '';
    const summary = summaryColumn
      ? source[summaryColumn as keyof typeof source]
      : summaryFromPrompt(prompt);
    const value = valueColumn ? parseValue(source[valueColumn as keyof typeof source]) : null;
    const problems: TaskImportPreviewRow['problems'] = [];
    if (!DIRECTORY_KEY_PATTERN.test(key)) {
      problems.push({
        field: 'key',
        message: `Row ${row}: key \`${key}\` has a space. Use letters, digits, \`.\`, \`_\` and \`-\`.`,
      });
    } else if (taken.has(key)) {
      problems.push({ field: 'key', message: `Row ${row}: \`${key}\` is already a task.` });
    }
    taken.add(key);
    return {
      row,
      key,
      summary,
      referenceValue: JSON.stringify(value),
      readiness: problems.length > 0 ? 'problems' : 'ready',
      problems,
      needsFix: problems.length > 0,
    };
  });
  const messages = mappingMessages(settings.mapping).map(({ severity, message }) => ({
    severity,
    message,
  }));
  return {
    rows,
    addCount: rows.length,
    fixCount: rows.filter((r) => r.needsFix).length,
    messages,
  };
}

/** POST …/draft/import/validate: the file as read, refused, or previewed. */
export function taskImportValidationFixture(
  fileName: string,
  sizeBytes: number,
  settings: TaskImportSettings | null,
  takenKeys: readonly string[],
): TaskImportValidation {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.csv') && !lower.endsWith('.jsonl')) {
    return {
      file: null,
      problems: [{ title: `\`${fileName}\`: use CSV or JSONL.`, detail: '' }],
      preview: null,
    };
  }
  if (lower.startsWith('all_questions')) {
    return {
      file: null,
      problems: [
        { title: `\`${fileName}\`: 1,240 rows. The limit is 500 per import.`, detail: '' },
      ],
      preview: null,
    };
  }
  return {
    file: tableFile(fileName, sizeBytes),
    problems: [],
    preview: settings ? importPreviewFixture(settings, takenKeys) : null,
  };
}

// ---------------------------------------------------------------------------
// A suite from a .zip (SA.10)
// ---------------------------------------------------------------------------

const zipTask = (
  key: string,
  workspaceFiles = 1,
  checks = 1,
  over: Partial<SuiteZipTask> = {},
): SuiteZipTask => ({
  key,
  summary: null,
  readiness: 'ready',
  problem: null,
  workspaceFiles,
  checks,
  ...over,
});

const rejected = (
  fileName: string,
  sizeBytes: number,
  title: string,
  detail: string,
): SuiteZipValidation => ({
  token: null,
  fileName,
  sizeBytes,
  outcome: 'rejected',
  suite: null,
  nameTaken: null,
  tasks: [],
  scripts: [],
  verifyCounts: { files: 0, checkScripts: 0 },
  rootFilesNotKept: [],
  fileCount: 0,
  unpackedBytes: 0,
  problems: [{ title, detail }],
});

/** The scripts of invoices-v1's zip: "This suite contains code". */
export const ZIP_SCRIPTS = [
  {
    path: 'late_fees/verify/check_late_fees.py',
    sizeBytes: 2458,
    sha256: sha('zip-check_late_fees', 'e81f0c2'),
    runByCheck: true,
  },
  {
    path: 'summary_file/verify/check_summary.py',
    sizeBytes: 1229,
    sha256: sha('zip-check_summary', '9b14e0d'),
    runByCheck: true,
  },
];

/** A zip whose `verify/` holds data beside its script, and whose root holds a README. */
export const STOCK_ZIP_SCRIPTS = [
  {
    path: 'reshape_json/verify/check_stock.py',
    sizeBytes: 1843,
    sha256: sha('zip-check_stock', '4c7a2e1'),
    runByCheck: true,
  },
  {
    path: 'reshape_json/verify/expected_stock.json',
    sizeBytes: 612,
    sha256: sha('zip-expected_stock', 'a03f9d8'),
    runByCheck: false,
  },
];

function stockZip(fileName: string, sizeBytes: number): SuiteZipValidation {
  return {
    token: ulid('zip', fileName),
    fileName,
    sizeBytes,
    outcome: 'valid',
    suite: {
      name: 'stock-tools-v1',
      versionLabel: '0.1',
      description: 'Reshaping stock files with the code tools.',
    },
    nameTaken: null,
    tasks: [zipTask('reshape_json', 1, 2), zipTask('checksum', 1, 1)],
    scripts: STOCK_ZIP_SCRIPTS,
    verifyCounts: { files: 2, checkScripts: 1 },
    rootFilesNotKept: [
      { path: 'LICENSE', sizeBytes: 1071 },
      { path: 'README.md', sizeBytes: 2310 },
    ],
    fileCount: 11,
    unpackedBytes: 18_400,
    problems: [],
  };
}

/** POST /suites/import/validate for a zip of this name. */
export function suiteZipValidationFixture(fileName: string, sizeBytes: number): SuiteZipValidation {
  const lower = fileName.toLowerCase();
  if (lower.includes('link')) {
    return rejected(
      fileName,
      sizeBytes,
      'The zip has a symbolic link at `total_due/fixtures/data.csv`. Links are not allowed.',
      'Replace the link with the file itself, then zip the folder again.',
    );
  }
  if (lower.startsWith('payables')) {
    return rejected(
      fileName,
      sizeBytes,
      '`../secrets.txt` points outside the suite.',
      'Paths in the zip must be relative and stay inside the suite folder.',
    );
  }
  if (lower.startsWith('statements-draft')) {
    return rejected(
      fileName,
      sizeBytes,
      '`suite.yaml` line 3: `version_label` is required.',
      'Add a label such as `version_label: "0.1"`, then zip the folder again.',
    );
  }
  if (lower.startsWith('ledger-archive')) {
    return rejected(
      fileName,
      sizeBytes,
      'Over 20,000 files.',
      'A suite holds at most 20,000 files, 25 MB each, in folders at most 12 levels deep.',
    );
  }
  if (lower.startsWith('stock-tools')) return stockZip(fileName, sizeBytes);
  if (lower.startsWith('invoices-v1')) {
    return {
      token: ulid('zip', fileName),
      fileName,
      sizeBytes,
      outcome: 'name_taken',
      suite: { name: 'invoices-v1', versionLabel: '0.3', description: SUITE_DESCRIPTION },
      nameTaken: { path: './suites/invoices-v1', suggestion: 'invoices-v1-copy' },
      tasks: TASK_KEYS.map((key) =>
        key === 'late_fees'
          ? zipTask(key, 2, 2, {
              readiness: 'problems',
              problem:
                'the check reads `late_fee_total`, which is not in `reference.json`. The task is imported as invalid.',
            })
          : key === 'summary_file'
            ? zipTask(key, 1, 2, { readiness: 'not_run' })
            : zipTask(key),
      ),
      scripts: ZIP_SCRIPTS,
      verifyCounts: { files: ZIP_SCRIPTS.length, checkScripts: ZIP_SCRIPTS.length },
      rootFilesNotKept: [],
      fileCount: 61,
      unpackedBytes: 214_000,
      problems: [],
    };
  }
  return {
    token: ulid('zip', fileName),
    fileName,
    sizeBytes,
    outcome: 'valid',
    suite: {
      name: 'vendor-statements-v1',
      versionLabel: '0.1',
      description: 'Reconciling vendor statements against the ledger.',
    },
    nameTaken: null,
    tasks: [zipTask('unmatched_lines', 2, 1)],
    scripts: [],
    verifyCounts: { files: 0, checkScripts: 0 },
    rootFilesNotKept: [],
    fileCount: 7,
    unpackedBytes: 26_700,
    problems: [],
  };
}
