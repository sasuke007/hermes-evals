/**
 * The suite loader (plan 4.4): every immediate, non-hidden directory under
 * SUITES_DIR is one suite. It runs in the worker (decision D1), at start and
 * for each load-suites job, because verifier self-checks are user code.
 *
 * Per directory, one transaction: take the directory's advisory lock, then
 * read and judge the files (read-suite.ts) and record the outcome
 * (persist.ts). Reading under the lock is what makes concurrent loads safe: a
 * slower load that read older files can never write after a faster one that
 * read newer files. Directories are loaded one after another and each is
 * independent: one directory's failure is that directory's `error` entry,
 * never a failed pass. Loads in one process also run one at a time, so the
 * start-up pass and a reload job queue up instead of reading in parallel.
 * After a load nothing reads SUITES_DIR again; trials, verifiers and the API
 * read blobs by hash.
 */
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PinoLogger } from 'nestjs-pino';
import {
  DIRECTORY_KEY_PATTERN,
  type SuiteReloadEntry,
  type SuiteReloadResult,
} from '@hermes-evals/shared';
import { pgError, SQLSTATE } from '../../common/pg-error.js';
import type { AppDb, AppTx } from '../../database/types.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { suiteDisplayPath } from '../views/format.js';
import { changeSetView, noChanges } from './changes.js';
import { LOADER_VERSION } from './limits.js';
import {
  createdMessage,
  errorMessage,
  MISSING_MESSAGE,
  revertedMessage,
  unchangedMessage,
} from './messages.js';
import {
  liveDirectories,
  lockDirectory,
  markMissing,
  persistError,
  persistSuite,
  type DirectoryOutcome,
  type PersistDeps,
} from './persist.js';
import { readSuiteDirectory, type LoadedSuite } from './read-suite.js';
import { comparePaths, isHiddenName, listSuitesDir } from './walk.js';
import { locatedError, toErrorView } from './yaml-source.js';

export type LoaderLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

export interface SuiteLoaderOptions {
  db: AppDb;
  blobs: BlobStore;
  /** SUITES_DIR; resolved against the working directory. */
  suitesDir: string;
  logger: LoaderLogger;
  /** Feeds the check hash. Tests pass another value to see a re-check. */
  loaderVersion?: number;
  /** Interpreter for verifier scripts. */
  python?: string;
  now?: () => Date;
}

const KEY_RULE = "must start with a letter or digit and use only letters, digits, '.', '_' and '-'";

/** A directory-level failure, located at the directory itself. */
const directoryError = (message: string) => locatedError('.', '', null, message);

/** Postgres unique violation on the partial index that keeps live suite names unique. */
function isNameRace(err: unknown): boolean {
  const pg = pgError(err);
  return (
    pg?.code === SQLSTATE.uniqueViolation &&
    (pg.constraint === undefined || pg.constraint === 'suite_sources_name_uq')
  );
}

/**
 * A failure that a second run of the whole locked unit resolves: another
 * directory claimed the same name between the check and the write (the
 * unique index stops it; the second run sees that row and records this
 * directory's error), or Postgres broke a deadlock by aborting this load.
 */
const isRetryable = (err: unknown): boolean =>
  isNameRace(err) || pgError(err)?.code === SQLSTATE.deadlockDetected;

/** One directory's outcome, with the suite that was read when there was one. */
interface DirectoryLoad {
  outcome: DirectoryOutcome;
  suite: LoadedSuite | null;
}

export class SuiteLoader {
  private readonly suitesDir: string;
  private readonly persist: PersistDeps;
  /** The load in progress in this process; the next one starts when it settles. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SuiteLoaderOptions) {
    this.suitesDir = resolve(options.suitesDir);
    this.persist = {
      db: options.db,
      blobs: options.blobs,
      now: options.now ?? (() => new Date()),
      suitesDir: this.suitesDir,
    };
  }

  /**
   * Loads every directory, and marks the ones that vanished `missing` first,
   * so a renamed directory can take its old name in the same pass. Throws
   * only when SUITES_DIR itself cannot be listed.
   */
  loadAll(): Promise<SuiteReloadResult> {
    return this.serially(() => this.loadAllNow());
  }

  /**
   * Loads one directory, named relative to SUITES_DIR. A name that is not one
   * directory name is refused (the API checks it first); one that is not on
   * disk is `missing`.
   */
  loadOne(path: string): Promise<SuiteReloadResult> {
    if (path === '' || path.includes('/') || path.includes('\0') || isHiddenName(path)) {
      return Promise.reject(new Error(`not a suite directory name: ${JSON.stringify(path)}`));
    }
    return this.serially(async () => {
      const at = this.persist.now().toISOString();
      const { outcome, suite } = await this.loadDirectory(path);
      return { at, suites: [this.entry(outcome, suite)] };
    });
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadAllNow(): Promise<SuiteReloadResult> {
    const at = this.persist.now().toISOString();
    const listing = await listSuitesDir(this.suitesDir);
    const onDisk = new Set(listing.map((e) => e.name));
    const loads: DirectoryLoad[] = [];
    for (const path of await liveDirectories(this.options.db)) {
      if (onDisk.has(path)) continue;
      const outcome = await this.locked(path, (tx) => markMissing(tx, this.persist, path));
      if (outcome) loads.push({ outcome, suite: null });
    }
    for (const dir of listing) loads.push(await this.loadDirectory(dir.name));
    await this.settleNameConflicts(loads);

    const entries = loads.map(({ outcome, suite }) => this.entry(outcome, suite));
    entries.sort((a, b) => comparePaths(a.sourcePath, b.sourcePath));
    this.options.logger.info(
      { directories: entries.length, outcomes: entries.map((e) => `${e.sourcePath}:${e.outcome}`) },
      'suites loaded',
    );
    return { at, suites: entries };
  }

  /**
   * Directories that lost a name to another directory in this pass try again,
   * reusing what they read (no verifier runs twice), until a round changes
   * nothing. Swapping two suites' names, or rotating n of them, then settles
   * in one reload: the first round releases the names suite.yaml no longer
   * declares, and each later round lets one more directory take its new name.
   */
  private async settleNameConflicts(loads: DirectoryLoad[]): Promise<void> {
    for (let round = 0; round < loads.length; round++) {
      let changed = false;
      for (const load of loads) {
        const { outcome, suite } = load;
        if (outcome.outcome !== 'error' || !outcome.nameTakenBy || !suite || !outcome.attemptedAt) {
          continue;
        }
        const attemptedAt = outcome.attemptedAt;
        const next = await this.withRetry(() =>
          this.locked(suite.path, (tx) => persistSuite(tx, this.persist, suite, attemptedAt)),
        ).catch((err: unknown) => {
          this.options.logger.error({ err, path: suite.path }, 'suite directory failed to load');
          return null;
        });
        // Null: another load wrote this directory meanwhile; its outcome stands for now.
        if (next === null) {
          load.outcome = { ...outcome, nameTakenBy: undefined };
          continue;
        }
        if (next.outcome !== 'error' || next.nameTakenBy !== outcome.nameTakenBy) changed = true;
        load.outcome = next;
      }
      if (!changed) return;
    }
  }

  /** Runs `work` in one transaction holding the directory's advisory lock. */
  private locked<T>(path: string, work: (tx: AppTx) => Promise<T>): Promise<T> {
    return this.options.db.transaction(async (tx) => {
      await lockDirectory(tx, path);
      return work(tx);
    });
  }

  /** Runs the locked unit once more when the first run hit a name race or a deadlock. */
  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      return run();
    }
  }

  /** Reads and records one directory under its lock; never throws. */
  private async loadDirectory(path: string): Promise<DirectoryLoad> {
    try {
      const load = await this.withRetry(() => this.locked(path, (tx) => this.loadLocked(tx, path)));
      this.options.logger.info(
        {
          path,
          outcome: load.outcome.outcome,
          ...(load.outcome.outcome === 'created' ||
          load.outcome.outcome === 'unchanged' ||
          load.outcome.outcome === 'reverted'
            ? { versionNumber: load.outcome.versionNumber }
            : {}),
        },
        'suite directory loaded',
      );
      return load;
    } catch (err) {
      this.options.logger.error({ err, path }, 'suite directory failed to load');
      // Postgres's own words when it was the database that failed, not Drizzle's "Failed query".
      const cause = pgError(err)?.message || (err as Error).message;
      const error = directoryError(`could not load: ${cause}`);
      try {
        return {
          outcome: await this.locked(path, (tx) => persistError(tx, this.persist, path, error)),
          suite: null,
        };
      } catch {
        return { outcome: { outcome: 'error', path, name: null, error }, suite: null };
      }
    }
  }

  /**
   * The locked unit: what is at the path now, read, recorded. Everything is
   * decided under the lock, so a directory renamed meanwhile is `missing`.
   */
  private async loadLocked(tx: AppTx, path: string): Promise<DirectoryLoad> {
    const failed = async (message: string): Promise<DirectoryLoad> => ({
      outcome: await persistError(tx, this.persist, path, directoryError(message)),
      suite: null,
    });
    const stat = await lstat(join(this.suitesDir, path)).catch(() => null);
    if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) {
      const outcome = await markMissing(tx, this.persist, path);
      return { outcome: outcome ?? { outcome: 'missing', path, name: null }, suite: null };
    }
    if (!DIRECTORY_KEY_PATTERN.test(path)) return failed(`the directory name ${KEY_RULE}`);
    if (stat.isSymbolicLink()) {
      return failed(`${path} is a symbolic link; the loader never follows links`);
    }
    const read = await readSuiteDirectory(this.suitesDir, path, {
      loaderVersion: this.options.loaderVersion ?? LOADER_VERSION,
      scratch: (prefix) => this.options.blobs.scratchDir(prefix),
      python: this.options.python,
      now: this.persist.now,
    });
    if ('missing' in read) {
      const outcome = await markMissing(tx, this.persist, path);
      return { outcome: outcome ?? { outcome: 'missing', path, name: null }, suite: null };
    }
    if (!read.ok)
      return { outcome: await persistError(tx, this.persist, path, read.error), suite: null };
    const outcome = await persistSuite(tx, this.persist, read.suite);
    // Without `onlyAfter`, persistSuite always writes.
    return { outcome: outcome!, suite: read.suite };
  }

  private entry(outcome: DirectoryOutcome, suite: LoadedSuite | null): SuiteReloadEntry {
    // The directory as the list shows it, so the page can match entries to rows.
    const base = { sourcePath: suiteDisplayPath(outcome.path), name: outcome.name ?? outcome.path };
    switch (outcome.outcome) {
      case 'created':
      case 'unchanged':
      case 'reverted':
        return {
          ...base,
          outcome: outcome.outcome,
          suiteId: outcome.suiteId,
          versionNumber: outcome.versionNumber,
          changes: changeSetView(outcome.changes),
          message:
            outcome.outcome === 'created'
              ? createdMessage({
                  first: outcome.first,
                  changes: outcome.changes,
                  tasks: suite?.tasks ?? [],
                  sameFilesAs: outcome.sameFilesAs,
                })
              : outcome.outcome === 'unchanged'
                ? unchangedMessage(outcome.versionNumber)
                : revertedMessage(outcome.versionNumber, outcome.changes),
          error: null,
        };
      case 'error':
        return {
          ...base,
          outcome: 'error',
          suiteId: null,
          versionNumber: null,
          changes: changeSetView(noChanges()),
          message: errorMessage(outcome.error),
          error: toErrorView(outcome.error),
        };
      case 'missing':
        return {
          ...base,
          outcome: 'missing',
          suiteId: null,
          versionNumber: null,
          changes: changeSetView(noChanges()),
          message: MISSING_MESSAGE,
          error: null,
        };
    }
  }
}
