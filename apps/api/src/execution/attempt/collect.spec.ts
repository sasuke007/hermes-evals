import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ARTIFACT_BYTES } from '../../sandbox/trial-files.js';
import { BlobStore } from '../../storage/blob-store.js';
import { isMemoryLockFile } from './collect-files.js';
import { collectTrialFiles, collectWorkspace } from './collect.js';
import type { InputFile } from './materialise.js';

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

let dir: string;
let workspace: string;
let blobs: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collect-'));
  workspace = join(dir, 'workspace');
  await mkdir(workspace);
  blobs = new BlobStore(join(dir, 'data'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('collectWorkspace', () => {
  it('labels unchanged and modified inputs, agent files, and inputs the agent deleted', async () => {
    await writeFile(join(workspace, 'a.csv'), 'same');
    await mkdir(join(workspace, 'docs'));
    await writeFile(join(workspace, 'docs/policy.md'), 'edited');
    await writeFile(join(workspace, 'new.txt'), 'mine');
    const manifest = new Map<string, InputFile>([
      ['a.csv', { source: 'fixture', sha256: sha('same'), size: 4 }],
      ['b.csv', { source: 'fixture', sha256: sha('gone'), size: 4 }],
      ['docs/policy.md', { source: 'document', sha256: sha('original'), size: 8 }],
    ]);
    const { artifacts, event } = await collectWorkspace(workspace, manifest, blobs, () => 42);
    expect(artifacts).toEqual([
      {
        root: 'workspace',
        path: 'a.csv',
        origin: 'fixture_unchanged',
        size: 4,
        sha256: sha('same'),
        skippedReason: null,
      },
      {
        root: 'workspace',
        path: 'docs/policy.md',
        origin: 'document_modified',
        size: 6,
        sha256: sha('edited'),
        skippedReason: null,
      },
      {
        root: 'workspace',
        path: 'new.txt',
        origin: 'agent',
        size: 4,
        sha256: sha('mine'),
        skippedReason: null,
      },
    ]);
    expect(await blobs.read(sha('mine'))).toEqual(Buffer.from('mine'));
    expect(event).toMatchObject({
      ts: 42,
      type: 'platform',
      payload: {
        subtype: 'collected',
        files: 3,
        stored: 3,
        stored_bytes: 14,
        agent_files: 1,
        deleted_inputs: ['b.csv'],
        deleted_input_count: 1,
        truncated: false,
      },
    });
  });

  it('reads an oversized input in full only to tell whether it is unchanged, and stores none', async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 10, 0x62);
    await writeFile(join(workspace, 'big.bin'), big);
    await writeFile(join(workspace, 'grown.bin'), Buffer.concat([big, Buffer.from('x')]));
    const manifest = new Map<string, InputFile>([
      ['big.bin', { source: 'fixture', sha256: sha(big), size: big.length }],
      ['grown.bin', { source: 'fixture', sha256: sha(big), size: big.length }],
    ]);
    const { artifacts } = await collectWorkspace(workspace, manifest, blobs);
    expect(artifacts).toEqual([
      {
        root: 'workspace',
        path: 'big.bin',
        origin: 'fixture_unchanged',
        size: big.length,
        sha256: null,
        skippedReason: 'too_large',
      },
      {
        root: 'workspace',
        path: 'grown.bin',
        origin: 'fixture_modified',
        size: big.length + 1,
        sha256: null,
        skippedReason: 'too_large',
      },
    ]);
  });

  it('stores no more than the budget, charging apparent size, so sparse files cannot amplify', async () => {
    // `truncate -s 25M f$i; printf $i | dd of=f$i conv=notrunc`: almost no disk, all distinct.
    const files = 6;
    for (let i = 0; i < files; i += 1) {
      const handle = await open(join(workspace, `f${i}`), 'w');
      await handle.write(Buffer.from(String(i)), 0, 1, 0);
      await handle.truncate(MAX_ARTIFACT_BYTES);
      await handle.close();
    }
    const budget = Math.floor(MAX_ARTIFACT_BYTES * 2.5);
    const { artifacts, event } = await collectWorkspace(
      workspace,
      new Map(),
      blobs,
      Date.now,
      budget,
    );

    const stored = artifacts.filter((a) => a.sha256 !== null);
    expect(stored.map((a) => a.path)).toEqual(['f0', 'f1']);
    expect(artifacts.slice(2)).toEqual(
      ['f2', 'f3', 'f4', 'f5'].map((path) => ({
        root: 'workspace',
        path,
        origin: 'agent',
        size: MAX_ARTIFACT_BYTES,
        sha256: null,
        skippedReason: 'over_budget',
      })),
    );
    expect(event.payload).toMatchObject({
      stored: 2,
      stored_bytes: 2 * MAX_ARTIFACT_BYTES,
      budget_exceeded: true,
      budget_bytes: budget,
      over_budget: ['f2', 'f3', 'f4', 'f5'],
      over_budget_count: 4,
    });
    expect(Number(event.payload['stored_bytes'])).toBeLessThanOrEqual(budget);
    // What the blob store holds on disk stays within the budget too.
    const blobDir = join(dir, 'data', 'blobs');
    let allocated = 0;
    for (const name of await readdir(blobDir))
      allocated += (await stat(join(blobDir, name))).blocks * 512;
    expect(allocated).toBeLessThanOrEqual(budget);
  });

  it('charges only content the store does not hold, so an unchanged input never uses the budget', async () => {
    const fixture = Buffer.from('id,amount\n1,10\n');
    await blobs.putBuffer(fixture);
    await writeFile(join(workspace, 'a.csv'), fixture);
    await writeFile(join(workspace, 'b.txt'), 'new content');
    const manifest = new Map<string, InputFile>([
      ['a.csv', { source: 'fixture', sha256: sha(fixture), size: fixture.length }],
    ]);
    // A budget smaller than either file: the input is still stored and recognised, the new file is not.
    const { artifacts, event } = await collectWorkspace(workspace, manifest, blobs, Date.now, 5);
    expect(artifacts).toEqual([
      {
        root: 'workspace',
        path: 'a.csv',
        origin: 'fixture_unchanged',
        size: fixture.length,
        sha256: sha(fixture),
        skippedReason: null,
      },
      {
        root: 'workspace',
        path: 'b.txt',
        origin: 'agent',
        size: 11,
        sha256: null,
        skippedReason: 'over_budget',
      },
    ]);
    expect(event.payload).toMatchObject({ stored_bytes: fixture.length, new_bytes: 0 });
  });
});

describe('collectTrialFiles: the memory tool’s lock files (Phase 6 #2)', () => {
  const SEED = 'Works in Lisbon.';
  const SAVED = `${SEED}\n§\nPrefers reports in EUR.`;

  it('skips *.lock under memories/ and keeps every other file, *.bak.* included', async () => {
    const home = join(dir, 'home');
    const memories = join(home, 'memories');
    await mkdir(join(memories, 'archive'), { recursive: true });
    await writeFile(join(memories, 'USER.md'), SAVED);
    // What Hermes's memory tool leaves beside the stores it wrote, and its drift snapshot.
    await writeFile(join(memories, 'USER.md.lock'), '');
    await writeFile(join(memories, 'MEMORY.md.lock'), '');
    await writeFile(join(memories, 'USER.md.bak.1761400000'), SEED);
    await writeFile(join(memories, 'archive', 'old.lock'), 'not empty, still a lock file');
    await writeFile(join(memories, 'notes.lock.md'), 'a note, not a lock');
    await symlink(join(memories, 'USER.md'), join(memories, 'link.lock'));
    // The rule is the home's: a workspace file of the same kind and path is an artifact.
    await mkdir(join(workspace, 'memories'), { recursive: true });
    await writeFile(join(workspace, 'memories', 'build.lock'), '');

    const { artifacts, event } = await collectTrialFiles({
      workspace,
      home,
      manifest: new Map(),
      homeSeeds: [{ path: 'memories/USER.md', sha256: sha(SEED), size: SEED.length }],
      blobs,
    });
    expect(artifacts.map((a) => [a.root, a.path, a.origin])).toEqual([
      ['workspace', 'memories/build.lock', 'agent'],
      ['home', 'memories/USER.md', 'home_seed_modified'],
      ['home', 'memories/USER.md.bak.1761400000', 'agent'],
      ['home', 'memories/notes.lock.md', 'agent'],
    ]);
    expect(event.payload).toMatchObject({
      files: 1,
      home_files: 3,
      home_agent_files: 2,
      // A link is never collected, whatever its name: it stays listed.
      home_not_collected: [{ path: 'home/memories/link.lock', kind: 'symlink' }],
      home_not_collected_count: 1,
      deleted_home_seeds: [],
    });
  });

  it('collects nothing from a memories/ folder that holds only lock files', async () => {
    const home = join(dir, 'home');
    await mkdir(join(home, 'memories'), { recursive: true });
    await writeFile(join(home, 'memories', 'USER.md.lock'), '');
    const { artifacts, event } = await collectTrialFiles({
      workspace,
      home,
      manifest: new Map(),
      homeSeeds: [],
      blobs,
    });
    expect(artifacts).toEqual([]);
    expect(event.payload).toMatchObject({ home_files: 0, home_not_collected: [] });
  });

  it('names a lock file by its .lock ending, under memories/ only', () => {
    expect(isMemoryLockFile('memories/USER.md.lock')).toBe(true);
    expect(isMemoryLockFile('memories/a/b.lock')).toBe(true);
    for (const kept of [
      'memories/USER.md',
      'memories/USER.md.bak.1761400000',
      'memories/USER.lock.md',
      'memories/lock',
      'memories/USER.md.LOCK',
      'skills/x.lock',
      'USER.md.lock',
    ]) {
      expect(isMemoryLockFile(kept), kept).toBe(false);
    }
  });
});
