/**
 * Validated skill uploads waiting for their confirm (plan 5.1: nothing is
 * stored before confirm).
 *
 * Each validation gets DATA_DIR/tmp/skill-uploads/<token>/ holding `tree/`
 * (the unpacked skill) and, once it can be confirmed, `manifest.json`. The
 * token is 32 random bytes in hex and is the directory name, so a token that
 * is not 64 hex characters never becomes a path.
 *
 * An upload expires SKILL_UPLOAD_TTL_S after validation. The sweep removes
 * an expired upload's tree at once but keeps its small manifest for a day,
 * so a late confirm hears 410 (expired) rather than 404 (never existed).
 * StorageService's own start-up sweep of DATA_DIR/tmp clears anything older.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { StorageService } from '../../storage/storage.service.js';

const TOKEN = /^[0-9a-f]{64}$/;
/** How long an expired upload's manifest is kept to answer 410. */
const TOMBSTONE_MS = 24 * 3600 * 1000;
/** Sweeps run at least this often while the process lives. */
const MAX_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** What confirm needs to store the upload, written once validation passed. */
export const UploadManifestSchema = z.object({
  token: z.string().regex(TOKEN),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  fileCount: z.number().int().positive(),
  unpackedBytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type UploadManifest = z.infer<typeof UploadManifestSchema>;

/** A validation in progress: the directory to unpack into, and how to discard it. */
export interface PendingUpload {
  token: string;
  /** Unpack the zip here. */
  tree: string;
  dispose(): Promise<void>;
}

export type UploadLookup =
  | { state: 'ready'; manifest: UploadManifest; tree: string }
  | { state: 'expired' }
  | { state: 'unknown' };

const isMissing = (err: unknown): boolean => (err as { code?: unknown }).code === 'ENOENT';

@Injectable()
export class SkillUploadStore implements OnModuleInit, OnModuleDestroy {
  /** DATA_DIR/tmp/skill-uploads */
  readonly root: string;
  readonly ttlMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    storage: StorageService,
    config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.root = join(storage.tmpRoot, 'skill-uploads');
    this.ttlMs = config.get('SKILL_UPLOAD_TTL_S', { infer: true }) * 1000;
    this.logger.setContext(SkillUploadStore.name);
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

  /** Starts a validation: a fresh token and an empty tree directory. */
  async begin(): Promise<PendingUpload> {
    const token = randomBytes(32).toString('hex');
    const dir = join(this.root, token);
    const tree = join(dir, 'tree');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    await mkdir(tree, { mode: 0o700 });
    return { token, tree, dispose: () => rm(dir, { recursive: true, force: true }) };
  }

  /**
   * Makes a validated upload confirmable by writing its manifest, through a
   * rename so confirm never reads half a file.
   */
  async commit(
    pending: PendingUpload,
    fields: Omit<UploadManifest, 'token' | 'createdAt' | 'expiresAt'>,
    now = new Date(),
  ): Promise<UploadManifest> {
    const manifest: UploadManifest = {
      ...fields,
      token: pending.token,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    const dir = join(this.root, pending.token);
    await writeFile(join(dir, 'manifest.tmp'), JSON.stringify(manifest), { mode: 0o600 });
    await rename(join(dir, 'manifest.tmp'), join(dir, 'manifest.json'));
    return manifest;
  }

  /** Finds a confirmable upload. Its tree may already be gone if a confirm moved it. */
  async lookup(token: string, now = Date.now()): Promise<UploadLookup> {
    if (!TOKEN.test(token)) return { state: 'unknown' };
    const manifest = await this.readManifest(token);
    if (!manifest) return { state: 'unknown' };
    if (Date.parse(manifest.expiresAt) <= now) {
      await rm(join(this.root, token, 'tree'), { recursive: true, force: true });
      return { state: 'expired' };
    }
    return { state: 'ready', manifest, tree: join(this.root, token, 'tree') };
  }

  /** Discards an upload, confirmed or not. */
  async remove(token: string): Promise<void> {
    if (!TOKEN.test(token)) return;
    await rm(join(this.root, token), { recursive: true, force: true });
  }

  /**
   * Removes the trees of expired uploads, the manifests of uploads expired
   * for a day, and directories of validations that never finished (no
   * manifest after the TTL). Returns how many directories it touched.
   */
  async sweep(now = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isMissing(err)) return 0;
      throw err;
    }
    let touched = 0;
    for (const name of names) {
      const dir = join(this.root, name);
      const manifest = TOKEN.test(name) ? await this.readManifest(name) : null;
      try {
        if (manifest) {
          const expiredFor = now - Date.parse(manifest.expiresAt);
          if (expiredFor >= TOMBSTONE_MS) {
            await rm(dir, { recursive: true, force: true });
            touched++;
          } else if (expiredFor >= 0) {
            const tree = join(dir, 'tree');
            if (await exists(tree)) {
              await rm(tree, { recursive: true, force: true });
              touched++;
            }
          }
        } else if (now - (await stat(dir)).mtimeMs >= this.ttlMs) {
          await rm(dir, { recursive: true, force: true });
          touched++;
        }
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
    return touched;
  }

  /** sweep(), logging instead of throwing: a failed sweep never fails a request. */
  async sweepQuietly(): Promise<void> {
    try {
      const touched = await this.sweep();
      if (touched > 0) this.logger.info({ touched }, 'swept expired skill uploads');
    } catch (err) {
      this.logger.warn({ err }, 'could not sweep skill uploads');
    }
  }

  private async readManifest(token: string): Promise<UploadManifest | null> {
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
    const parsed = UploadManifestSchema.safeParse(json);
    return parsed.success && parsed.data.token === token ? parsed.data : null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}
