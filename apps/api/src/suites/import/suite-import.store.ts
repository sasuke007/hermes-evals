/**
 * Validated suite zips waiting for their confirm (SA.10: validate, then
 * import). The zip's files are already in the blob store (readSuiteZip);
 * what waits here is the suite it holds, as the draft will take it: one
 * manifest.json under DATA_DIR/tmp/suite-imports/<token>/, written through a
 * rename so a confirm never reads half a file. The token is 32 random bytes
 * in hex and is the directory name, so a token that is not 64 hex
 * characters never becomes a path.
 *
 * A validation expires as a skill upload does (SKILL_UPLOAD_TTL_S, the TTL
 * of every validated upload). An expired manifest is kept a day so a late
 * confirm hears 410 (expired) rather than 404 (never existed); the sweep
 * removes it then, and StorageService's start-up sweep of DATA_DIR/tmp
 * clears anything older.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { DRAFT_FILE_KINDS, SuiteZipScriptSchema } from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { StorageService } from '../../storage/storage.service.js';
import type { SuiteZipContents } from './parsers.js';

const TOKEN = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** How long an expired manifest is kept to answer 410. */
const TOMBSTONE_MS = 24 * 3600 * 1000;
/** Sweeps run at least this often while the process lives. */
const MAX_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const DraftTaskFolderSchema = z.object({
  key: z.string(),
  taskYaml: z.string().nullable(),
  prompt: z.string().nullable(),
  reference: z.string().nullable(),
  rubrics: z.record(z.string(), z.string()),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(DRAFT_FILE_KINDS),
      sha256: z.string().regex(SHA256),
      size: z.number().int().nonnegative(),
    }),
  ),
});

/** What confirm needs: the zip's suite as the draft takes it, and what the dialog showed. */
export const SuiteZipManifestSchema = z.object({
  token: z.string().regex(TOKEN),
  fileName: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  suiteYaml: z.string(),
  suite: z.object({
    name: z.string(),
    versionLabel: z.string(),
    description: z.string().nullable(),
  }),
  tasks: z.array(DraftTaskFolderSchema),
  scripts: z.array(SuiteZipScriptSchema),
  fileCount: z.number().int().nonnegative(),
  unpackedBytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type SuiteZipManifest = z.infer<typeof SuiteZipManifestSchema>;

export type SuiteZipLookup =
  { state: 'ready'; manifest: SuiteZipManifest } | { state: 'expired' } | { state: 'unknown' };

const isMissing = (err: unknown): boolean => (err as { code?: unknown }).code === 'ENOENT';

@Injectable()
export class SuiteImportStore implements OnModuleInit, OnModuleDestroy {
  /** DATA_DIR/tmp/suite-imports */
  readonly root: string;
  readonly ttlMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    storage: StorageService,
    config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.root = join(storage.tmpRoot, 'suite-imports');
    this.ttlMs = config.get('SKILL_UPLOAD_TTL_S', { infer: true }) * 1000;
    this.logger.setContext(SuiteImportStore.name);
  }

  onModuleInit(): void {
    const every = Math.min(this.ttlMs, MAX_SWEEP_INTERVAL_MS);
    this.timer = setInterval(() => void this.sweepQuietly(), every);
    this.timer.unref();
    void this.sweepQuietly();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Keeps a validated zip's suite under a new token until it expires. */
  async save(
    fileName: string,
    sizeBytes: number,
    contents: SuiteZipContents,
    now = new Date(),
  ): Promise<SuiteZipManifest> {
    const token = randomBytes(32).toString('hex');
    const manifest: SuiteZipManifest = {
      token,
      fileName,
      sizeBytes,
      suiteYaml: contents.suiteYaml,
      suite: contents.suite,
      tasks: contents.tasks.map((t) => ({ ...t, rubrics: { ...t.rubrics }, files: [...t.files] })),
      scripts: contents.scripts,
      fileCount: contents.fileCount,
      unpackedBytes: contents.unpackedBytes,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    const dir = join(this.root, token);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'manifest.tmp'), JSON.stringify(manifest), { mode: 0o600 });
    await rename(join(dir, 'manifest.tmp'), join(dir, 'manifest.json'));
    return manifest;
  }

  async lookup(token: string, now = Date.now()): Promise<SuiteZipLookup> {
    if (!TOKEN.test(token)) return { state: 'unknown' };
    const manifest = await this.readManifest(token);
    if (!manifest) return { state: 'unknown' };
    if (Date.parse(manifest.expiresAt) <= now) return { state: 'expired' };
    return { state: 'ready', manifest };
  }

  /** Discards a validation, confirmed or not. */
  async remove(token: string): Promise<void> {
    if (!TOKEN.test(token)) return;
    await rm(join(this.root, token), { recursive: true, force: true });
  }

  /**
   * Removes manifests expired for a day, and directories of validations
   * that never finished (no manifest after the TTL). Returns how many.
   */
  async sweep(now = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isMissing(err)) return 0;
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      const dir = join(this.root, name);
      try {
        const manifest = TOKEN.test(name) ? await this.readManifest(name) : null;
        const stale = manifest
          ? now - Date.parse(manifest.expiresAt) >= TOMBSTONE_MS
          : now - (await stat(dir)).mtimeMs >= this.ttlMs;
        if (stale) {
          await rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
    return removed;
  }

  /** sweep(), logging instead of throwing: a failed sweep never fails a request. */
  async sweepQuietly(): Promise<void> {
    try {
      const removed = await this.sweep();
      if (removed > 0) this.logger.info({ removed }, 'swept expired suite imports');
    } catch (err) {
      this.logger.warn({ err }, 'could not sweep suite imports');
    }
  }

  private async readManifest(token: string): Promise<SuiteZipManifest | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, token, 'manifest.json'), 'utf8');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = SuiteZipManifestSchema.safeParse(json);
    return parsed.success && parsed.data.token === token ? parsed.data : null;
  }
}
