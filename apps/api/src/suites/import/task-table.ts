/**
 * A CSV or JSONL file of tasks, read for the import (SA.9 step 1): its
 * columns, their first values and its data rows, or the problems that stop
 * it. Nothing here knows what the columns become; see imported-tasks.ts.
 *
 * - CSV: a header row, then one task per row. The delimiter is the one the
 *   header uses most (`,`, `;` or a tab, so a spreadsheet's regional export
 *   reads too); quotes, doubled quotes and line breaks inside quotes are
 *   csv-parse's. Every cell is a string, kept exactly as written.
 * - JSONL: one JSON object per line; blank lines are skipped. The objects'
 *   keys become the columns, in order of first appearance, and each value is
 *   kept as the JSON value it is.
 *
 * The text must be UTF-8 (a byte-order mark is dropped) or UTF-16 with its
 * byte-order mark. Every refusal is an UploadProblem worded for the upload
 * step, one per bad row or line, at most MAX_PROBLEMS of them.
 */
import {
  AUTHORING_LIMITS,
  JsonValueSchema,
  TASK_IMPORT_FORMATS,
  type JsonValue,
  type TaskImportFormat,
  type TaskTableColumn,
  type UploadProblem,
} from '@hermes-evals/shared';
import { parse } from 'csv-parse/sync';
import { countOf, formatBytes } from '../../resources/skills/format.js';
import type { TaskTableParse, TaskTableRow } from './parsers.js';

/** At most this many problems are listed; the rest are summed up in one line. */
const MAX_PROBLEMS = 10;

/** Sample values ColumnMapper shows per column. */
const SAMPLES = 3;

const DELIMITERS = [',', ';', '\t'] as const;

const SPLIT = 'Split the file and import each part.';

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** csv or jsonl by extension, or null. */
export function taskTableFormatOf(fileName: string): TaskImportFormat | null {
  const ext = extensionOf(fileName);
  return (TASK_IMPORT_FORMATS as readonly string[]).includes(ext)
    ? (ext as TaskImportFormat)
    : null;
}

/** Keeps the first problems and sums up the rest in one line. */
export function cappedProblems(problems: UploadProblem[]): UploadProblem[] {
  if (problems.length <= MAX_PROBLEMS) return problems;
  const rest = problems.length - (MAX_PROBLEMS - 1);
  return [
    ...problems.slice(0, MAX_PROBLEMS - 1),
    { title: `${rest} more problems.`, detail: 'Fix the ones above and upload again.' },
  ];
}

/**
 * The file's text: UTF-8 without or with its byte-order mark, or UTF-16
 * with one. Null for anything else, including text holding NUL characters
 * (UTF-16 without a mark reads as UTF-8 full of them), which no prompt can
 * hold.
 */
export function decodeTaskText(bytes: Buffer): string | null {
  let encoding = 'utf-8';
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) [encoding, start] = ['utf-16le', 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [encoding, start] = ['utf-16be', 2];
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(start),
    );
  } catch {
    return null;
  }
  return text.includes('\0') ? null : text;
}

/** A value as ColumnMapper shows it: strings as they are, anything else as compact JSON. */
export const asText = (value: JsonValue): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** The delimiter the header line uses most, outside quotes; a comma when it uses none. */
function delimiterOf(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  let best: string = ',';
  for (const [delimiter, count] of counts) if (count > counts.get(best)!) best = delimiter;
  return best;
}

interface Table {
  columns: string[];
  rows: TaskTableRow[];
  problems: UploadProblem[];
}

function readCsv(name: string, text: string): Table {
  let records: string[][];
  try {
    records = parse(text, {
      delimiter: delimiterOf(text),
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (err) {
    return {
      columns: [],
      rows: [],
      problems: [{ title: `${name} cannot be read as CSV.`, detail: (err as Error).message }],
    };
  }
  const [header = [], ...data] = records;
  const columns = header.map((column) => column.trim());
  const problems: UploadProblem[] = [];
  columns.forEach((column, i) => {
    if (column === '') {
      problems.push({
        title: `Column ${i + 1} has no name.`,
        detail: 'Give every column a name in the header row.',
      });
    } else if (columns.indexOf(column) !== i) {
      problems.push({
        title: `Column ${column} is named twice.`,
        detail: 'Give every column of the header row its own name.',
      });
    }
  });
  if (problems.length > 0) return { columns, rows: [], problems };
  const rows: TaskTableRow[] = [];
  data.forEach((record, i) => {
    if (record.length !== columns.length) {
      problems.push({
        title: `Row ${i + 1} has ${countOf(record.length, 'value')}; the header has ${countOf(columns.length, 'column')}.`,
        detail: 'Quote a value that holds the delimiter, and give every row one value per column.',
      });
      return;
    }
    // fromEntries, not assignment: a column named __proto__ stays a column.
    rows.push({ row: i + 1, values: Object.fromEntries(columns.map((c, j) => [c, record[j]!])) });
  });
  return { columns, rows, problems };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readJsonl(text: string): Table {
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: TaskTableRow[] = [];
  const problems: UploadProblem[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    const where = `Line ${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      problems.push({ title: `${where} is not valid JSON.`, detail: (err as Error).message });
      return;
    }
    if (!isPlainObject(value)) {
      problems.push({
        title: `${where} is not a JSON object.`,
        detail: 'Write one object per line, such as {"key": "q1", "question": "…"}.',
      });
      return;
    }
    // JSON.parse reads 1e999 as Infinity, which no JSON column can hold.
    if (!JsonValueSchema.safeParse(value).success) {
      problems.push({
        title: `${where} holds a number that is out of range.`,
        detail: 'Write the number as a string, or within the range of a double.',
      });
      return;
    }
    if (Object.hasOwn(value, '')) {
      problems.push({ title: `${where} has an empty key.`, detail: 'Give every value a key.' });
      return;
    }
    for (const key of Object.keys(value)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    rows.push({ row: rows.length + 1, values: value as Record<string, JsonValue> });
  });
  return { columns, rows, problems };
}

/** The first SAMPLES values of `column`, as text, from the rows that have one. */
function samplesOf(rows: readonly TaskTableRow[], column: string): string[] {
  const samples: string[] = [];
  for (const { values } of rows) {
    if (samples.length === SAMPLES) break;
    if (Object.hasOwn(values, column)) samples.push(asText(values[column]!));
  }
  return samples;
}

/** parseTaskTable's body (parsers.ts holds the contract). */
export function readTaskTable(fileName: string, bytes: Buffer): TaskTableParse {
  const format = taskTableFormatOf(fileName);
  if (format === null) {
    return {
      ok: false,
      file: null,
      problems: [
        {
          title: `${fileName}: use CSV or JSONL.`,
          detail:
            'Save the sheet as CSV UTF-8, or write one JSON object per line in a .jsonl file.',
        },
      ],
    };
  }
  const limit = AUTHORING_LIMITS.taskImportMaxBytes;
  if (bytes.length > limit) {
    return {
      ok: false,
      file: null,
      problems: [
        {
          title: `${fileName} is larger than ${formatBytes(limit)}, the limit per import.`,
          detail: `It is ${formatBytes(bytes.length)}. ${SPLIT}`,
        },
      ],
    };
  }
  const text = decodeTaskText(bytes);
  if (text === null) {
    return {
      ok: false,
      file: null,
      problems: [
        {
          title: `${fileName} is not UTF-8 text.`,
          detail: 'Save it as CSV UTF-8 (or JSONL in UTF-8), then upload it again.',
        },
      ],
    };
  }
  const table = format === 'csv' ? readCsv(fileName, text) : readJsonl(text);
  const file = {
    fileName,
    format,
    sizeBytes: bytes.length,
    rowCount: table.rows.length,
    columns: table.columns.map((name): TaskTableColumn => ({
      name,
      samples: samplesOf(table.rows, name),
    })),
  };
  const problems = [...table.problems];
  const maxRows = AUTHORING_LIMITS.taskImportMaxRows;
  if (table.rows.length > maxRows) {
    problems.unshift({
      title: `${fileName}: ${table.rows.length.toLocaleString('en-US')} rows. The limit is ${maxRows} per import.`,
      detail: SPLIT,
    });
  } else if (problems.length === 0 && table.rows.length === 0) {
    problems.push({
      title: `${fileName} has no rows.`,
      detail:
        format === 'csv'
          ? 'Add one row per task under the header row.'
          : 'Add one JSON object per task, one per line.',
    });
  }
  if (problems.length > 0) return { ok: false, file, problems: cappedProblems(problems) };
  return { ok: true, file, rows: table.rows };
}
