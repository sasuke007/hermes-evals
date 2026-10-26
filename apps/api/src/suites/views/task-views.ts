/**
 * Task detail, a task's version history and the diff between two versions
 * (plan 4.5, UI_FLOWS 8.2), built from tasks and task_files rows. File
 * contents (fixture labels and previews, home file texts, the verifier source) are read by the
 * service and passed in, so these stay pure.
 */
import {
  homeSeedTarget,
  isHomeSeedPath,
  TASK_HOME_FILE_KINDS,
  type SelfCheckFailureView,
  type SuiteTaskRow,
  type TablePreview,
  type TaskDetail,
  type TaskDiff,
  type TaskExperimentUsage,
  type TaskFixtureFile,
  type TaskHomeFile,
  type TaskVersionEntry,
  type VerificationEntryView,
} from '@hermes-evals/shared';
import { changedFiles, fileChanges, type FileState, type TaskContent } from './changes.js';
import { jsonDiff, textDiff } from './diffs.js';
import { fixtureDisplayPath, isoTime, taskYamlDisplayPath } from './format.js';
import { limitsOf, type SuiteRow, type TaskFileRow, type TaskRow } from './rows.js';
import { verificationSentence } from './sentences.js';
import { selfCheckView } from './self-check.js';
import { suiteRef } from './suite-views.js';
import { fixtureTypeLabel } from './table.js';
import { answerPathOf, expectedHomeDirOf, verificationYamlSlices } from './yaml-slice.js';

/** One task row of Suite detail. */
export function suiteTaskRow(
  task: TaskRow,
  fixtureCount: number,
  failure: SelfCheckFailureView | null,
): SuiteTaskRow {
  const limits = limitsOf(task);
  return {
    key: task.key,
    version: task.versionNumber,
    summary: task.summary ?? '',
    verificationTypes: task.verification.map((v) => v.type),
    maxTurns: limits.maxTurns,
    budgetS: limits.budgetS,
    fixtureCount,
    valid: task.valid,
    selfCheckFailure: failure,
  };
}

/** Each entry with its params, its YAML as written and its sentence. */
export function verificationViews(
  task: Pick<TaskRow, 'verification' | 'taskYaml'>,
): VerificationEntryView[] {
  const yaml = verificationYamlSlices(task.taskYaml, task.verification);
  const answerPath = answerPathOf(task.taskYaml);
  return task.verification.map((entry, i) => ({
    key: entry.key,
    type: entry.type,
    primary: entry.primary,
    params: entry.params as VerificationEntryView['params'],
    yaml: yaml[i]!,
    sentence: verificationSentence(entry, answerPath),
  }));
}

/**
 * One fixture of Task detail. `content` is null when the file was too large
 * to read for a label; `preview` is set by the caller for small tabular files.
 */
export function fixtureFileView(
  file: TaskFileRow,
  content: Uint8Array | null,
  preview: TablePreview | null,
): TaskFixtureFile {
  return {
    path: fixtureDisplayPath(file.path),
    typeLabel: fixtureTypeLabel(file.path, content),
    sizeBytes: file.size,
    sha256: file.sha256,
    preview,
  };
}

/**
 * Task detail's home files (Phase 6 P1, P2): the home seeds in path order,
 * then the expected_home files in path order, each with its path in the
 * home. `textOf` gives a file's text, or null when it is too large, not
 * UTF-8 or gone from the blob store.
 */
export function homeFileViews(
  task: Pick<TaskRow, 'taskYaml'>,
  files: readonly TaskFileRow[],
  textOf: ReadonlyMap<string, string | null>,
): TaskHomeFile[] {
  const expectedHomeDir = expectedHomeDirOf(task.taskYaml);
  return TASK_HOME_FILE_KINDS.flatMap((kind) =>
    files
      .filter((f) => f.kind === kind)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({
        kind,
        path: f.path,
        homePath: homePathOf(f.path, expectedHomeDir),
        sizeBytes: f.size,
        sha256: f.sha256,
        text: textOf.get(f.sha256) ?? null,
      })),
  );
}

/**
 * A home file's path in the home: a seed's target (`home/memories/USER.md`
 * → `memories/USER.md`), or an expected_home file's path inside its folder,
 * which may be nested (`known_good/home/memories/USER.md` →
 * `memories/USER.md`). The loader stores expected_home files only under that
 * folder, so the prefix is always there.
 */
function homePathOf(path: string, expectedHomeDir: string | null): string {
  if (isHomeSeedPath(path)) return homeSeedTarget(path);
  const prefix = expectedHomeDir === null ? null : `${expectedHomeDir}/`;
  return prefix !== null && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export interface TaskDetailInput {
  suite: SuiteRow;
  task: TaskRow;
  /** Version number of the suite row named by task.introducedInSuiteId. */
  introducedInSuiteVersion: number;
  fixtures: readonly TaskFixtureFile[];
  /** The home seeds, then the expected_home files (homeFileViews). */
  homeFiles: readonly TaskHomeFile[];
  verifier: TaskDetail['verifier'];
  failure: SelfCheckFailureView | null;
  experiments: readonly TaskExperimentUsage[];
}

export function taskDetail(input: TaskDetailInput): TaskDetail {
  const { suite, task } = input;
  const prompt = task.prompt ?? '';
  return {
    suite: suiteRef(suite),
    key: task.key,
    version: task.versionNumber,
    introducedInSuiteVersion: input.introducedInSuiteVersion,
    summary: task.summary ?? '',
    path: taskYamlDisplayPath(suite.sourcePath, task.key),
    prompt: { file: 'prompt.md', markdown: prompt, characters: prompt.length },
    fixtures: [...input.fixtures],
    homeFiles: [...input.homeFiles],
    verification: verificationViews(task),
    reference: { file: 'reference.json', value: task.reference ?? null },
    verifier: input.verifier,
    selfCheck: selfCheckView(task.selfCheck, task.verification, isoTime(suite.loadedAt)),
    limits: limitsOf(task),
    valid: task.valid,
    selfCheckFailure: input.failure,
    experiments: [...input.experiments],
  };
}

/** A task row with its suite version and files, as history and diffs compare them. */
export interface PlacedTask {
  task: TaskRow;
  suite: SuiteRow;
  files: readonly FileState[];
}

export const contentOf = (placed: PlacedTask): TaskContent => ({
  prompt: placed.task.prompt,
  taskYaml: placed.task.taskYaml,
  reference: placed.task.reference ?? null,
  files: placed.files,
});

/**
 * Each distinct version of one task key in one directory, newest first. A
 * version is represented by the row of the suite version that introduced it
 * (or its earliest row, should that one be missing); `current` marks the
 * version the directory's current suite version holds.
 */
export function taskHistory(
  placed: readonly PlacedTask[],
  suitesById: ReadonlyMap<string, SuiteRow>,
  currentSuiteId: string | null,
): TaskVersionEntry[] {
  const byVersion = new Map<number, PlacedTask>();
  for (const p of [...placed].sort((a, b) => a.suite.versionNumber - b.suite.versionNumber)) {
    const seen = byVersion.get(p.task.versionNumber);
    if (
      !seen ||
      (seen.task.suiteId !== seen.task.introducedInSuiteId &&
        p.task.suiteId === p.task.introducedInSuiteId)
    ) {
      byVersion.set(p.task.versionNumber, p);
    }
  }
  const currentVersion = placed.find((p) => p.suite.id === currentSuiteId)?.task.versionNumber;
  const ascending = [...byVersion.values()].sort(
    (a, b) => a.task.versionNumber - b.task.versionNumber,
  );
  return ascending
    .map((p, i) => {
      const introducedIn = suitesById.get(p.task.introducedInSuiteId) ?? p.suite;
      const previous = i > 0 ? ascending[i - 1]! : null;
      return {
        version: p.task.versionNumber,
        contentHash: p.task.contentHash,
        suiteId: introducedIn.id,
        introducedInSuiteVersion: introducedIn.versionNumber,
        loadedAt: isoTime(introducedIn.loadedAt),
        changedFiles: previous ? changedFiles(contentOf(previous), contentOf(p)) : [],
        current: p.task.versionNumber === currentVersion,
      };
    })
    .reverse();
}

/** The task's changes from `from` (the `against` suite version) to `to`. */
export function taskDiff(from: PlacedTask, to: PlacedTask): TaskDiff {
  const side = (p: PlacedTask) => ({
    suiteId: p.suite.id,
    suiteVersion: p.suite.versionNumber,
    taskVersion: p.task.versionNumber,
  });
  return {
    key: to.task.key,
    from: side(from),
    to: side(to),
    prompt: textDiff(from.task.prompt, to.task.prompt),
    taskYaml: textDiff(from.task.taskYaml, to.task.taskYaml),
    reference: jsonDiff(from.task.reference ?? null, to.task.reference ?? null),
    files: fileChanges(from.files, to.files),
  };
}
