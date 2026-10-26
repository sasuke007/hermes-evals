/**
 * Constants of the suite loader (plan 4.4). LOADER_VERSION feeds every
 * suite's check hash: bump it whenever the loader could judge the same files
 * differently (a new rule, a changed self-check), so the next reload records
 * a new version of every suite, shown as "same files as vN, re-checked".
 */
import { MAX_ARTIFACT_BYTES } from '../../sandbox/trial-files.js';

/**
 * 2: text_match patterns must compile, and a task's checks must fit one
 * scoring pass (task-yaml.ts).
 * 3: a rubric under the expected workspace is refused (task.ts), a
 * trajectory_match tool named like an MCP tool in a form Hermes never uses
 * is a warning (task-yaml.ts), and a suite's self-checks must fit one load
 * (read-suite.ts).
 * 4: the key names `primary` and `any_failed` are refused (records.ts
 * VerificationKeySchema, Phase 4 question 1).
 * 5: home seeds and the expected home (Phase 6 P1, P2): `home/` may hold
 * only the two memory files, which are checked as Hermes reads them
 * (home-seeds.ts); home checks are self-checked against the expected home
 * with the seeds as their negative control; every verifier gets `--home`.
 */
export const LOADER_VERSION = 5;

/** A file larger than this is never read; it is reported as unsafe_file. */
export const MAX_SUITE_FILE_BYTES = MAX_ARTIFACT_BYTES;

/**
 * Bounds of the walk over one suite directory. A directory deeper than
 * MAX_DEPTH is not entered (its files are reported, not read); more than
 * MAX_ENTRIES entries fails the directory, because a partial walk would hash
 * a partial suite.
 */
export const SUITE_WALK_LIMITS = { maxDepth: 12, maxEntries: 20_000 } as const;

/** Tasks of one suite whose self-checks run at the same time. */
export const SELF_CHECK_CONCURRENCY = 4;

/** Prefix of the advisory lock that serialises loads of one directory. */
export const SUITE_LOCK_PREFIX = 'hermes-evals:suite:';

/** The files a task folder must or may hold at its root. */
export const TASK_YAML = 'task.yaml';
export const PROMPT_MD = 'prompt.md';
export const REFERENCE_JSON = 'reference.json';
export const SUITE_YAML = 'suite.yaml';

/** Task subfolders with fixed meaning: copied into every trial, and verifier scripts. */
export const FIXTURES_DIR = 'fixtures';
export const VERIFY_DIR = 'verify';
