import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEASURE_MAX_DEPTH,
  measureTrialDisk,
  readTrialFile,
  restoreOwnerAccess,
  walkTrialTree,
} from './trial-files.js';
import { forceRemoveTree } from './trial-runner.js';

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

  describe('fails closed on what it cannot measure', () => {
    const roomy = { maxBytes: 1 << 30, maxEntries: 1000 };
    let tree: string;

    beforeAll(() => {
      tree = mkdtempSync(join(base, 'hidden-'));
    });
    afterAll(async () => {
      await forceRemoveTree(tree);
    });

    it('treats a directory the worker cannot list as over the cap', async () => {
      // `mkdir h && chmod 0300 h`: still writable and searchable by the agent, unlistable here.
      const workspace = join(tree, 'workspace');
      mkdirSync(join(workspace, 'h'), { recursive: true });
      writeFileSync(join(workspace, 'h', 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 1));
      chmodSync(join(workspace, 'h'), 0o300);
      const usage = await measureTrialDisk({ roots: [workspace], ...roomy });
      expect(usage.exceeded).toBe('a directory the worker cannot read: workspace/h (EACCES)');
    });

    it('treats an unlistable root as over the cap, and ignores one that is gone', async () => {
      const home = join(tree, 'home');
      mkdirSync(home);
      chmodSync(home, 0o300);
      expect((await measureTrialDisk({ roots: [home], ...roomy })).exceeded).toBe(
        'a directory the worker cannot read: home (EACCES)',
      );
      const gone = await measureTrialDisk({ roots: [join(tree, 'missing')], ...roomy });
      expect(gone.exceeded).toBeNull();
    });

    it('treats a directory nested past the walk depth as over the cap', async () => {
      const nested = join(tree, 'nested');
      mkdirSync(join(nested, ...Array.from({ length: MEASURE_MAX_DEPTH + 1 }, () => 'd')), {
        recursive: true,
      });
      expect((await measureTrialDisk({ roots: [nested], ...roomy })).exceeded).toMatch(
        new RegExp(`^a directory nested deeper than ${MEASURE_MAX_DEPTH} levels: nested/d/`),
      );
    });
  });
});

describe('restoreOwnerAccess and forceRemoveTree', () => {
  it('delete a tree whose directories the agent locked, without following links', async () => {
    const tree = mkdtempSync(join(base, 'locked-'));
    const workspace = join(tree, 'workspace');
    const keep = join(base, 'keep-locked');
    mkdirSync(keep);
    writeFileSync(join(keep, 'kept.txt'), 'not the trial');
    chmodSync(keep, 0o500);
    mkdirSync(join(workspace, 'x', 'y'), { recursive: true });
    writeFileSync(join(workspace, 'x', 'f'), 'f');
    writeFileSync(join(workspace, 'x', 'y', 'g'), 'g');
    mkdirSync(join(workspace, 'h'));
    writeFileSync(join(workspace, 'h', 'f'), 'f');
    symlinkSync(keep, join(workspace, 'to-keep'));
    chmodSync(join(workspace, 'x', 'y'), 0o500);
    chmodSync(join(workspace, 'x'), 0o500);
    chmodSync(join(workspace, 'h'), 0o300);
    chmodSync(workspace, 0o555);
    // What the agent can do to make rm fail, as plain rm shows (EACCES on Linux, ENOTEMPTY on macOS).
    expect(() => rmSync(tree, { recursive: true, force: true })).toThrow(/EACCES|ENOTEMPTY/);

    await forceRemoveTree(tree);
    expect(existsSync(tree)).toBe(false);
    // The link's target kept its mode and content: the walk never followed it.
    expect(statSync(keep).mode & 0o777).toBe(0o500);
    expect(existsSync(join(keep, 'kept.txt'))).toBe(true);
    chmodSync(keep, 0o700);
  });

  it('restores only directories, and counts what it changed', async () => {
    const tree = mkdtempSync(join(base, 'restore-'));
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    writeFileSync(join(tree, 'a', 'file'), 'x');
    chmodSync(join(tree, 'a', 'file'), 0o400);
    chmodSync(join(tree, 'a', 'b'), 0o100);
    chmodSync(join(tree, 'a'), 0o100);
    expect(await restoreOwnerAccess(tree)).toBe(2);
    expect(statSync(join(tree, 'a')).mode & 0o777).toBe(0o700);
    expect(statSync(join(tree, 'a', 'b')).mode & 0o777).toBe(0o700);
    expect(statSync(join(tree, 'a', 'file')).mode & 0o777).toBe(0o400);
    expect(await restoreOwnerAccess(tree)).toBe(0);
    rmSync(tree, { recursive: true, force: true });
  });
});
