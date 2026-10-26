/**
 * Collection of the home's memories/ (Phase 6 P2): the agent's memory files
 * as artifacts with root `home`, labelled against the seeds, read with the
 * workspace's safe walk; and collectTrialFiles, which runs both collections
 * on one budget and describes them in one `collected` event.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../../storage/blob-store.js';
import { collectTrialFiles } from './collect.js';
import { collectHomeMemories, type HomeSeedInput } from './collect-home.js';
import type { InputFile } from './materialise.js';

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const SEED_USER = 'Works in Lisbon.';
const SEED_MEMORY = 'ACME Ltd and ACME Limited are one vendor.';

let dir: string;
let home: string;
let workspace: string;
let outside: string;
let blobs: BlobStore;
let seeds: Map<string, HomeSeedInput>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collect-home-'));
  home = join(dir, 'home');
  workspace = join(dir, 'workspace');
  outside = join(dir, 'outside');
  await mkdir(join(home, 'memories'), { recursive: true });
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'blob store contents');
  blobs = new BlobStore(join(dir, 'data'));
  seeds = new Map([
    ['memories/USER.md', { sha256: sha(SEED_USER), size: SEED_USER.length }],
    ['memories/MEMORY.md', { sha256: sha(SEED_MEMORY), size: SEED_MEMORY.length }],
  ]);
});

afterEach(async () => {
  await chmod(home, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe('collectHomeMemories', () => {
  it('labels a modified seed, an unchanged seed and a file the agent wrote, and follows no link', async () => {
    const edited = `${SEED_USER}\n§\nPrefers reports in EUR.`;
    await writeFile(join(home, 'memories', 'USER.md'), edited);
    await writeFile(join(home, 'memories', 'MEMORY.md'), SEED_MEMORY);
    await writeFile(join(home, 'memories', 'notes.md'), 'mine');
    await symlink(join(outside, 'secret.txt'), join(home, 'memories', 'leak.md'));
    // Nothing else of the home is collected.
    await writeFile(join(home, 'config.yaml'), 'model: {}\n');
    await mkdir(join(home, 'skills'));
    await writeFile(join(home, 'skills', 'SKILL.md'), 'x');

    const collected = await collectHomeMemories(home, seeds, blobs, 1024 * 1024);
    expect(collected.artifacts).toEqual([
      {
        root: 'home',
        path: 'memories/MEMORY.md',
        origin: 'home_seed_unchanged',
        size: SEED_MEMORY.length,
        sha256: sha(SEED_MEMORY),
        skippedReason: null,
      },
      {
        root: 'home',
        path: 'memories/USER.md',
        origin: 'home_seed_modified',
        size: Buffer.byteLength(edited),
        sha256: sha(edited),
        skippedReason: null,
      },
      {
        root: 'home',
        path: 'memories/notes.md',
        origin: 'agent',
        size: 4,
        sha256: sha('mine'),
        skippedReason: null,
      },
    ]);
    expect(collected.notCollected).toEqual([
      { path: 'memories/leak.md', kind: 'symlink', detail: join(outside, 'secret.txt') },
    ]);
    expect(collected.deletedSeeds).toEqual([]);
    expect(collected.newBytes).toBe(SEED_MEMORY.length + Buffer.byteLength(edited) + 4);
    expect(await blobs.read(sha(edited))).toEqual(Buffer.from(edited));
    expect(await blobs.exists(sha('blob store contents'))).toBe(false);
  });

  it('lists the seeds the agent deleted, and needs no memories/ folder at all', async () => {
    await writeFile(join(home, 'memories', 'USER.md'), SEED_USER);
    const some = await collectHomeMemories(home, seeds, blobs, 1024);
    expect(some.artifacts.map((a) => [a.path, a.origin])).toEqual([
      ['memories/USER.md', 'home_seed_unchanged'],
    ]);
    expect(some.deletedSeeds).toEqual(['memories/MEMORY.md']);

    await rm(join(home, 'memories'), { recursive: true });
    expect(await collectHomeMemories(home, new Map(), blobs, 1024)).toEqual({
      artifacts: [],
      newBytes: 0,
      notCollected: [],
      deletedSeeds: [],
      truncated: false,
    });
  });

  it('never enters a memories/ that is a link, even to a folder full of files', async () => {
    await rm(join(home, 'memories'), { recursive: true });
    await symlink(outside, join(home, 'memories'));
    const collected = await collectHomeMemories(home, seeds, blobs, 1024);
    expect(collected.artifacts).toEqual([]);
    expect(collected.notCollected).toEqual([
      { path: 'memories', kind: 'symlink', detail: outside },
    ]);
    expect(collected.deletedSeeds).toEqual(['memories/MEMORY.md', 'memories/USER.md']);
  });

  it('gives back the permissions the agent took from the home and its memories/', async () => {
    await writeFile(join(home, 'memories', 'USER.md'), 'saved');
    await chmod(join(home, 'memories'), 0o000);
    await chmod(home, 0o000);
    const collected = await collectHomeMemories(home, new Map(), blobs, 1024);
    expect(collected.artifacts.map((a) => [a.path, a.origin])).toEqual([
      ['memories/USER.md', 'agent'],
    ]);
  });

  it('stores nothing past its budget, which is what the workspace left', async () => {
    await writeFile(join(home, 'memories', 'USER.md'), 'x'.repeat(100));
    const collected = await collectHomeMemories(home, new Map(), blobs, 10);
    expect(collected.artifacts).toEqual([
      {
        root: 'home',
        path: 'memories/USER.md',
        origin: 'agent',
        size: 100,
        sha256: null,
        skippedReason: 'over_budget',
      },
    ]);
  });
});

describe('collectTrialFiles', () => {
  const homeSeeds = () =>
    [...seeds].map(([path, seed]) => ({ path, sha256: seed.sha256, size: seed.size }));

  it('collects the workspace, then the memory files, into one list and one event', async () => {
    await writeFile(join(workspace, 'summary.csv'), 'vendor\nACME\n');
    await writeFile(join(home, 'memories', 'USER.md'), `${SEED_USER}\n§\nEUR`);
    const manifest = new Map<string, InputFile>();
    const { artifacts, event } = await collectTrialFiles({
      workspace,
      home,
      manifest,
      homeSeeds: homeSeeds(),
      blobs,
      now: () => 7,
    });
    expect(artifacts.map((a) => [a.root, a.path, a.origin])).toEqual([
      ['workspace', 'summary.csv', 'agent'],
      ['home', 'memories/USER.md', 'home_seed_modified'],
    ]);
    expect(event).toMatchObject({
      ts: 7,
      payload: {
        subtype: 'collected',
        files: 1,
        agent_files: 1,
        home_files: 1,
        home_agent_files: 0,
        home_not_collected: [],
        deleted_home_seeds: ['home/memories/MEMORY.md'],
      },
    });
  });

  it('shares one budget, the workspace first', async () => {
    await writeFile(join(workspace, 'big.txt'), 'w'.repeat(60));
    await writeFile(join(home, 'memories', 'USER.md'), 'h'.repeat(60));
    const { artifacts, event } = await collectTrialFiles({
      workspace,
      home,
      manifest: new Map(),
      homeSeeds: [],
      blobs,
      budgetBytes: 100,
    });
    expect(artifacts.map((a) => [a.root, a.skippedReason])).toEqual([
      ['workspace', null],
      ['home', 'over_budget'],
    ]);
    expect(event.payload).toMatchObject({ home_over_budget: ['home/memories/USER.md'] });
  });

  it('reads a home that is gone as one with nothing in it', async () => {
    const { artifacts, event } = await collectTrialFiles({
      workspace,
      home: join(dir, 'no-such-home'),
      manifest: new Map(),
      homeSeeds: homeSeeds(),
      blobs,
    });
    expect(artifacts).toEqual([]);
    expect(event.payload).toMatchObject({
      home_files: 0,
      deleted_home_seeds: ['home/memories/MEMORY.md', 'home/memories/USER.md'],
    });
  });

  it('keeps the workspace when the home cannot be collected', async () => {
    await writeFile(join(workspace, 'summary.csv'), 'vendor\n');
    await writeFile(join(home, 'memories', 'USER.md'), 'refused by the store');
    /** A blob store that fails on the memory file only. */
    class FailingStore extends BlobStore {
      override async putBuffer(content: Uint8Array) {
        if (Buffer.from(content).toString() === 'refused by the store')
          throw new Error('disk full');
        return super.putBuffer(content);
      }
    }
    const { artifacts, event } = await collectTrialFiles({
      workspace,
      home,
      manifest: new Map(),
      homeSeeds: [],
      blobs: new FailingStore(join(dir, 'data')),
    });
    expect(artifacts.map((a) => a.path)).toEqual(['summary.csv']);
    expect(event.payload).toMatchObject({ files: 1, home_files: 0, home_error: 'disk full' });
  });
});
