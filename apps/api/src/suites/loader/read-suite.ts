/**
 * One suite directory, from disk to everything a version stores (plan 4.4
 * step 1): hash every file, parse and validate suite.yaml and each task, run
 * the self-checks, and conclude each task's validity. The loader calls this
 * under the directory's lock, inside the transaction that records the result.
 *
 * A problem with suite.yaml or the directory itself fails the whole
 * directory, and so does a task.yaml that is not UTF-8 or does not parse
 * (plan 4.4: a parse failure leaves the pointer on the last good version).
 * Anything found after a successful parse (schema, params, missing files,
 * self-checks) keeps the task, invalid, with its issues.
 *
 * Before any self-check runs, the suite's declared self-check time
 * (task-self-check.ts suiteSelfCheckSeconds) must fit one load: above
 * MAX_LOAD_SELF_CHECK_SECONDS the directory fails, as a parse failure does,
 * since no load-suites job could outlast it (Phase 3 question 14). Above
 * what is left of the caller's budget (a reload of every suite) it is
 * `deferred`: nothing ran, and the loader records nothing for it.
 */
import { join } from 'node:path';
import pLimit from 'p-limit';
import {
  DIRECTORY_KEY_PATTERN,
  type LoadIssue,
  type SelfCheck,
  type SuiteYaml,
} from '@hermes-evals/shared';
import { MAX_LOAD_SELF_CHECK_SECONDS } from '../../queue/queues.js';
import { KEY_SETUP_SECONDS } from '../../scoring/scoring-time.js';
import { SCORER_VERSIONS } from '../../scoring/registry.js';
import { readTrialFile } from '../../sandbox/trial-files.js';
import { checkHash, contentHash, type HashedFile } from './hashing.js';
import {
  MAX_SUITE_FILE_BYTES,
  SELF_CHECK_CONCURRENCY,
  SUITE_WALK_LIMITS,
  SUITE_YAML,
  TASK_YAML,
} from './limits.js';
import { parseSuiteYaml } from './suite-yaml.js';
import { analyseTask, unreadableTask, type AnalysedTask } from './task.js';
import { decodeUtf8, type TaskReader } from './task-files.js';
import {
  selfCheckTask,
  suiteSelfCheckSeconds,
  taskSelfCheckSeconds,
  type SelfCheckDeps,
} from './task-self-check.js';
import { comparePaths, walkSuiteDir, type SuiteEntry } from './walk.js';
import { locatedError, type LocatedError } from './yaml-source.js';

export interface LoadedTask extends AnalysedTask {
  /** Display order: suite.yaml `tasks` first, then the other keys sorted. */
  position: number;
  selfCheck: SelfCheck;
  valid: boolean;
  /** One line, set exactly when the task is invalid. */
  invalidReason: string | null;
}

export interface LoadedSuite {
  /** Directory relative to SUITES_DIR. */
  path: string;
  yaml: SuiteYaml;
  /** suite.yaml as read, to point at its lines in later errors. */
  yamlSource: string;
  contentHash: string;
  checkHash: string;
  tasks: LoadedTask[];
  /** The self-checks' declared worst case, which a reload of every suite counts against its budget. */
  selfCheckSeconds: number;
}

/**
 * A loaded suite, a directory-level failure, or a directory that vanished
 * before or while it was read (`missing`), which the loader records as
 * missing rather than as an error that would keep its name.
 */
export type DirectoryRead =
  | { ok: true; suite: LoadedSuite }
  | { ok: false; error: LocatedError }
  | { ok: false; missing: true }
  | { ok: false; deferred: true; selfCheckSeconds: number };

export interface ReadSuiteDeps extends SelfCheckDeps {
  loaderVersion: number;
  /**
   * Seconds of declared self-checks this read may still use; a suite that
   * declares more is deferred before any self-check runs. Absent: only
   * MAX_LOAD_SELF_CHECK_SECONDS applies.
   */
  selfCheckBudgetS?: number;
}

const MAX_REASON_CHARS = 300;

const fail = (message: string, file = '.'): DirectoryRead => ({
  ok: false,
  error: locatedError(file, '', null, message),
});

const KEY_RULE = "must start with a letter or digit and use only letters, digits, '.', '_' and '-'";

export async function readSuiteDirectory(
  suitesDir: string,
  path: string,
  deps: ReadSuiteDeps,
): Promise<DirectoryRead> {
  const root = join(suitesDir, path);
  let tree;
  try {
    tree = await walkSuiteDir(root, SUITE_WALK_LIMITS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, missing: true };
    return fail(`the directory cannot be read (${code ?? 'error'})`);
  }
  if (tree.truncated) {
    return fail(
      `the directory holds more than ${SUITE_WALK_LIMITS.maxEntries} entries; nothing was loaded`,
    );
  }

  // suite.yaml
  const yamlEntry = tree.entries.find((e) => e.path === SUITE_YAML);
  if (!yamlEntry) return fail(`${SUITE_YAML} not found`, SUITE_YAML);
  if (yamlEntry.kind !== 'file')
    return fail(`${SUITE_YAML} is not a regular file (${yamlEntry.kind})`, SUITE_YAML);
  if (yamlEntry.size > MAX_SUITE_FILE_BYTES) return fail(`${SUITE_YAML} is too large`, SUITE_YAML);
  const yamlRead = await readTrialFile(root, SUITE_YAML, MAX_SUITE_FILE_BYTES);
  if (!yamlRead.ok)
    return fail(`${SUITE_YAML} could not be read safely: ${yamlRead.detail}`, SUITE_YAML);
  const yamlSource = decodeUtf8(yamlRead.content);
  if (yamlSource === null) return fail(`${SUITE_YAML} is not valid UTF-8 text`, SUITE_YAML);
  const parsed = parseSuiteYaml(yamlSource);
  if (!parsed.ok) return parsed;
  const yaml = parsed.suite;

  // Task keys: every non-hidden entry at the root but suite.yaml and plain files.
  const rootEntries = tree.entries.filter((e) => !e.path.includes('/') && e.path !== SUITE_YAML);
  const folders = new Map<string, SuiteEntry>();
  for (const entry of rootEntries) {
    if (entry.kind === 'file') continue; // a README beside the tasks
    if (!DIRECTORY_KEY_PATTERN.test(entry.path)) {
      return fail(`task folder name ${JSON.stringify(entry.path)} ${KEY_RULE}`, entry.path);
    }
    folders.set(entry.path, entry);
  }
  const listed = yaml.tasks ?? [];
  const keys = [
    ...listed,
    ...[...folders.keys()].filter((k) => !listed.includes(k)).sort(comparePaths),
  ];

  const limit = pLimit(SELF_CHECK_CONCURRENCY);
  // Every task is parsed before any self-check runs: a task.yaml that does
  // not parse fails the directory, and then no verifier needs to run.
  const analysed = await Promise.all(
    keys.map((key) => limit(() => analyseFolder(root, key, folders.get(key), tree.entries))),
  );
  // The first in display order, so the reported error is the same on every load.
  const unparsed = analysed.find((task) => task.yamlError !== null);
  if (unparsed) {
    return { ok: false, error: { ...unparsed.yamlError!, file: `${unparsed.key}/${TASK_YAML}` } };
  }
  const selfCheckSeconds = suiteSelfCheckSeconds(
    analysed.map(taskSelfCheckSeconds),
    SELF_CHECK_CONCURRENCY,
  );
  if (selfCheckSeconds > MAX_LOAD_SELF_CHECK_SECONDS) {
    return fail(
      `the self-checks may take up to ${selfCheckSeconds} s (each verifier_script's timeout_s, ` +
        `twice with a negative control, plus ${KEY_SETUP_SECONDS} s per run, ` +
        `${SELF_CHECK_CONCURRENCY} tasks at a time), above the ${MAX_LOAD_SELF_CHECK_SECONDS} s ` +
        'one load may take; lower timeout_s or split the suite',
    );
  }
  if (deps.selfCheckBudgetS !== undefined && selfCheckSeconds > deps.selfCheckBudgetS) {
    return { ok: false, deferred: true, selfCheckSeconds };
  }
  const tasks = await Promise.all(
    analysed.map((task, position) =>
      limit(async (): Promise<LoadedTask> => {
        const selfCheck = await selfCheckTask(task, deps);
        return { ...task, position, selfCheck, ...verdict(task, selfCheck) };
      }),
    ),
  );

  const files: HashedFile[] = [{ path: SUITE_YAML, sha256: yamlRead.sha256 }];
  for (const task of tasks) {
    for (const f of task.hashedFiles)
      files.push({ path: `${task.key}/${f.path}`, sha256: f.sha256 });
  }
  return {
    ok: true,
    suite: {
      path,
      yaml,
      yamlSource,
      contentHash: contentHash(files),
      checkHash: checkHash({
        loaderVersion: deps.loaderVersion,
        scorerVersions: SCORER_VERSIONS,
        tasks: tasks.map((t) => ({
          key: t.key,
          valid: t.valid,
          selfCheckStatus: t.selfCheck.status,
        })),
      }),
      tasks,
      selfCheckSeconds,
    },
  };
}

async function analyseFolder(
  root: string,
  key: string,
  folder: SuiteEntry | undefined,
  all: readonly SuiteEntry[],
): Promise<AnalysedTask> {
  if (!folder) {
    return unreadableTask(key, {
      severity: 'error',
      code: 'file_missing',
      path: `${key}/`,
      message: `task folder ${key}/ is listed in ${SUITE_YAML} but not found`,
    });
  }
  if (folder.kind !== 'dir' || !folder.entered) {
    const what =
      folder.kind === 'symlink'
        ? 'is a symbolic link; the loader never follows links'
        : folder.kind === 'dir'
          ? 'is nested too deep'
          : folder.kind === 'unreadable'
            ? `cannot be read (${folder.reason})`
            : 'is not a folder';
    return unreadableTask(key, {
      severity: 'error',
      code: 'unsafe_file',
      path: `${key}/`,
      message: `task folder ${key} ${what}`,
    });
  }
  const prefix = `${key}/`;
  const entries = all
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
  const taskDir = join(root, key);
  const read: TaskReader = async (relPath) => {
    const result = await readTrialFile(taskDir, relPath, MAX_SUITE_FILE_BYTES);
    return result.ok
      ? { ok: true, content: result.content, sha256: result.sha256 }
      : { ok: false, reason: `${result.reason}: ${result.detail}` };
  };
  return analyseTask(key, entries, read);
}

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
};

/**
 * A task is valid only with no error issue and every runnable check passed
 * (plan 4.3). The reason names the first problem, in one line.
 */
export function verdict(
  task: Pick<AnalysedTask, 'issues'>,
  selfCheck: SelfCheck,
): { valid: boolean; invalidReason: string | null } {
  const errors = task.issues.filter((i: LoadIssue) => i.severity === 'error');
  if (errors.length > 0) {
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
    return { valid: false, invalidReason: oneLine(`${errors[0]!.message}${more}`) };
  }
  if (selfCheck.status === 'passed' || selfCheck.status === 'skipped') {
    return { valid: true, invalidReason: null };
  }
  const culprit =
    selfCheck.results.find((r) => r.expect === 'fail' && r.status === 'passed') ??
    selfCheck.results.find((r) => r.expect !== 'fail' && r.status === 'error') ??
    selfCheck.results.find(
      (r) => r.expect !== 'fail' && r.status !== 'passed' && r.status !== 'skipped',
    );
  if (!culprit) return { valid: false, invalidReason: `self-check ${selfCheck.status}` };
  if (culprit.expect === 'fail') {
    const on = culprit.mode === 'home' ? 'the home seeds alone' : 'the untouched fixtures';
    return {
      valid: false,
      invalidReason: oneLine(
        `${culprit.key}: the check passes on ${on}, so it would pass any agent`,
      ),
    };
  }
  return {
    valid: false,
    invalidReason: oneLine(
      `${culprit.key} (${culprit.type}) self-check ${culprit.status}: ${culprit.comment}`,
    ),
  };
}
