/**
 * The tasks the rows of an imported file become (SA.9 steps 2 to 4): the
 * column mapping checked as a whole, each row's key, summary, prompt and
 * reference, the shared workspace files, checks and limits, and each new
 * task's readiness for the preview.
 *
 * Every task gets the same task.yaml (task-yaml-writer.ts) but its summary.
 * Its reference is the cell as written for "Reference (whole JSON)" (it is
 * stored verbatim, so a cell that is not JSON is a readiness problem, not a
 * refusal), or `{ "<answer path>": <value> }` for "Reference value at the
 * answer path", where a CSV cell that reads as JSON is that JSON (`3` is a
 * number, `true` a boolean) and any other cell a string.
 */
import {
  answerInstructions,
  appendParagraph,
  DIRECTORY_KEY_MESSAGE,
  DIRECTORY_KEY_PATTERN,
  generatedTaskKey,
  summaryFromPrompt,
  type JsonValue,
  type TaskImportColumnUse,
  type TaskImportField,
  type TaskImportPreview,
  type TaskImportPreviewRow,
  type TaskImportSettings,
} from '@hermes-evals/shared';
import { evaluateReadiness } from '../drafts/readiness.js';
import type { DraftFileRef, DraftTaskFolder } from '../drafts/materialise.js';
import type { ImportedTasks, TaskImportContext, TaskTableRow } from './parsers.js';
import { asText } from './task-table.js';
import { newTaskYaml, verificationEntryOf, verificationOf } from './task-yaml-writer.js';

/** Folder names are at most this long on every disk the suites folder may sit on. */
const MAX_KEY_LENGTH = 255;

type Message = TaskImportPreview['messages'][number];

const problem = (message: string): Message => ({ severity: 'problem', message });
const info = (message: string): Message => ({ severity: 'info', message });

/** The columns mapped to each use, in mapping order. */
function columnsByUse(settings: TaskImportSettings): Map<TaskImportColumnUse, string[]> {
  const uses = new Map<TaskImportColumnUse, string[]>();
  for (const { column, use } of settings.mapping) uses.set(use, [...(uses.get(use) ?? []), column]);
  return uses;
}

/** `totals.vat` → ['totals', 'vat']; `bands[2]` → ['bands', 2]; null when malformed. */
export function answerPathSegments(path: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) return null;
    if (match[1] !== '') segments.push(match[1]!);
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]));
  }
  return segments.length > 0 ? segments : null;
}

/** `value` placed at `segments`: `{ "totals": { "vat": value } }`; a list index pads with null. */
export function referenceAt(segments: ReadonlyArray<string | number>, value: JsonValue): JsonValue {
  let node = value;
  for (const segment of [...segments].reverse()) {
    if (typeof segment === 'string') node = { [segment]: node };
    else node = [...Array<JsonValue>(segment).fill(null), node];
  }
  return node;
}

/** A CSV cell read as a reference value: JSON when it parses as JSON, otherwise the text. */
function cellValue(value: JsonValue): JsonValue {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

const cell = (row: TaskTableRow, column: string | undefined): JsonValue | undefined =>
  column !== undefined && Object.hasOwn(row.values, column) ? row.values[column] : undefined;

/** Why a key cannot be a task folder, in the words of the preview; null when it can. */
function keyFault(key: string): string | null {
  if (key === '') return 'is empty';
  if (key.length > MAX_KEY_LENGTH) return `is longer than ${MAX_KEY_LENGTH} characters`;
  if (DIRECTORY_KEY_PATTERN.test(key)) return null;
  if (/\s/.test(key)) return 'has a space';
  if (!/^[A-Za-z0-9]/.test(key)) return `starts with ${JSON.stringify(/^./u.exec(key)![0])}`;
  return `has ${JSON.stringify(/[^A-Za-z0-9_.-]/u.exec(key)?.[0] ?? key)}`;
}

/** The mapping's own problems, and its notes, before any row is read. */
function mappingMessages(
  rows: readonly TaskTableRow[],
  settings: TaskImportSettings,
  context: TaskImportContext,
): Message[] {
  const uses = columnsByUse(settings);
  const count = (use: TaskImportColumnUse) => uses.get(use)?.length ?? 0;
  const present = new Set(rows.flatMap((r) => Object.keys(r.values)));
  const messages: Message[] = [];
  for (const { column } of settings.mapping) {
    if (!present.has(column)) messages.push(problem(`Column ${column} is not in the file.`));
  }
  if (count('prompt') === 0) messages.push(problem('Map one column to Prompt.'));
  if (count('prompt') > 1) messages.push(problem('Map only one column to Prompt.'));
  const references = count('reference') + count('reference_value');
  if (references === 0) messages.push(problem('Map one column to Reference or Reference value.'));
  if (references > 1) {
    messages.push(problem('Map only one column to Reference or Reference value.'));
  }
  if (count('task_key') > 1) messages.push(problem('Map only one column to Task key.'));
  if (count('summary') > 1) messages.push(problem('Map only one column to Summary.'));
  const path = settings.answerPath;
  if (count('reference_value') > 0 && (path === null || path === '')) {
    messages.push(problem('Set the answer path: each Reference value goes in at that path.'));
  } else if (path !== null && path !== '' && answerPathSegments(path) === null) {
    messages.push(problem(`The answer path ${path} is not a path such as total or totals.vat.`));
  }
  if (count('task_key') === 0) {
    const prefix = settings.keyPrefix ?? '';
    const first = generatedTaskKey(prefix, 1, rows.length);
    if (prefix === '') messages.push(problem('Set a key prefix, or map a column to Task key.'));
    else if (keyFault(first) !== null) {
      messages.push(
        problem(`The key prefix ${prefix} ${keyFault(first)!}. ${DIRECTORY_KEY_MESSAGE}`),
      );
    } else {
      const second = generatedTaskKey(prefix, 2, rows.length);
      messages.push(
        info(`No column is mapped to Task key, so keys are generated: ${first}, ${second}, …`),
      );
    }
  }
  if (count('summary') === 0) {
    messages.push(
      info(
        'No column is mapped to Summary. Summaries are taken from the first 80 characters of each prompt.',
      ),
    );
  }
  if (settings.workspace.from === 'task' && context.workspaceSource === null) {
    messages.push(problem(`${settings.workspace.key} is not a task of the draft.`));
  }
  if (settings.workspace.from === 'upload' && context.uploads.length === 0) {
    messages.push(problem('Upload the workspace files, or choose None.'));
  }
  if (settings.checks.from === 'task') {
    if (context.checksSource === null) {
      messages.push(problem(`${settings.checks.key} is not a task of the draft.`));
    } else if (verificationOf(context.checksSource.taskYaml) === null) {
      messages.push(problem(`${settings.checks.key} has no checks to copy.`));
    }
  }
  return messages;
}

/** What every imported task shares: its checks (with the files they need) and its workspace files. */
function sharedParts(settings: TaskImportSettings, context: TaskImportContext) {
  const files: DraftFileRef[] = [];
  if (settings.workspace.from === 'task') {
    files.push(...(context.workspaceSource?.files ?? []).filter((f) => f.kind === 'fixture'));
  } else if (settings.workspace.from === 'upload') {
    files.push(...context.uploads);
  }
  let verification: Record<string, unknown>[];
  let rubrics: Record<string, string> = {};
  if (settings.checks.from === 'new') {
    verification = settings.checks.checks.map(verificationEntryOf);
  } else {
    // The source's checks, with what they read: its rubrics, and its verify/ folder,
    // already part of the suite (nothing new arrives from the browser, R7).
    const source = context.checksSource!;
    verification = verificationOf(source.taskYaml) ?? [];
    const named = new Set(
      verification.flatMap((v) => {
        const params = v.params as Record<string, unknown> | undefined;
        return v.type === 'llm_judge' && typeof params?.rubric === 'string' ? [params.rubric] : [];
      }),
    );
    rubrics = Object.fromEntries(Object.entries(source.rubrics).filter(([p]) => named.has(p)));
    if (verification.some((v) => v.type === 'verifier_script')) {
      files.push(...source.files.filter((f) => f.kind === 'verifier'));
    }
  }
  const unique = new Map(files.map((f) => [f.path, f]));
  return {
    verification,
    rubrics,
    files: [...unique.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

interface BuiltRow {
  preview: Omit<TaskImportPreviewRow, 'readiness'>;
  task: DraftTaskFolder;
}

export async function importTasks(
  rows: readonly TaskTableRow[],
  settings: TaskImportSettings,
  context: TaskImportContext,
): Promise<ImportedTasks> {
  const messages = mappingMessages(rows, settings, context);
  const blocked = messages.some((m) => m.severity === 'problem');
  const uses = columnsByUse(settings);
  const first = (use: TaskImportColumnUse) => uses.get(use)?.[0];
  const shared = blocked ? null : sharedParts(settings, context);
  const fixes = new Map(settings.keyFixes.map((f) => [f.row, f.key]));
  const segments = settings.answerPath ? answerPathSegments(settings.answerPath) : null;
  const keysSoFar = new Map<string, number>();

  const built = rows.map((row): BuiltRow => {
    const problems: TaskImportPreviewRow['problems'] = [];
    const say = (field: TaskImportField, message: string) =>
      problems.push({ field, message: `Row ${row.row}: ${message}` });

    const keyCell = cell(row, first('task_key'));
    const key =
      fixes.get(row.row) ??
      (first('task_key') !== undefined
        ? keyCell === undefined
          ? ''
          : asText(keyCell).trim()
        : generatedTaskKey(settings.keyPrefix ?? '', row.row, rows.length));
    const fault = keyFault(key);
    const earlier = keysSoFar.get(key);
    if (fault !== null) say('key', `key ${key} ${fault}. ${DIRECTORY_KEY_MESSAGE}`);
    else if (context.existingKeys.has(key)) {
      say('key', `${key} is already a task in ${context.folder}.`);
    } else if (earlier !== undefined) say('key', `${key} is also the key of row ${earlier}.`);
    if (!keysSoFar.has(key)) keysSoFar.set(key, row.row);

    const promptCell = cell(row, first('prompt'));
    const promptText = promptCell === undefined ? '' : asText(promptCell);
    if (promptText.trim() === '') say('prompt', 'the prompt is empty.');
    else if (typeof promptCell !== 'string') say('prompt', 'the prompt is not text.');

    const summaryCell = cell(row, first('summary'));
    const summaryText = summaryCell === undefined ? '' : asText(summaryCell).trim();
    const summary = summaryText !== '' ? summaryText : summaryFromPrompt(promptText);

    // The reference: verbatim text for the whole JSON, a built object for a value at the path.
    let referenceText: string;
    let referenceValue: string;
    let parsed: JsonValue | undefined;
    const wholeColumn = first('reference');
    if (wholeColumn !== undefined) {
      const whole = cell(row, wholeColumn);
      if (whole === undefined) {
        say('reference', `no value for ${wholeColumn}.`);
        referenceText = '';
      } else if (typeof whole === 'string') {
        referenceText = whole.endsWith('\n') ? whole : `${whole}\n`;
        try {
          parsed = JSON.parse(whole) as JsonValue;
        } catch (err) {
          say('reference', `${wholeColumn} is not valid JSON (${(err as Error).message}).`);
        }
      } else {
        parsed = whole;
        referenceText = `${JSON.stringify(whole, null, 2)}\n`;
      }
      referenceValue = parsed !== undefined ? JSON.stringify(parsed) : asText(whole ?? '');
    } else {
      const valueColumn = first('reference_value');
      const raw = cell(row, valueColumn);
      if (raw === undefined || raw === '') say('reference', `no value for ${valueColumn ?? ''}.`);
      const value = raw === undefined ? null : cellValue(raw);
      parsed = segments ? referenceAt(segments, value) : value;
      referenceText = `${JSON.stringify(parsed, null, 2)}\n`;
      referenceValue = JSON.stringify(value);
    }

    let prompt = promptText.endsWith('\n') || promptText === '' ? promptText : `${promptText}\n`;
    if (settings.appendAnswerInstructions) {
      prompt = appendParagraph(promptText, answerInstructions(settings.answerPath, parsed));
    }
    const task: DraftTaskFolder = {
      key,
      taskYaml: shared
        ? newTaskYaml({
            summary,
            limits: settings.limits,
            answerPath: settings.answerPath,
            verification: shared.verification,
          })
        : null,
      prompt,
      reference: referenceText,
      rubrics: shared?.rubrics ?? {},
      files: shared?.files ?? [],
    };
    const needsFix = problems.some((p) => p.field === 'key');
    return { preview: { row: row.row, key, summary, referenceValue, problems, needsFix }, task };
  });

  const allKeys = [...context.existingKeys, ...built.map((b) => b.task.key)];
  const blobCache = new Map<string, Promise<Buffer>>();
  const readBlob = (sha256: string): Promise<Buffer> => {
    if (!blobCache.has(sha256)) blobCache.set(sha256, context.readBlob(sha256));
    return blobCache.get(sha256)!;
  };
  const previewRows: TaskImportPreviewRow[] = [];
  for (const [i, { preview, task }] of built.entries()) {
    if (blocked) {
      previewRows.push({ ...preview, readiness: 'not_run' });
      continue;
    }
    const otherKeys = allKeys.filter((_, j) => j !== context.existingKeys.size + i);
    const { readiness } = await evaluateReadiness(task, {
      folder: context.folder,
      otherKeys,
      renamedFrom: null,
      readBlob,
      lastSelfCheck: null,
    });
    previewRows.push({ ...preview, readiness: readiness.summary });
  }

  const added = blocked ? [] : built.filter((b) => !b.preview.needsFix).map((b) => b.task);
  return {
    preview: {
      rows: previewRows,
      addCount: added.length,
      fixCount: blocked ? 0 : built.filter((b) => b.preview.needsFix).length,
      messages,
    },
    tasks: added,
  };
}
