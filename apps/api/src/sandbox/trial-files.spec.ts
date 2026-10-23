import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureTrialDisk, readTrialFile, walkTrialTree } from './trial-files.js';

const base = mkdtempSync(join(tmpdir(), 'trial-files-'));
const root = join(base, 'workspace');
const outside = join(base, 'outside');
const SECRET = 'outside-secret';

beforeAll(() => {
  mkdirSync(root);
  mkdirSync(join(outside, 'dir'), { recursive: true });
  writeFileSync(join(outside, 'dir', 'secret.txt'), SECRET);
  writeFileSync(join(root, 'ok.txt'), 'hello\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'nested.txt'), 'nested');
  symlinkSync(outside, join(root, 'out-link'));
  symlinkSync(join(outside, 'dir', 'secret.txt'), join(root, 'peek.txt'));
  symlinkSync('.', join(root, 'loop'));
  execFileSync('mkfifo', [join(root, 'pipe')]);
  writeFileSync(join(root, 'locked'), 'locked');
  chmodSync(join(root, 'locked'), 0);
  writeFileSync(join(root, 'sparse'), '');
  truncateSync(join(root, 'sparse'), 10 * 1024 * 1024 * 1024);
  let deep = join(root, 'deep');
  for (let i = 0; i < 10; i += 1) deep = join(deep, 'd');
  mkdirSync(deep, { recursive: true });
});

afterAll(() => {
  chmodSync(join(root, 'locked'), 0o600);
  rmSync(base, { recursive: true, force: true });
});

describe('walkTrialTree', () => {
  it('lists links without following them, and special files by type', async () => {
    const tree = await walkTrialTree(root);
    const at = (path: string) => tree.entries.find((e) => e.path === path);
    expect(at('out-link')).toEqual({ path: 'out-link', kind: 'symlink', target: outside });
    expect(at('loop')).toMatchObject({ kind: 'symlink', target: '.' });
    expect(at('peek.txt')).toMatchObject({ kind: 'symlink' });
    expect(at('pipe')).toEqual({ path: 'pipe', kind: 'special', type: 'fifo' });
    expect(at('sub/nested.txt')).toEqual({ path: 'sub/nested.txt', kind: 'file', size: 6 });
    expect(tree.entries.some((e) => /^(out-link|loop)\//.test(e.path))).toBe(false);
    expect(tree.truncated).toBe(false);
  });

  it('stops at the depth and entry caps', async () => {
    const shallow = await walkTrialTree(root, { maxDepth: 3, maxEntries: 1000 });
    expect(shallow.entries).toContainEqual({ path: 'deep/d/d', kind: 'dir', entered: false });
    const few = await walkTrialTree(root, { maxDepth: 32, maxEntries: 3 });
    expect(few.entries).toHaveLength(3);
    expect(few.truncated).toBe(true);
  });

  it('measures allocated space, not apparent size', async () => {
    const tree = await walkTrialTree(root);
    expect(tree.bytes).toBeGreaterThan(10 * 1024 * 1024 * 1024);
    expect(tree.diskBytes).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('readTrialFile', () => {
  it('reads a regular file and hashes it', async () => {
    const read = await readTrialFile(root, 'ok.txt');
    expect(read).toMatchObject({ ok: true });
    if (read.ok) {
      expect(read.content.toString()).toBe('hello\n');
      expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses links, FIFOs without blocking, oversized and unreadable files, and escapes', async () => {
    const started = Date.now();
    expect(await readTrialFile(root, 'peek.txt')).toMatchObject({
      ok: false,
      reason: 'not_regular',
    });
    expect(await readTrialFile(root, 'pipe')).toMatchObject({ ok: false, reason: 'not_regular' });
    expect(await readTrialFile(root, 'sparse')).toMatchObject({ ok: false, reason: 'too_large' });
    expect(await readTrialFile(root, 'locked')).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(await readTrialFile(root, '../outside/dir/secret.txt')).toMatchObject({
      ok: false,
      reason: 'outside_root',
    });
    expect(await readTrialFile(root, 'sub')).toMatchObject({ ok: false, reason: 'not_regular' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a file over the size cap that it would otherwise read', async () => {
    expect(await readTrialFile(root, 'ok.txt', 3)).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
  });

  it.runIf(process.platform === 'linux')(
    'refuses a read through a linked parent directory',
    async () => {
      expect(await readTrialFile(root, 'out-link/dir/secret.txt')).toMatchObject({
        ok: false,
        reason: 'outside_root',
      });
    },
  );
});

describe('measureTrialDisk', () => {
  it('reports the cap a tree passes', async () => {
    const roomy = await measureTrialDisk({ roots: [root], maxBytes: 1 << 30, maxEntries: 1000 });
    expect(roomy.exceeded).toBeNull();
    const crowded = await measureTrialDisk({ roots: [root], maxBytes: 1 << 30, maxEntries: 5 });
    expect(crowded.exceeded).toMatch(/more than 5 files/);
    const small = await measureTrialDisk({ roots: [root], maxBytes: 1, maxEntries: 1000 });
    expect(small.exceeded).toMatch(/bytes on disk/);
  });
});
