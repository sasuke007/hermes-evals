/**
 * A clean clone holds every file the specs and the stack read (Phase 7). The
 * clean install copied `git ls-files -co --exclude-standard` and found two
 * fixtures of test-mcp-server.spec.ts, Hermes's `mcp-stderr.log` as captured,
 * ignored by `*.log` and so never committed: the spec passed only on the
 * machine that wrote them. No file under a fixtures folder, `suites/`,
 * `samples/` or `scripts/` may be ignored. Runs where git sees the
 * repository; a source tree without `.git` has nothing to check.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Paths whose files are data some spec, generator or service reads. */
const DATA_PATHS = [
  /(^|\/)__fixtures__\//,
  /(^|\/)fixtures\//,
  /^suites\//,
  /^samples\//,
  /^scripts\//,
];

async function git(...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', REPO, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

const inWorkTree = (await git('rev-parse', '--is-inside-work-tree'))?.trim() === 'true';

describe.skipIf(!inWorkTree)('repository files', () => {
  it('ignores no fixture, suite, sample or script file', async () => {
    const ignored = (await git('ls-files', '--others', '--ignored', '--exclude-standard')) ?? '';
    const data = ignored
      .split('\n')
      .filter((path) => path && !path.includes('node_modules/'))
      .filter((path) => DATA_PATHS.some((pattern) => pattern.test(path)));
    expect(data).toEqual([]);
  });

  it('keeps the MCP test handler fixtures that look like logs', async () => {
    const dir = 'apps/api/src/worker/handlers/__fixtures__/hermes-mcp-test/';
    const out = await git(
      'check-ignore',
      '--no-index',
      `${dir}invoice-db-passed.mcp-stderr.log`,
      `${dir}invoice-db-missing-env.mcp-stderr.log`,
    );
    // check-ignore prints the paths it ignores, and exits 1 (null here) when there are none.
    expect(out ?? '').toBe('');
  });
});
