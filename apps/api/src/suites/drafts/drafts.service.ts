/**
 * Suite drafts (plan 4.6; SA.1 to SA.3): open a draft of a suite folder on
 * its current version, start a new suite (empty, a copy of a suite, or a
 * validated zip), edit the suite's label, description and task order, and
 * discard. Every change goes through DraftWriter, so it is stored at once
 * and every touched task is checked again.
 *
 * A draft of a folder is built from the stored version, not from the disk
 * (the API has no suites mount): each task's texts are the loader's
 * recorded root files, or the task row's texts checked against the
 * version's content hash (draft-folder.ts baseTaskFolder), and its other
 * files are the version's blobs. Files the loader never stored (a README)
 * stay on disk, and the save keeps them as they are.
 *
 * Also the drafts side of the imports (DraftImportPort): the task import
 * adds tasks to an open draft, the zip import opens a new suite's draft.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type {
  CreateSuiteDraftRequest,
  DraftReview,
  DraftSummary,
  SuiteDraftView,
  UpdateSuiteDraftRequest,
} from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import { suiteDrafts, suiteDraftTasks } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { StorageService } from '../../storage/storage.service.js';
import { badRequest, notFound } from '../http-errors.js';
import type {
  DraftForImport,
  DraftImportPort,
  ImportedSuiteDraft,
} from '../import/draft-import.port.js';
import { SuiteZipImports } from '../import/suite-zip-imports.js';
import { sourceOf, suiteById } from '../suites.queries.js';
import type { SuiteRow } from '../views/rows.js';
import { baseTaskFolder } from './draft-folder.js';
import { draftViewOf, requireDraft, viewInput } from './draft-reads.js';
import { draftReview } from './draft-review.js';
import { recordOf } from './draft-evaluate.js';
import {
  draftHoldingName,
  folderHoldingName,
  folderOf,
  listDrafts,
  loadDraft,
  storedTasks,
  suiteVersion,
} from './draft-store.js';
import { draftSummary, draftView } from './draft-views.js';
import { conflict, DraftWriter, isSaving, type WriteContext } from './draft-writer.js';
import type { DraftTaskFolder } from './materialise.js';
import { suiteDisplayPath } from '../views/format.js';

@Injectable()
export class SuiteDraftsService implements DraftImportPort {
  readonly writer: DraftWriter;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() @Inject(SuiteZipImports) private readonly zips: SuiteZipImports | null = null,
  ) {
    this.writer = new DraftWriter(db, storage);
  }

  /** GET /suites/drafts: every open draft, last edited first. */
  async list(): Promise<DraftSummary[]> {
    const now = new Date();
    const drafts = await listDrafts(this.db);
    return Promise.all(drafts.map(async (d) => draftSummary(await draftViewOf(this.db, d, now))));
  }

  /** GET /suites/:suite/draft. */
  async view(folder: string): Promise<SuiteDraftView> {
    return draftViewOf(this.db, await requireDraft(this.db, folder), new Date());
  }

  /**
   * POST /suites/:suite/draft: the open draft of the folder, or a new one on
   * its current version, every task `unchanged`. 404 for a folder that
   * serves no version.
   */
  async open(folder: string): Promise<{ created: boolean; view: SuiteDraftView }> {
    const existing = await this.draftOrNull(folder);
    if (existing) return { created: false, view: existing };
    const source = await sourceOf(this.db, folder);
    const current = source?.currentSuiteId ? await suiteById(this.db, source.currentSuiteId) : null;
    if (!source || source.lastOutcome === 'missing' || current === null) {
      throw notFound(`suite ${folder}`);
    }
    const tasks = await storedTasks(this.db, current);
    const folders = await Promise.all(
      tasks.map(async (t) => ({
        id: t.task.id,
        position: t.task.position,
        folder: (await baseTaskFolder(t.task, t.files, t.roots, this.read)).folder,
      })),
    );
    try {
      await this.writer.create(
        {
          sourcePath: folder,
          name: current.name,
          origin: 'edit',
          baseSuiteId: current.id,
          versionLabel: current.versionLabel,
          description: current.description,
        },
        async (ctx) => {
          for (const t of folders)
            await ctx.insert(t.folder, { position: t.position, baseTaskId: t.id });
        },
      );
    } catch (err) {
      // Two opens raced: the other one's draft is the draft.
      const raced = await this.draftOrNull(folder);
      if (raced) return { created: false, view: raced };
      throw err;
    }
    return { created: true, view: await this.view(folder) };
  }

  /** POST /suites/drafts: a new suite, empty, copied from a suite version, or from a validated zip. */
  async create(request: CreateSuiteDraftRequest): Promise<SuiteDraftView> {
    const { from } = request;
    if (from.kind === 'zip') {
      const zips = this.zipImports();
      const taken = await zips.take(from.token, from.trustScripts);
      const view = await this.createImportedSuiteDraft({
        name: request.name,
        versionLabel: request.versionLabel,
        description: request.description ?? taken.manifest.suite.description,
        suiteYaml: taken.manifest.suiteYaml,
        tasks: taken.manifest.tasks,
        scriptsTrusted: taken.scriptsTrusted,
      });
      await zips.release(from.token);
      return view;
    }
    await this.assertNameFree(request.name);
    let copied: {
      suite: SuiteRow;
      tasks: { folder: DraftTaskFolder; record: ReturnType<typeof recordOf> }[];
    } | null = null;
    if (from.kind === 'copy') {
      const suite = await this.versionOf(from.suite, from.versionNumber);
      const tasks = await Promise.all(
        (await storedTasks(this.db, suite)).map(async (t) => ({
          folder: (await baseTaskFolder(t.task, t.files, t.roots, this.read)).folder,
          record: recordOf(t.task),
        })),
      );
      copied = { suite, tasks };
    }
    await this.writer.create(
      {
        sourcePath: request.name,
        name: request.name,
        origin: copied ? 'copy' : 'empty',
        copiedFromSuiteId: copied?.suite.id ?? null,
        versionLabel: request.versionLabel,
        description: request.description ?? null,
      },
      async (ctx) => {
        for (const t of copied?.tasks ?? []) await ctx.insert(t.folder, { selfCheck: t.record });
      },
    );
    return this.view(request.name);
  }

  /** PATCH /suites/:suite/draft: label, description, task order. */
  async update(folder: string, body: UpdateSuiteDraftRequest): Promise<SuiteDraftView> {
    await this.writer.write(folder, body.revision, async (ctx) => {
      const set: Partial<typeof suiteDrafts.$inferInsert> = {};
      if (body.versionLabel !== undefined) set.versionLabel = body.versionLabel;
      if (body.description !== undefined) set.description = body.description;
      if (Object.keys(set).length > 0) {
        await ctx.tx.update(suiteDrafts).set(set).where(eq(suiteDrafts.id, ctx.draft.id));
      }
      if (body.order !== undefined) await reorder(ctx, body.order);
    });
    return this.view(folder);
  }

  /** GET /suites/:suite/draft/review: what Save writes and what it creates. */
  async review(folder: string): Promise<DraftReview> {
    const draft = await requireDraft(this.db, folder);
    const input = await viewInput(this.db, draft, new Date());
    const baseStored = input.base.suite ? await storedTasks(this.db, input.base.suite) : [];
    const baseFolders = new Map(
      await Promise.all(
        baseStored.map(
          async (s) =>
            [
              s.task.id,
              (await baseTaskFolder(s.task, s.files, s.roots, this.read)).folder,
            ] as const,
        ),
      ),
    );
    const tasks = input.stored.tasks.map((row) => ({
      row,
      folder: folderOf(input.stored, row),
      base: row.baseTaskId ? (baseFolders.get(row.baseTaskId) ?? null) : null,
    }));
    return draftReview(draftView(input), tasks);
  }

  /** DELETE /suites/:suite/draft: the draft and its tasks go; nothing on disk changes. */
  async discard(folder: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(suiteDrafts)
        .where(eq(suiteDrafts.sourcePath, folder))
        .for('update');
      if (!draft) throw notFound(`draft of ${folder}`);
      if (isSaving(draft, new Date()))
        throw conflict(`${folder} is being saved; discard it after the save ends`);
      await tx.delete(suiteDrafts).where(eq(suiteDrafts.id, draft.id));
    });
  }

  // DraftImportPort ----------------------------------------------------------

  async draftForImport(folder: string): Promise<DraftForImport | null> {
    const draft = await this.draftRow(folder);
    if (!draft) return null;
    const stored = await loadDraft(this.db, draft);
    return { tasks: stored.tasks.map((t) => folderOf(stored, t)) };
  }

  async addImportedTasks(
    folder: string,
    tasks: readonly DraftTaskFolder[],
  ): Promise<SuiteDraftView> {
    await this.writer.write(folder, undefined, async (ctx) => {
      for (const task of tasks) await ctx.insert(task, {});
    });
    return this.view(folder);
  }

  async createImportedSuiteDraft(draft: ImportedSuiteDraft): Promise<SuiteDraftView> {
    await this.assertNameFree(draft.name);
    await this.writer.create(
      {
        sourcePath: draft.name,
        name: draft.name,
        origin: 'zip',
        versionLabel: draft.versionLabel,
        description: draft.description,
        scriptsTrustedAt: draft.scriptsTrusted ? new Date() : null,
      },
      async (ctx) => {
        for (const task of draft.tasks) await ctx.insert(task, {});
      },
    );
    return this.view(draft.name);
  }

  // --------------------------------------------------------------------------

  private readonly read = (sha256: string) => this.storage.read(sha256);

  /** The validated zips (SuiteZipModule); a service built without them imports no zip. */
  private zipImports(): SuiteZipImports {
    if (this.zips) return this.zips;
    throw badRequest('importing a suite zip is not available');
  }

  private async draftRow(folder: string) {
    const [row] = await this.db
      .select()
      .from(suiteDrafts)
      .where(eq(suiteDrafts.sourcePath, folder));
    return row ?? null;
  }

  private async draftOrNull(folder: string): Promise<SuiteDraftView | null> {
    const draft = await this.draftRow(folder);
    return draft ? draftViewOf(this.db, draft, new Date()) : null;
  }

  /** 409 when a suite folder, a suite name or another draft holds `name` (SA.2's wording). */
  private async assertNameFree(name: string): Promise<void> {
    const holder =
      (await folderHoldingName(this.db, name)) ?? (await draftHoldingName(this.db, name));
    if (holder !== null) throw conflict(`${name} is already used by ${suiteDisplayPath(holder)}.`);
  }

  /** A suite folder's version `n`, or its current version. */
  private async versionOf(folder: string, n: number | undefined): Promise<SuiteRow> {
    if (n !== undefined) {
      const suite = await suiteVersion(this.db, folder, n);
      if (!suite) throw notFound(`version ${n} of ${folder}`);
      return suite;
    }
    const source = await sourceOf(this.db, folder);
    const suite = source?.currentSuiteId ? await suiteById(this.db, source.currentSuiteId) : null;
    if (!suite) throw notFound(`suite ${folder}`);
    return suite;
  }
}

/** Positions from `order`, which must name every task of the draft once. */
async function reorder(ctx: WriteContext, order: readonly string[]): Promise<void> {
  const keys = ctx.stored.tasks.map((t) => t.key);
  if (order.length !== keys.length || !order.every((k) => keys.includes(k))) {
    throw badRequest('the order must list every task of the draft once, removed ones included');
  }
  for (const [position, key] of order.entries()) {
    const task = ctx.task(key);
    if (task.position === position) continue;
    await ctx.tx
      .update(suiteDraftTasks)
      .set({ position, updatedAt: ctx.now })
      .where(eq(suiteDraftTasks.id, task.id));
  }
}
