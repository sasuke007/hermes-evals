/**
 * SuiteImportStore: a validated zip's suite waits under its token, expires
 * after the TTL (410, not 404, for a day), and is swept after that.
 */
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configOf, silentLogger } from '../../resources/skills/testing.helper-spec.js';
import { BlobStore } from '../../storage/blob-store.js';
import type { StorageService } from '../../storage/storage.service.js';
import type { SuiteZipContents } from './parsers.js';
import { SuiteImportStore } from './suite-import.store.js';

const CONTENTS: SuiteZipContents = {
  suiteYaml: 'name: s\nversion_label: "1"\n',
  suite: { name: 's', versionLabel: '1', description: null },
  tasks: [
    {
      key: 't',
      taskYaml: 'summary: x\n',
      prompt: 'p\n',
      reference: '1\n',
      rubrics: { 'rubric.md': 'r\n' },
      files: [{ path: 'verify/check.py', kind: 'verifier', sha256: 'a'.repeat(64), size: 3 }],
    },
  ],
  scripts: [{ path: 't/verify/check.py', sizeBytes: 3, sha256: 'a'.repeat(64), runByCheck: true }],
  rootFilesNotKept: [],
  fileCount: 5,
  unpackedBytes: 30,
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let work: string;
let store: SuiteImportStore;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'suite-import-store-'));
  const storage = new BlobStore(work) as unknown as StorageService;
  store = new SuiteImportStore(storage, configOf({ SKILL_UPLOAD_TTL_S: 3600 }), silentLogger);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('SuiteImportStore', () => {
  it('keeps the suite under a 64-hex token and finds it until it expires', async () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    const saved = await store.save('s.zip', 100, CONTENTS, now);
    expect(saved.token).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.expiresAt).toBe('2026-10-26T13:00:00.000Z');
    const found = await store.lookup(saved.token, now.getTime() + HOUR - 1);
    expect(found).toEqual({ state: 'ready', manifest: saved });
    expect(await store.lookup(saved.token, now.getTime() + HOUR)).toEqual({ state: 'expired' });
  });

  it('never turns a token that is not 64 hex characters into a path', async () => {
    expect(await store.lookup('../../etc')).toEqual({ state: 'unknown' });
    expect(await store.lookup('f'.repeat(64))).toEqual({ state: 'unknown' });
    await store.remove('../../etc');
    expect(await readdir(work)).toEqual([]);
  });

  it('sweeps a manifest a day after it expired, and an unfinished validation after the TTL', async () => {
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    const fresh = await store.save('a.zip', 1, CONTENTS, new Date(now));
    const old = await store.save('b.zip', 1, CONTENTS, new Date(now - DAY - 2 * HOUR));
    const unfinished = join(store.root, 'b'.repeat(64));
    await mkdir(unfinished);
    await utimes(unfinished, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR));
    expect(await store.sweep(now)).toBe(2);
    expect(await readdir(store.root)).toEqual([fresh.token]);
    expect(await store.lookup(old.token, now)).toEqual({ state: 'unknown' });
  });
});
