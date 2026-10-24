import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { blobs } from '../database/schema/index.js';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { BlobNotStored, BlobStore, InvalidBlobHash } from './blob-store.js';
import { StorageService } from './storage.service.js';

const sha = (content: Uint8Array | string): string =>
  createHash('sha256').update(content).digest('hex');

let dataDir: string;
let store: BlobStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'blob-store-'));
  store = new BlobStore(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const tmpEntries = () => readdir(join(dataDir, 'tmp'));

describe('BlobStore', () => {
  it('stores a buffer under its sha256 and leaves nothing in tmp', async () => {
    const content = Buffer.from('id,amount\nINV-1,10.00\n');
    const ref = await store.putBuffer(content);
    expect(ref).toEqual({ sha256: sha(content), size: content.length });
    expect(store.path(ref.sha256)).toBe(join(dataDir, 'blobs', ref.sha256));
    expect(await readFile(store.path(ref.sha256))).toEqual(content);
    expect(await store.read(ref.sha256)).toEqual(content);
    expect(await store.exists(ref.sha256)).toBe(true);
    expect(await tmpEntries()).toEqual([]);
  });

  it('hashes a file while copying it, matching the buffer hash, for empty and large files', async () => {
    const large = randomBytes(3 * 1024 * 1024 + 17);
    for (const content of [Buffer.alloc(0), large]) {
      const source = join(dataDir, 'source.bin');
      await writeFile(source, content);
      const ref = await store.putFile(source);
      expect(ref).toEqual({ sha256: sha(content), size: content.length });
      expect(sha(await store.read(ref.sha256))).toBe(ref.sha256);
    }
    expect(await tmpEntries()).toEqual([]);
  });

  it('stores what a stream yields, strings included', async () => {
    const ref = await store.putStream(Readable.from(['abc', Buffer.from('def')]));
    expect(ref).toEqual({ sha256: sha('abcdef'), size: 6 });
    const chunks: Buffer[] = [];
    for await (const chunk of store.stream(ref.sha256)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');
  });

  it('is idempotent, and concurrent puts of the same content end with one intact file', async () => {
    const content = randomBytes(256 * 1024);
    const source = join(dataDir, 'same.bin');
    await writeFile(source, content);
    const refs = await Promise.all([
      ...Array.from({ length: 6 }, () => store.putBuffer(content)),
      ...Array.from({ length: 6 }, () => store.putFile(source)),
    ]);
    expect(new Set(refs.map((r) => r.sha256))).toEqual(new Set([sha(content)]));
    expect(await readdir(join(dataDir, 'blobs'))).toEqual([sha(content)]);
    expect(await store.read(sha(content))).toEqual(content);
    expect(await tmpEntries()).toEqual([]);
    expect(await store.putBuffer(content)).toEqual(refs[0]);
  });

  it('refuses names that are not lowercase hex sha256', async () => {
    for (const bad of [
      'abc',
      '../../etc/passwd',
      sha('x').toUpperCase(),
      `${sha('x').slice(0, 63)}g`,
      `${sha('x')}/..`,
      '',
    ]) {
      expect(() => store.path(bad), bad).toThrow(InvalidBlobHash);
      await expect(store.exists(bad)).rejects.toThrow(InvalidBlobHash);
      await expect(store.read(bad)).rejects.toThrow(InvalidBlobHash);
    }
    expect(await store.exists(sha('never stored'))).toBe(false);
  });

  it('leaves no temp file when the source is missing or fails part way', async () => {
    await expect(store.putFile(join(dataDir, 'missing.csv'))).rejects.toThrow(/ENOENT/);
    async function* failing() {
      yield Buffer.from('partial');
      throw new Error('disk went away');
    }
    await expect(store.putStream(failing())).rejects.toThrow('disk went away');
    expect(await tmpEntries()).toEqual([]);
    expect(await readdir(join(dataDir, 'blobs'))).toEqual([]);
  });

  it('leaves no temp file when the source fails before the temp file has opened', async () => {
    // Fails before its first chunk, so the copy ends while the temp file is still opening.
    // eslint-disable-next-line require-yield
    async function* broken(): AsyncGenerator<Uint8Array> {
      throw new Error('nothing to read');
    }
    for (let i = 0; i < 20; i += 1) {
      await expect(store.putStream(broken())).rejects.toThrow('nothing to read');
    }
    expect(await tmpEntries()).toEqual([]);
  });

  it('makes scratch directories under DATA_DIR/tmp that dispose removes', async () => {
    const scratch = await store.scratchDir('skill-upload');
    expect(scratch.path.startsWith(join(dataDir, 'tmp', 'skill-upload-'))).toBe(true);
    await writeFile(join(scratch.path, 'SKILL.md'), '# skill');
    await scratch.dispose();
    await expect(stat(scratch.path)).rejects.toThrow(/ENOENT/);
    await scratch.dispose();
    await expect(store.tmpDir('../escape')).rejects.toThrow(/invalid scratch prefix/);
  });

  it('sweeps only old entries from tmp', async () => {
    const fresh = await store.tmpDir('fresh');
    const stale = await store.tmpDir('stale');
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(stale, old, old);
    expect(await store.sweepTmp(3600_000)).toBe(1);
    expect(await tmpEntries()).toEqual([fresh.split('/').pop()]);
  });
});

describe('BlobStore.recordBlob', () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it('records a stored blob once, and refuses to record one whose file is missing', async () => {
    const ref = await store.putBuffer(Buffer.from('policy'));
    await t.db.transaction(async (tx) => {
      await store.recordBlob(tx, ref);
      await store.recordBlob(tx, ref);
    });
    const rows = await t.db.select().from(blobs).where(eq(blobs.sha256, ref.sha256));
    expect(rows.map((r) => ({ sha256: r.sha256, size: r.size }))).toEqual([ref]);
    await expect(store.recordBlob(t.db, { sha256: sha('ghost'), size: 5 })).rejects.toThrow(
      BlobNotStored,
    );
    expect(await t.db.select().from(blobs)).toHaveLength(1);
  });
});

describe('StorageService', () => {
  it('opens the store at DATA_DIR and clears day-old leftovers from tmp at start', async () => {
    const config = { get: () => dataDir } as unknown as ConfigService<Env, true>;
    const logger = {
      setContext: () => {},
      info: () => {},
      warn: () => {},
    } as unknown as PinoLogger;
    const service = new StorageService(config, logger);
    const leftover = await service.tmpDir('crashed');
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(leftover, old, old);
    const kept = await service.tmpDir('in-use');
    await service.onModuleInit();
    expect(await tmpEntries()).toEqual([kept.split('/').pop()]);
    const ref = await service.putBuffer(Buffer.from('x'));
    expect(service.path(ref.sha256)).toBe(join(dataDir, 'blobs', sha('x')));
  });
});
