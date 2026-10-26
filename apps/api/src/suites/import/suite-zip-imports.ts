/**
 * Suite zips, validated and then confirmed (SA.10, R7). Validation reads the
 * zip into the blob store (readSuiteZip), runs each task's readiness rules
 * (no code: checks that need the worker stay `not_run`), checks the name and
 * keeps the suite under a token. Taking a token for a draft refuses a zip
 * with verifier scripts unless the user trusted them, and records every
 * blob the draft will name.
 *
 * Its own provider, apart from the routes, so the drafts module can open a
 * zip draft too (POST /suites/drafts with `from: zip`) without depending on
 * the import routes, which depend on it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import {
  READINESS_RULE_LABELS,
  type SuiteZipTask,
  type SuiteZipValidation,
} from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import { blobs } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { uploadFileName } from '../../resources/skills/format.js';
import { conflict, gone, notFound } from '../../resources/skills/http.js';
import type { UploadedFileRef } from '../../resources/skills/multipart-upload.js';
import type { BlobRef } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import { suiteDisplayPath } from '../views/format.js';
import type { DraftFileRef, DraftTaskFolder } from '../drafts/materialise.js';
import { evaluateReadiness } from '../drafts/readiness.js';
import { readSuiteZip, type SuiteZipContents } from './parsers.js';
import { freeSuiteName, suiteNameHolder } from './suite-names.js';
import { SuiteImportStore, type SuiteZipManifest } from './suite-import.store.js';

/** Rows inserted per statement when blobs are recorded. */
const BLOB_BATCH = 500;

/** A validated zip, taken for a draft. */
export interface TakenSuiteZip {
  manifest: SuiteZipManifest;
  /** True when the zip holds verifier scripts, which the user trusted (scripts_trusted_at). */
  scriptsTrusted: boolean;
}

/** The message 409 answers with while scripts wait for "I trust these scripts". */
export const CONFIRM_SCRIPTS = 'Confirm the verifier scripts first.';

/**
 * Records the blobs `files` name (blobs rows), each one checked to be in the
 * store first: a row promises the file exists. Idempotent.
 */
export async function recordDraftBlobs(
  db: AppDb,
  storage: Pick<StorageService, 'exists'>,
  files: readonly DraftFileRef[],
): Promise<void> {
  const refs = new Map<string, BlobRef>(
    files.map((f) => [f.sha256, { sha256: f.sha256, size: f.size }]),
  );
  const known = new Set<string>();
  const shas = [...refs.keys()];
  for (let i = 0; i < shas.length; i += BLOB_BATCH) {
    const rows = await db
      .select({ sha256: blobs.sha256 })
      .from(blobs)
      .where(inArray(blobs.sha256, shas.slice(i, i + BLOB_BATCH)));
    for (const row of rows) known.add(row.sha256);
  }
  const missing = [...refs.values()].filter((r) => !known.has(r.sha256));
  for (const ref of missing) {
    if (!(await storage.exists(ref.sha256))) {
      throw gone('the files of this import are no longer stored; upload them again');
    }
  }
  for (let i = 0; i < missing.length; i += BLOB_BATCH) {
    await db
      .insert(blobs)
      .values(missing.slice(i, i + BLOB_BATCH).map(({ sha256, size }) => ({ sha256, size })))
      .onConflictDoNothing();
  }
}

@Injectable()
export class SuiteZipImports {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly storage: StorageService,
    private readonly store: SuiteImportStore,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SuiteZipImports.name);
  }

  /** POST /suites/import/validate: what the zip holds, and a token when it can be imported. */
  async validate(upload: UploadedFileRef): Promise<SuiteZipValidation> {
    await this.store.sweepQuietly();
    const fileName = uploadFileName(upload.originalname, 'suite.zip');
    const read = await readSuiteZip(upload.path, this.storage);
    if (!read.ok) {
      return {
        token: null,
        fileName,
        sizeBytes: upload.size,
        outcome: 'rejected',
        suite: null,
        nameTaken: null,
        tasks: [],
        scripts: [],
        verifyCounts: { files: 0, checkScripts: 0 },
        rootFilesNotKept: [],
        fileCount: read.fileCount,
        unpackedBytes: read.unpackedBytes,
        problems: read.problems,
      };
    }
    const { contents } = read;
    const tasks = await this.zipTasks(contents);
    const holder = await suiteNameHolder(this.db, contents.suite.name);
    const manifest = await this.store.save(fileName, upload.size, contents);
    this.logger.info(
      { token: manifest.token.slice(0, 8), suite: contents.suite.name, tasks: tasks.length },
      'validated suite zip',
    );
    return {
      token: manifest.token,
      fileName,
      sizeBytes: upload.size,
      outcome: holder === null ? 'valid' : 'name_taken',
      suite: contents.suite,
      nameTaken:
        holder === null
          ? null
          : {
              path: suiteDisplayPath(holder),
              suggestion: await freeSuiteName(this.db, contents.suite.name),
            },
      tasks,
      scripts: contents.scripts,
      verifyCounts: {
        files: contents.scripts.length,
        checkScripts: contents.scripts.filter((s) => s.runByCheck).length,
      },
      rootFilesNotKept: contents.rootFilesNotKept,
      fileCount: contents.fileCount,
      unpackedBytes: contents.unpackedBytes,
      problems: [],
    };
  }

  /**
   * A validated zip for a new draft: 404 for a token never issued, 410 once
   * it expired, 409 while its scripts wait for `trustScripts` (R7). Every
   * blob its tasks name is recorded. The caller opens the draft, then calls
   * release.
   */
  async take(token: string, trustScripts: boolean): Promise<TakenSuiteZip> {
    const found = await this.store.lookup(token);
    if (found.state === 'unknown') {
      throw notFound('no suite import has this token; validate the zip again');
    }
    if (found.state === 'expired') throw gone('this suite import expired; validate the zip again');
    const { manifest } = found;
    if (manifest.scripts.length > 0 && !trustScripts) throw conflict(CONFIRM_SCRIPTS);
    await recordDraftBlobs(
      this.db,
      this.storage,
      manifest.tasks.flatMap((t) => t.files),
    );
    return { manifest, scriptsTrusted: manifest.scripts.length > 0 };
  }

  /** Refuses a name a suite folder, a suite name or a draft holds (409, SA.2's wording). */
  async assertNameFree(name: string): Promise<void> {
    const holder = await suiteNameHolder(this.db, name);
    if (holder !== null) throw conflict(`${name} is already used by ${suiteDisplayPath(holder)}.`);
  }

  /** Discards a token once its draft exists. */
  release(token: string): Promise<void> {
    return this.store.remove(token);
  }

  /** Each task as the dialog lists it, from the readiness rules that run without code. */
  private async zipTasks(contents: SuiteZipContents): Promise<SuiteZipTask[]> {
    const keys = contents.tasks.map((t) => t.key);
    const out: SuiteZipTask[] = [];
    for (const task of contents.tasks) {
      const { readiness, analysis } = await evaluateReadiness(task, {
        folder: contents.suite.name,
        otherKeys: keys.filter((k) => k !== task.key),
        renamedFrom: null,
        readBlob: (sha256) => this.storage.read(sha256),
        lastSelfCheck: null,
      });
      const first = readiness.rules.find((r) => r.status === 'problem');
      out.push({
        key: task.key,
        summary: analysis.summary,
        readiness: readiness.summary,
        problem: first ? first.message || READINESS_RULE_LABELS[first.rule] : null,
        workspaceFiles: workspaceFileCount(task),
        checks: analysis.verification.length,
      });
    }
    return out;
  }
}

const workspaceFileCount = (task: DraftTaskFolder): number =>
  task.files.filter((f) => f.kind === 'fixture').length;
