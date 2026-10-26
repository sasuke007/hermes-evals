/**
 * The import parsers (plan 4.6): tasks from a CSV or JSONL file into a
 * draft (ImportTasks, SA.9), and a suite from a .zip as the draft of a new
 * suite (ImportSuiteDialog, SA.10). Both run in the API, which never mounts
 * SUITES_DIR: files go to the blob store first, and nothing is written to
 * ./suites until the draft is saved. Neither runs any code from the file.
 *
 * The bodies are in ./task-table.ts, ./imported-tasks.ts and ./suite-zip.ts;
 * the routes in ./suite-import.controller.ts.
 */
import type {
  JsonValue,
  SuiteZipScript,
  TaskImportPreview,
  TaskImportSettings,
  TaskTableFile,
  UploadProblem,
} from '@hermes-evals/shared';
import type { BlobStore } from '../../storage/blob-store.js';
import type { DraftFileRef, DraftTaskFolder } from '../drafts/materialise.js';
import { importTasks } from './imported-tasks.js';
import { readSuiteZipFile } from './suite-zip.js';
import { readTaskTable } from './task-table.js';

// ---------------------------------------------------------------------------
// Tasks from CSV or JSONL
// ---------------------------------------------------------------------------

/** One data row of the file. */
export interface TaskTableRow {
  /** 1-based, as the preview numbers rows. */
  row: number;
  /** By column: a CSV cell is a string; a JSONL value is kept as the JSON value it is. */
  values: Readonly<Record<string, JsonValue>>;
}

export type TaskTableParse =
  | { ok: true; file: TaskTableFile; rows: TaskTableRow[] }
  | { ok: false; file: TaskTableFile | null; problems: UploadProblem[] };

/**
 * Reads a task file: CSV with a header row (the csv-parse package), or JSONL
 * whose objects' keys become the columns, in order of first appearance.
 * Refused, as problems worded for the upload step: another format
 * ("questions.xlsx: use CSV or JSONL."), more than
 * AUTHORING_LIMITS.taskImportMaxBytes or taskImportMaxRows ("1,240 rows. The
 * limit is 500 per import."), text that is not UTF-8, a line that is not a
 * JSON object, no rows, and columns named twice.
 */
export function parseTaskTable(fileName: string, bytes: Buffer): TaskTableParse {
  return readTaskTable(fileName, bytes);
}

/** What building the imported tasks needs besides the rows and the settings. */
export interface TaskImportContext {
  /** The draft's suite folder, for messages. */
  folder: string;
  /** Keys the draft already holds: a row with one of them needs a fix. */
  existingKeys: ReadonlySet<string>;
  /** The draft task the settings copy workspace files from (`workspace.from: task`), else null. */
  workspaceSource: DraftTaskFolder | null;
  /** The draft task the settings copy checks from (`checks.from: task`), else null. */
  checksSource: DraftTaskFolder | null;
  /** Workspace files uploaded with the request (`workspace.from: upload`), already in the blob store. */
  uploads: readonly DraftFileRef[];
  /** A blob's bytes, for the readiness rules of the preview (leak and mentioned files). */
  readBlob: (sha256: string) => Promise<Buffer>;
}

export interface ImportedTasks {
  /** Step 4: one row per data row, with its readiness (evaluateReadiness) and what needs a fix. */
  preview: TaskImportPreview;
  /**
   * The new tasks, one per row that needs no fix, in row order: a canonical
   * task.yaml from the shared checks and limits and the answer path, the
   * prompt (with answerInstructions appended when asked), the reference as
   * the whole JSON or `{ <answer path>: <value> }`, and the shared files.
   */
  tasks: DraftTaskFolder[];
}

/**
 * Builds the tasks the rows become under `settings` (ColumnMapper's
 * mapping, generatedTaskKey when no column is Task key, summaryFromPrompt
 * when none is Summary, the inline key fixes). Rows whose key is not a
 * folder name or is taken need a fix and are left out of `tasks`; the
 * mapping's own problems ("Map one column to Prompt.") leave out every row.
 */
export async function buildImportedTasks(
  rows: readonly TaskTableRow[],
  settings: TaskImportSettings,
  context: TaskImportContext,
): Promise<ImportedTasks> {
  return importTasks(rows, settings, context);
}

// ---------------------------------------------------------------------------
// A suite from a .zip
// ---------------------------------------------------------------------------

/** A suite as a zip held it: its suite.yaml and each task folder, every file in the blob store. */
export interface SuiteZipContents {
  /** suite.yaml exactly as read. */
  suiteYaml: string;
  suite: { name: string; versionLabel: string; description: string | null };
  tasks: DraftTaskFolder[];
  /** Every file under a task's `verify/`, for "This suite contains code" (R7). */
  scripts: SuiteZipScript[];
  fileCount: number;
  unpackedBytes: number;
}

export type SuiteZipRead =
  | { ok: true; contents: SuiteZipContents }
  | { ok: false; problems: UploadProblem[]; fileCount: number; unpackedBytes: number };

/**
 * Reads a suite .zip of at most AUTHORING_LIMITS.suiteZipMaxBytes by the
 * rules of the hardened reader of skill uploads (resources/skills/zip-reader.ts,
 * applied with a suite's bounds and wording in ./zip-entries.ts), which
 * checks the central directory before reading anything: no symbolic link or
 * special file, no absolute path or `..`, at most suiteMaxEntries entries,
 * no file over suiteMaxFileBytes, no path deeper than suiteMaxDepth. The
 * suite may sit at the zip's root or in one folder that holds everything
 * (stripped). suite.yaml must parse with the loader's rules, and each task
 * folder is read as the loader would read it from disk, so a zip that would
 * fail a reload is refused with the loader's message, file and line. Every
 * file is written to the blob store (and read back from it for the
 * analysis); nothing is unpacked into SUITES_DIR and no script runs.
 */
export async function readSuiteZip(
  zipPath: string,
  blobs: Pick<BlobStore, 'putStream' | 'read'>,
): Promise<SuiteZipRead> {
  return readSuiteZipFile(zipPath, blobs);
}
