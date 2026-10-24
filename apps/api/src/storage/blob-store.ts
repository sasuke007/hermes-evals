/**
 * The content-addressed blob store on disk: every file the platform keeps is
 * stored once at DATA_DIR/blobs/<sha256> (plan 3.1). A file is written to
 * DATA_DIR/tmp, fsynced, and renamed into place, so a blob path either does
 * not exist or holds the complete content; the directory is fsynced so the
 * rename survives a crash. The `blobs` row is inserted only after that
 * (recordBlob), because a row promises the file exists.
 *
 * Blobs are never modified or deleted here. Two writers of the same content
 * race harmlessly: whichever renames last replaces identical bytes atomically.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { blobs } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';

/** What the store knows about one blob: its name and length. */
export interface BlobRef {
  sha256: string;
  size: number;
}

/** A scratch directory under DATA_DIR/tmp and the function that removes it. */
export interface ScratchDir {
  path: string;
  dispose(): Promise<void>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A blob name that is not 64 lowercase hex characters; never turned into a path. */
export class InvalidBlobHash extends Error {
  constructor(value: string) {
    super(`not a sha256 blob name: ${JSON.stringify(value.slice(0, 80))}`);
    this.name = 'InvalidBlobHash';
  }
}

/** recordBlob was asked to register a blob whose file is not in the store. */
export class BlobNotStored extends Error {
  constructor(sha256: string) {
    super(`blob ${sha256} is not in the store; write the file before recording it`);
    this.name = 'BlobNotStored';
  }
}

export const isSha256 = (value: string): boolean => SHA256.test(value);

const isMissing = (err: unknown): boolean => (err as { code?: unknown }).code === 'ENOENT';

export class BlobStore {
  readonly dataDir: string;
  readonly blobsDir: string;
  readonly tmpRoot: string;
  private ready: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.blobsDir = join(this.dataDir, 'blobs');
    this.tmpRoot = join(this.dataDir, 'tmp');
  }

  /** Stores `content` and returns its hash and size. Returns at once when the blob exists. */
  async putBuffer(content: Uint8Array): Promise<BlobRef> {
    const ref = {
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    };
    if (await this.exists(ref.sha256)) return ref;
    return this.write(async (temp) => {
      await pipeline([Buffer.from(content.buffer, content.byteOffset, content.length)], temp);
      return ref;
    });
  }

  /**
   * Stores the file at `path`, hashing it while it is copied, so it is read
   * once. Opens it first, so a missing file rejects before any temp file exists.
   */
  async putFile(path: string): Promise<BlobRef> {
    const handle = await open(path, 'r');
    return this.putStream(handle.createReadStream());
  }

  /**
   * Stores everything `source` yields, hashing it on the way. A Readable that
   * fails before the copy starts (while the store prepares its directories)
   * still rejects this call: its error is held and pipeline reports it.
   */
  putStream(source: Readable | AsyncIterable<Uint8Array>): Promise<BlobRef> {
    const early = () => {};
    if ('on' in source) source.on('error', early);
    return this.write(async (temp) => {
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Uint8Array | string>) {
          for await (const chunk of chunks) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            hash.update(bytes);
            size += bytes.length;
            yield bytes;
          }
        },
        temp,
      );
      return { sha256: hash.digest('hex'), size };
    }).finally(() => {
      if (!('off' in source)) return;
      source.off('error', early);
      // Closes the file of a source the copy never consumed, e.g. when tmp could not be created.
      if (!source.destroyed) source.destroy();
    });
  }

  /**
   * Registers a stored blob in the database, inside the caller's transaction
   * when given one. Idempotent. Refuses a blob whose file is missing: a row
   * means the file exists.
   */
  async recordBlob(db: AppDb, ref: BlobRef): Promise<void> {
    if (!(await this.exists(ref.sha256))) throw new BlobNotStored(ref.sha256);
    await db.insert(blobs).values({ sha256: ref.sha256, size: ref.size }).onConflictDoNothing();
  }

  /** Absolute path of a blob. Throws InvalidBlobHash for anything but lowercase hex sha256. */
  path(sha256: string): string {
    if (!isSha256(sha256)) throw new InvalidBlobHash(sha256);
    return join(this.blobsDir, sha256);
  }

  async read(sha256: string): Promise<Buffer> {
    return readFile(this.path(sha256));
  }

  stream(sha256: string): ReadStream {
    return createReadStream(this.path(sha256));
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.path(sha256))).isFile();
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  /** Creates a fresh directory DATA_DIR/tmp/<prefix>-XXXXXX. The caller removes it. */
  async tmpDir(prefix: string): Promise<string> {
    if (!PREFIX.test(prefix)) throw new Error(`invalid scratch prefix: ${prefix}`);
    await this.ensureDirs();
    return mkdtemp(join(this.tmpRoot, `${prefix}-`));
  }

  /** A fresh scratch directory and a dispose function that removes it and everything in it. */
  async scratchDir(prefix: string): Promise<ScratchDir> {
    const path = await this.tmpDir(prefix);
    return { path, dispose: () => rm(path, { recursive: true, force: true }) };
  }

  /**
   * Removes entries of DATA_DIR/tmp older than `maxAgeMs`: temp files of a
   * crashed write and scratch directories nobody disposed. Both the API and
   * the worker use tmp, so the age must exceed any scratch directory's life.
   */
  async sweepTmp(maxAgeMs: number, now = Date.now()): Promise<number> {
    await this.ensureDirs();
    let removed = 0;
    for (const name of await readdir(this.tmpRoot)) {
      const entry = join(this.tmpRoot, name);
      try {
        if (now - (await stat(entry)).mtimeMs < maxAgeMs) continue;
        await rm(entry, { recursive: true, force: true });
        removed++;
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
    return removed;
  }

  /**
   * Writes a temp file through `fill`, which pipes the content into the given
   * stream and returns the blob's hash and size, then moves it into place.
   * The stream fsyncs before it closes (`flush`).
   */
  private async write(fill: (temp: WriteStream) => Promise<BlobRef>): Promise<BlobRef> {
    await this.ensureDirs();
    const tempPath = join(this.tmpRoot, `blob-${randomUUID()}`);
    const temp = createWriteStream(tempPath, { flags: 'wx', mode: 0o644, flush: true });
    let ref: BlobRef;
    try {
      ref = await fill(temp);
      if (await this.exists(ref.sha256)) {
        await rm(tempPath, { force: true });
        return ref;
      }
      await rename(tempPath, this.path(ref.sha256));
    } catch (err) {
      // The stream opens its file asynchronously: one that fails before the
      // open finished still creates the file, so remove it only once closed.
      await closed(temp);
      await rm(tempPath, { force: true });
      throw err;
    }
    await syncDir(this.blobsDir);
    return ref;
  }

  private ensureDirs(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.blobsDir, { recursive: true });
      await mkdir(this.tmpRoot, { recursive: true });
    })().catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }
}

/** Resolves once `stream` has closed its file, destroying it first if it is still open. */
function closed(stream: WriteStream): Promise<void> {
  if (!stream.destroyed) stream.destroy();
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => stream.once('close', () => resolve()));
}

/** fsyncs a directory so a rename into it is durable. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } catch (err) {
    // Some filesystems cannot fsync a directory; the rename is still atomic there.
    const code = (err as { code?: unknown }).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw err;
  } finally {
    await handle.close();
  }
}
