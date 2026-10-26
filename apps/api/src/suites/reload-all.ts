/**
 * A Reload all as one load-suites job per directory (Phase 4 question 9):
 *
 * 1. a scan job (`path: null`) marks the directories that vanished missing,
 *    first, so a renamed directory can take its old name, and lists the
 *    ones on disk;
 * 2. one job per directory, all sent at once; the worker runs them one at a
 *    time, each with the whole self-check budget a job has, and each under
 *    its directory's lock;
 * 3. directories that lost a suite name to another directory of this pass
 *    try again while that frees names (two suites that swapped names settle
 *    in one Reload all, as the loader's single pass did).
 *
 * The pass keeps where each directory stands (SuiteReloadProgress), which
 * GET /suites/reload/progress returns while POST /suites/reload waits.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { inArray } from 'drizzle-orm';
import type { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import {
  SuiteReloadResultSchema,
  type SuiteReloadEntry,
  type SuiteReloadProgress,
  type SuiteReloadProgressEntry,
  type SuiteReloadResult,
} from '@hermes-evals/shared';
import { suiteSources } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { QUEUES } from '../queue/queues.js';
import { sendOrJoin, type JobOutcome } from '../queue/send-and-wait.js';
import { serverError } from './http-errors.js';
import { SuiteScanSchema } from './loader/load-suites.handler.js';
import { comparePaths } from './loader/walk.js';
import { changeSetView, noChanges } from './loader/changes.js';
import { suiteDisplayPath } from './views/format.js';

export interface ReloadAllDeps {
  db: AppDb;
  boss: () => PgBoss;
  logger: Pick<PinoLogger, 'info' | 'warn' | 'error'>;
  /** How long the pass waits for one job: the load-suites expiry. */
  jobTimeoutMs: number;
  pollMs?: number;
}

/** The loader's error for a suite name another directory holds (persist.ts nameTakenError). */
const NAME_TAKEN = /suite name \S+ is already used by directory /;

/** The message of a failed job's output (pg-boss stores the serialised error); never its stack. */
export function failureMessage(output: unknown): string {
  const message = (output as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : 'the job failed without a message';
}

/** A directory whose job failed, as the result reports it: an error entry with the worker's message. */
function failedEntry(path: string, name: string | null, message: string): SuiteReloadEntry {
  return {
    sourcePath: suiteDisplayPath(path),
    name: name ?? path,
    outcome: 'error',
    suiteId: null,
    versionNumber: null,
    changes: changeSetView(noChanges()),
    message: `Could not reload: ${message}`,
    error: { file: '.', line: null, column: null, message, excerpt: [] },
  };
}

/** One pass, and whether its scan has started reading (a request may join it only before). */
interface Pass {
  promise: Promise<SuiteReloadResult>;
  reading: boolean;
  /** The scan job, once sent. */
  scanId: string | null;
}

export class ReloadAll {
  private current: Pass | null = null;
  private next: Promise<SuiteReloadResult> | null = null;
  private state: SuiteReloadProgress = {
    active: false,
    startedAt: null,
    finishedAt: null,
    directories: [],
  };

  constructor(private readonly deps: ReloadAllDeps) {}

  /**
   * A pass for this request. It joins a pass that has not read anything yet;
   * one that has may have read the files before the user's edit, so the
   * request gets the pass after it, which every request meanwhile shares
   * (as POST /suites/reload of one directory does, sendAndWait joinActive).
   */
  async run(): Promise<SuiteReloadResult> {
    const current = this.current;
    if (current && !current.reading && current.scanId !== null) {
      // The pass marks itself reading when it next looks; ask the queue now.
      const [scan] = await this.deps.boss().findJobs(QUEUES.loadSuites, { id: current.scanId });
      if (scan?.state !== 'created') current.reading = true;
    }
    if (this.current !== current) return this.run();
    if (current && !current.reading) return current.promise;
    if (current) {
      this.next ??= current.promise
        .catch(() => undefined)
        .then(() => {
          this.next = null;
          return this.run();
        });
      return this.next;
    }
    const pass: Pass = {
      promise: Promise.resolve({ at: '', suites: [] }),
      reading: false,
      scanId: null,
    };
    pass.promise = this.pass(pass).finally(() => {
      if (this.current === pass) this.current = null;
    });
    this.current = pass;
    return pass.promise;
  }

  progress(): SuiteReloadProgress {
    return structuredClone(this.state);
  }

  private async pass(pass: Pass): Promise<SuiteReloadResult> {
    this.state = {
      active: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      directories: [],
    };
    try {
      const scan = this.scanned(await this.scanJob(pass));
      const names = await this.names(scan.directories);
      this.state.directories = [
        ...scan.missing.map((entry) => ({
          sourcePath: entry.sourcePath,
          name: entry.name,
          state: 'done' as const,
          entry,
          error: null,
        })),
        ...scan.directories.map((path) => ({
          sourcePath: suiteDisplayPath(path),
          name: names.get(path) ?? null,
          state: 'queued' as const,
          entry: null,
          error: null,
        })),
      ];
      const entries = new Map<string, SuiteReloadEntry>();
      await this.load(scan.directories, entries, names);
      // Directories that lost a name to another of this pass try again while that frees names.
      for (let round = 0; round < scan.directories.length; round++) {
        const taken = [...entries].filter(
          ([, e]) => e.outcome === 'error' && NAME_TAKEN.test(e.message),
        );
        if (taken.length === 0) break;
        const before = JSON.stringify(taken);
        await this.load(
          taken.map(([path]) => path),
          entries,
          names,
        );
        const after = [...entries].filter(
          ([, e]) => e.outcome === 'error' && NAME_TAKEN.test(e.message),
        );
        if (JSON.stringify(after) === before) break;
      }
      const suites = [...scan.missing, ...entries.values()];
      suites.sort((a, b) => comparePaths(a.sourcePath, b.sourcePath));
      this.deps.logger.info(
        { directories: suites.length, outcomes: suites.map((e) => `${e.sourcePath}:${e.outcome}`) },
        'reload of every directory finished',
      );
      return { at: scan.at, suites };
    } finally {
      this.state.active = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }

  /** Sends the scan and follows it to the end, marking the pass as reading once it starts. */
  private async scanJob(pass: Pass): Promise<JobOutcome> {
    const boss = this.deps.boss();
    const deadline = Date.now() + this.deps.jobTimeoutMs;
    const id = await sendOrJoin(boss, QUEUES.loadSuites, { path: null }, '*', {
      joinActive: false,
      deadline,
    });
    pass.scanId = id;
    for (;;) {
      const [job] = await boss.findJobs<unknown>(QUEUES.loadSuites, { id });
      if (!job) throw serverError('Suite reload failed: its job is gone from the queue.');
      if (job.state !== 'created') pass.reading = true;
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
        return { jobId: id, state: job.state, output: job.output ?? null };
      }
      if (Date.now() > deadline) throw serverError('Suite reload failed: the scan did not finish.');
      await sleep(this.deps.pollMs ?? 250);
    }
  }

  /** The scan's output, or the error the request answers with. */
  private scanned(outcome: JobOutcome) {
    if (outcome.state === 'completed') {
      const parsed = SuiteScanSchema.safeParse(outcome.output);
      if (parsed.success) return parsed.data;
      this.deps.logger.error(
        { jobId: outcome.jobId },
        'load-suites scan output has an unexpected shape',
      );
      throw serverError(
        'The worker finished the reload but its result has an unexpected shape; see the API log.',
      );
    }
    if (outcome.state === 'cancelled') {
      throw serverError('The suite reload was cancelled before it finished.');
    }
    throw serverError(`Suite reload failed in the worker: ${failureMessage(outcome.output)}`);
  }

  private async names(paths: readonly string[]): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    const rows = await this.deps.db
      .select({ path: suiteSources.path, name: suiteSources.name })
      .from(suiteSources)
      .where(inArray(suiteSources.path, [...paths]));
    return new Map(rows.flatMap((r) => (r.name === null ? [] : [[r.path, r.name] as const])));
  }

  /** Sends one job per directory and follows them to the end, recording each entry. */
  private async load(
    paths: readonly string[],
    entries: Map<string, SuiteReloadEntry>,
    names: ReadonlyMap<string, string>,
  ): Promise<void> {
    const boss = this.deps.boss();
    const deadline = Date.now() + this.deps.jobTimeoutMs;
    const jobs = new Map<string, string>();
    for (const path of paths) {
      this.set(path, { state: 'queued', entry: null, error: null });
      jobs.set(
        path,
        await sendOrJoin(boss, QUEUES.loadSuites, { path }, path, { joinActive: false, deadline }),
      );
    }
    while (jobs.size > 0) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const [path, id] of jobs) {
        const [job] = await boss.findJobs<unknown>(QUEUES.loadSuites, { id });
        const settle = (entry: SuiteReloadEntry | null, error: string | null) => {
          jobs.delete(path);
          const ended = entry ?? failedEntry(path, names.get(path) ?? null, error!);
          entries.set(path, ended);
          this.set(
            path,
            entry ? { state: 'done', entry, error: null } : { state: 'failed', entry: null, error },
          );
        };
        if (!job) settle(null, 'the job is gone from the queue');
        else if (job.state === 'active')
          this.set(path, { state: 'loading', entry: null, error: null });
        else if (job.state === 'completed') {
          const parsed = SuiteReloadResultSchema.safeParse(job.output);
          const entry = parsed.success ? parsed.data.suites[0] : undefined;
          settle(
            entry ?? null,
            entry ? null : 'the worker returned a result of an unexpected shape',
          );
        } else if (job.state === 'failed' || job.state === 'cancelled') {
          settle(
            null,
            job.state === 'cancelled' ? 'the job was cancelled' : failureMessage(job.output),
          );
        }
      }
      if (jobs.size > 0) {
        if (Date.now() > deadline) {
          for (const path of jobs.keys()) {
            this.set(path, {
              state: 'failed',
              entry: null,
              error: 'the job did not finish in time',
            });
            entries.set(
              path,
              failedEntry(path, names.get(path) ?? null, 'the job did not finish in time'),
            );
          }
          return;
        }
        await sleep(this.deps.pollMs ?? 250);
      }
    }
  }

  private set(
    path: string,
    change: Pick<SuiteReloadProgressEntry, 'state' | 'entry' | 'error'>,
  ): void {
    const at = this.state.directories.find((d) => d.sourcePath === suiteDisplayPath(path));
    if (at) Object.assign(at, change, change.entry ? { name: change.entry.name } : {});
  }
}
