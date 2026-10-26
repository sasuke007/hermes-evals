/**
 * A world for the save specs: PGlite with every migration, a fresh
 * SUITES_DIR in a temporary directory holding copies of the fixture suites
 * and, when asked, of the five committed suites (read, never written), the
 * real loader, and the drafts service that opens drafts as the API does.
 */
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { DraftSaveProgress } from '@hermes-evals/shared';
import { suiteDrafts } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { BlobStore } from '../../storage/blob-store.js';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { baseTaskFolder } from '../drafts/draft-folder.js';
import { storedTasks, type DraftRow } from '../drafts/draft-store.js';
import { DraftWriter } from '../drafts/draft-writer.js';
import { sourceOf, suiteById } from '../suites.queries.js';
import { SuiteLoader, type LoaderLogger } from '../loader/suite-loader.js';
import { saveSuiteDraft, type SaveDraftOutput } from './save-draft.js';

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');
/** The committed suites; copied, never written. */
export const COMMITTED = join(import.meta.dirname, '../../../../../suites');
export const FIVE = ['invoices-v1', 'knowledge-v1', 'mcp-v1', 'memory-v1', 'tools-v1'];

export const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as LoaderLogger;

/**
 * A draft of `folder` on its current version, every task as stored, as
 * POST /suites/:suite/draft opens one; or, with `copyOf`, a new suite
 * `folder` copied from that folder's current version (POST /suites/drafts).
 */
export async function openDraft(
  db: AppDb,
  store: BlobStore,
  folder: string,
  copyOf?: string,
): Promise<void> {
  const source = await sourceOf(db, copyOf ?? folder);
  const current = await suiteById(db, source!.currentSuiteId!);
  const tasks = await storedTasks(db, current!);
  const read = (sha256: string) => store.read(sha256);
  await new DraftWriter(db, store).create(
    {
      sourcePath: folder,
      name: folder,
      origin: copyOf ? 'copy' : 'edit',
      baseSuiteId: copyOf ? null : current!.id,
      copiedFromSuiteId: copyOf ? current!.id : null,
      versionLabel: copyOf ? '0.1' : current!.versionLabel!,
      description: current!.description,
    },
    async (ctx) => {
      for (const t of tasks) {
        const { folder: files } = await baseTaskFolder(t.task, t.files, t.roots, read);
        await ctx.insert(files, {
          position: t.task.position,
          baseTaskId: copyOf ? null : t.task.id,
        });
      }
    },
  );
}

/** One entry of a folder snapshot: a file's hash and mode, or a link's target. */
export type Snapshot = Record<string, string>;

export class SaveWorld {
  readonly progress: Array<{ draftId: string; progress: DraftSaveProgress }> = [];
  readonly loader: SuiteLoader;
  /** The drafts' own writer: every change stored and checked as the API stores it. */
  readonly writer: DraftWriter;

  private constructor(
    readonly t: TestDatabase,
    readonly root: string,
    readonly suitesDir: string,
    readonly store: BlobStore,
  ) {
    this.loader = new SuiteLoader({ db: t.db, blobs: store, suitesDir, logger: quietLogger });
    this.writer = new DraftWriter(t.db, store);
  }

  static async create(options: { committed?: readonly string[] } = {}): Promise<SaveWorld> {
    const t = await createTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'hermes-evals-save-'));
    const suitesDir = join(root, 'suites');
    await cp(FIXTURES, suitesDir, { recursive: true });
    for (const suite of options.committed ?? []) {
      await cp(join(COMMITTED, suite), join(suitesDir, suite), { recursive: true });
    }
    return new SaveWorld(t, root, suitesDir, new BlobStore(join(root, 'data')));
  }

  async close(): Promise<void> {
    await this.t.close();
    await rm(this.root, { recursive: true, force: true });
  }

  /** Loads one folder and returns its entry. */
  async load(folder: string) {
    return (await this.loader.loadOne(folder)).suites[0]!;
  }

  /** A draft of `folder` (openDraft), as POST /suites/:suite/draft or a copy opens one. */
  async open(folder: string, copyOf?: string): Promise<DraftRow> {
    await openDraft(this.t.db, this.store, folder, copyOf);
    return this.draft(folder);
  }

  /** Sets the draft's version label, as Edit details does. */
  async label(folder: string, versionLabel: string): Promise<void> {
    await this.writer.write(folder, undefined, async (ctx) => {
      await ctx.tx
        .update(suiteDrafts)
        .set({ versionLabel })
        .where(eq(suiteDrafts.id, ctx.draft.id));
    });
  }

  async draft(folder: string): Promise<DraftRow> {
    const [row] = await this.t.db
      .select()
      .from(suiteDrafts)
      .where(eq(suiteDrafts.sourcePath, folder));
    if (!row) throw new Error(`no draft of ${folder}`);
    return row;
  }

  /** Claims the draft as the save endpoint does, and returns the job. */
  async claim(folder: string): Promise<{ draftId: string; claim: string }> {
    const draft = await this.draft(folder);
    const at = new Date();
    await this.t.db
      .update(suiteDrafts)
      .set({ saveStartedAt: at, saveProgress: null })
      .where(eq(suiteDrafts.id, draft.id));
    return { draftId: draft.id, claim: at.toISOString() };
  }

  /** Runs the worker's save of the draft of `folder`, as the job would. */
  async save(folder: string, job?: { draftId: string; claim: string }): Promise<SaveDraftOutput> {
    return saveSuiteDraft(job ?? (await this.claim(folder)), {
      db: this.t.db,
      blobs: this.store,
      suitesDir: this.suitesDir,
      logger: quietLogger,
      progress: async (draftId, _claim, progress) => {
        this.progress.push({ draftId, progress });
      },
    });
  }

  /** Every entry under SUITES_DIR (dot names included), path → content hash and mode, or link. */
  snapshot(dir = this.suitesDir): Promise<Snapshot> {
    return folderSnapshot(dir);
  }
}

/** Every entry under `dir` (dot names included), path → content hash and mode, or link. */
export async function folderSnapshot(dir: string, prefix = ''): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, rel);
    if (entry.isDirectory()) {
      Object.assign(out, await folderSnapshot(dir, rel));
    } else if (entry.isSymbolicLink()) {
      out[rel] = `link → ${await readlink(abs)}`;
    } else {
      const hash = createHash('sha256')
        .update(await readFile(abs))
        .digest('hex');
      out[rel] = `${hash.slice(0, 12)} ${((await lstat(abs)).mode & 0o777).toString(8)}`;
    }
  }
  return out;
}
