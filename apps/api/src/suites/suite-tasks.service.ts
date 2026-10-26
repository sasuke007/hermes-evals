/**
 * Task detail, task history, task diff and fixture files
 * (GET /suites/:id/tasks/:key[/history|/diff|/fixtures/:path[/preview]]).
 *
 * File contents come from the blob store by the hash task_files recorded at
 * load, never from SUITES_DIR, so what is shown is exactly what a trial gets.
 * A fixture is looked up among the task's own fixture rows by its displayed
 * path; the requested path is never joined to a directory.
 */
import type { ReadStream } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import {
  TASK_HOME_FILE_KINDS,
  TASK_HOME_FILE_TEXT_LIMIT,
  type TablePreview,
  type TaskDetail,
  type TaskDiff,
  type TaskFileChange,
  type TaskFixtureFile,
  type TaskVersionEntry,
} from '@hermes-evals/shared';
import { DB } from '../database/db.provider.js';
import type { AppDb } from '../database/types.js';
import type { BlobStore } from '../storage/blob-store.js';
import { StorageService } from '../storage/storage.service.js';
import { badRequest, notFound, serverError } from './http-errors.js';
import { failuresOf, groupByTask } from './suite-failures.js';
import {
  filesOf,
  keyRowsInDirectory,
  rootFilesOf,
  sourceOf,
  suiteById,
  taskByKey,
  taskUsage,
  versionsOf,
} from './suites.queries.js';
import { isTextDiffCandidate } from './views/diff-files.js';
import { fileChanges } from './views/changes.js';
import { fixtureDisplayPath } from './views/format.js';
import type { SuiteRow, TaskFileRow, TaskRow } from './views/rows.js';
import { streamTablePreview, tablePreview, tabularFormatOf } from './views/table.js';
import {
  fixtureFileView,
  homeFileViews,
  taskDetail,
  taskDiff,
  taskHistory,
} from './views/task-views.js';
import { taskUsageView } from './views/usage.js';

/** Fixtures up to this size are read to describe them ("CSV · 48 rows"); larger ones are named only. */
export const LABEL_READ_LIMIT = 8 * 1024 * 1024;
/** Tabular fixtures up to this size carry their preview inside Task detail. */
export const INLINE_PREVIEW_LIMIT = 64 * 1024;
/** Verifier sources shown on Task detail are cut at this many bytes. */
export const VERIFIER_SOURCE_LIMIT = 256 * 1024;

/** A fixture ready to stream: its row (path, hash, size) and the open blob. */
export interface FixtureDownload {
  file: TaskFileRow;
  /** The path as the agent sees it, e.g. `invoices.csv`. */
  path: string;
  stream: ReadStream;
}

@Injectable()
export class SuiteTasksService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    // Typed as the plain store so a test can hand in a BlobStore over a temp directory.
    @Inject(StorageService) private readonly storage: BlobStore,
  ) {}

  async detail(suiteId: string, key: string): Promise<TaskDetail> {
    const { suite, task } = await this.task(suiteId, key);
    const files = await filesOf(this.db, [task.id]);
    const [introducedIn, failures, usage, fixtures, homeTexts, verifier] = await Promise.all([
      task.introducedInSuiteId === suite.id ? suite : suiteById(this.db, task.introducedInSuiteId),
      failuresOf(this.db, suite, [task], new Map([[task.id, files]])),
      taskUsage(this.db, suite.sourcePath, task.key),
      Promise.all(files.filter((f) => f.kind === 'fixture').map((f) => this.fixtureView(f))),
      this.homeTexts(files),
      this.verifierOf(task, files),
    ]);
    return taskDetail({
      suite,
      task,
      introducedInSuiteVersion: introducedIn?.versionNumber ?? suite.versionNumber,
      fixtures,
      homeFiles: homeFileViews(task, files, homeTexts),
      verifier,
      failure: failures.get(task.key) ?? null,
      experiments: taskUsageView(usage),
    });
  }

  /** Every version of this task key in the directory of suite `suiteId`, newest first. */
  async history(suiteId: string, key: string): Promise<TaskVersionEntry[]> {
    const { suite } = await this.task(suiteId, key);
    const [rows, versions, source] = await Promise.all([
      keyRowsInDirectory(this.db, suite.sourcePath, [key]),
      versionsOf(this.db, suite.sourcePath),
      sourceOf(this.db, suite.sourcePath),
    ]);
    const files = groupByTask(
      await filesOf(
        this.db,
        rows.map((r) => r.task.id),
      ),
    );
    return taskHistory(
      rows.map((r) => ({ ...r, files: files.get(r.task.id) ?? [] })),
      new Map(versions.map((v) => [v.id, v])),
      source?.currentSuiteId ?? null,
    );
  }

  /** The task's changes from suite version `againstId` to suite version `suiteId`. */
  async diff(suiteId: string, key: string, againstId: string | undefined): Promise<TaskDiff> {
    if (!againstId)
      throw badRequest('against is required: the id of the suite version to compare with');
    const to = await this.task(suiteId, key);
    const against = await suiteById(this.db, againstId);
    if (!against) throw notFound(`suite ${againstId}`);
    if (against.sourcePath !== to.suite.sourcePath) {
      throw badRequest(`suite ${againstId} is not a version of ${to.suite.name}`);
    }
    const fromTask = await taskByKey(this.db, against.id, key);
    if (!fromTask) throw notFound(`task ${key} in suite ${againstId}`);
    const ids = [fromTask.id, to.task.id];
    const [files, roots] = await Promise.all([
      filesOf(this.db, ids).then(groupByTask),
      rootFilesOf(this.db, ids).then(groupByTask),
    ]);
    const fromFiles = files.get(fromTask.id) ?? [];
    const toFiles = files.get(to.task.id) ?? [];
    return taskDiff(
      { suite: against, task: fromTask, files: fromFiles },
      { ...to, files: toFiles },
      {
        rootFrom: roots.get(fromTask.id) ?? [],
        rootTo: roots.get(to.task.id) ?? [],
        texts: await this.diffTexts(fileChanges(fromFiles, toFiles)),
      },
    );
  }

  /** A fixture of the task, opened for download. */
  async fixture(suiteId: string, key: string, path: string): Promise<FixtureDownload> {
    const file = await this.fixtureRow(suiteId, key, path);
    if (!(await this.storage.exists(file.sha256))) {
      throw serverError(`fixture ${path} is missing from the blob store (sha256 ${file.sha256})`);
    }
    return { file, path: fixtureDisplayPath(file.path), stream: this.storage.stream(file.sha256) };
  }

  /** The first rows of a tabular fixture, or null when it is not tabular or does not parse. */
  async preview(suiteId: string, key: string, path: string): Promise<TablePreview | null> {
    const file = await this.fixtureRow(suiteId, key, path);
    const format = tabularFormatOf(file.path);
    if (!format) return null;
    if (!(await this.storage.exists(file.sha256))) {
      throw serverError(`fixture ${path} is missing from the blob store (sha256 ${file.sha256})`);
    }
    return streamTablePreview(this.storage.stream(file.sha256), format);
  }

  private async task(suiteId: string, key: string): Promise<{ suite: SuiteRow; task: TaskRow }> {
    const suite = await suiteById(this.db, suiteId);
    if (!suite) throw notFound(`suite ${suiteId}`);
    const task = await taskByKey(this.db, suite.id, key);
    if (!task) throw notFound(`task ${key}`);
    return { suite, task };
  }

  private async fixtureRow(suiteId: string, key: string, path: string): Promise<TaskFileRow> {
    const { task } = await this.task(suiteId, key);
    const files = await filesOf(this.db, [task.id]);
    const file = files.find((f) => f.kind === 'fixture' && fixtureDisplayPath(f.path) === path);
    if (!file) throw notFound(`fixture ${path}`);
    return file;
  }

  private async fixtureView(file: TaskFileRow): Promise<TaskFixtureFile> {
    const content = file.size <= LABEL_READ_LIMIT ? await this.readOrNull(file.sha256) : null;
    const format = tabularFormatOf(file.path);
    const preview =
      content && format && file.size <= INLINE_PREVIEW_LIMIT ? tablePreview(content, format) : null;
    return fixtureFileView(file, content, preview);
  }

  /**
   * The text of each small home file by hash (Phase 6 P1, P2), so a reviewer
   * reads a memory seed on Task detail; null when it is larger than
   * TASK_HOME_FILE_TEXT_LIMIT, not UTF-8, or gone from the blob store.
   */
  private async homeTexts(files: readonly TaskFileRow[]): Promise<Map<string, string | null>> {
    const kinds: readonly string[] = TASK_HOME_FILE_KINDS;
    const home = files.filter((f) => kinds.includes(f.kind));
    const texts = await Promise.all(
      home.map(async (f): Promise<[string, string | null]> => {
        if (f.size > TASK_HOME_FILE_TEXT_LIMIT) return [f.sha256, null];
        const content = await this.readOrNull(f.sha256);
        return [f.sha256, content ? utf8OrNull(content) : null];
      }),
    );
    return new Map(texts);
  }

  /**
   * The texts of the changed task files small enough for a line diff, by
   * sha256; null for one that is not UTF-8 or gone from the blob store.
   */
  private async diffTexts(changes: readonly TaskFileChange[]): Promise<Map<string, string | null>> {
    const hashes = new Set(
      changes.filter(isTextDiffCandidate).flatMap((c) => [c.before!.sha256, c.after!.sha256]),
    );
    const texts = await Promise.all(
      [...hashes].map(async (sha256): Promise<[string, string | null]> => {
        const content = await this.readOrNull(sha256);
        return [sha256, content ? utf8OrNull(content) : null];
      }),
    );
    return new Map(texts);
  }

  /** The script of the first verifier_script entry, from its stored file. */
  private async verifierOf(
    task: TaskRow,
    files: readonly TaskFileRow[],
  ): Promise<TaskDetail['verifier']> {
    const entry = task.verification.find((v) => v.type === 'verifier_script');
    const script = entry?.params.script;
    if (typeof script !== 'string') return null;
    const file = files.find((f) => f.kind === 'verifier' && f.path === `verify/${script}`);
    if (!file) return null;
    const content = await this.readOrNull(file.sha256);
    if (!content) return null;
    const source = new TextDecoder().decode(content.subarray(0, VERIFIER_SOURCE_LIMIT));
    return {
      path: file.path,
      sha256: file.sha256,
      source:
        content.length > VERIFIER_SOURCE_LIMIT
          ? `${source}\n… (${content.length - VERIFIER_SOURCE_LIMIT} more bytes not shown)`
          : source,
    };
  }

  /** A blob's bytes, or null when its file is gone; the page then shows the file without detail. */
  private async readOrNull(sha256: string): Promise<Buffer | null> {
    try {
      return await this.storage.read(sha256);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return null;
      throw err;
    }
  }
}

/** Bytes as text when they are valid UTF-8, else null. */
function utf8OrNull(content: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}
