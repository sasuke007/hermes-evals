/**
 * Runs one task's self-checks (plan 4.3) on copies of its files, never on
 * SUITES_DIR: each check that touches files gets a fresh scratch directory
 * holding the fixtures, the expected workspace (fixtures overlaid with the
 * expected folder) and the verifier scripts, written from the bytes the
 * loader hashed. So the checks judge exactly the content that is stored, and
 * a verifier that writes to its workspace cannot change the next check.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SelfCheck } from '@hermes-evals/shared';
import { selfCheckModeFor } from '../../scoring/registry.js';
import {
  runSelfChecks,
  selfCheckSeconds,
  selfCheckStatus,
  type SelfCheckResult,
} from '../../scoring/self-check.js';
import type { ScratchDir } from '../../storage/blob-store.js';
import { FIXTURES_DIR, VERIFY_DIR } from './limits.js';
import type { AnalysedTask } from './task.js';
import type { StoredTaskFile } from './task-files.js';

export interface SelfCheckDeps {
  scratch: (prefix: string) => Promise<ScratchDir>;
  python?: string;
  now?: () => Date;
}

/** The declared worst case of one task's self-checks; 0 for a task with load errors, which runs none. */
export function taskSelfCheckSeconds(task: Pick<AnalysedTask, 'plan'>): number {
  const { plan } = task;
  if (plan === null) return 0;
  return selfCheckSeconds({
    entries: plan.entries,
    expectedWorkspace: plan.expectedDir !== null,
    negativeControl: plan.negativeControl,
  });
}

/**
 * The declared worst case of a suite's self-checks, in seconds, with its
 * tasks run `concurrency` at a time, each starting as soon as one before it
 * finishes (read-suite.ts, p-limit): at most the total spread over the
 * workers plus the longest task's share of the rest (Graham's bound for
 * list scheduling), so a suite of short tasks is not charged as if they ran
 * one by one, and a single long task is charged in full.
 */
export function suiteSelfCheckSeconds(taskSeconds: readonly number[], concurrency: number): number {
  const total = taskSeconds.reduce((sum, s) => sum + s, 0);
  if (total === 0) return 0;
  const longest = Math.max(...taskSeconds);
  return Math.ceil(total / concurrency + longest * (1 - 1 / concurrency));
}

/** The self-check of a task with load errors: nothing ran. */
export const SKIPPED_SELF_CHECK: SelfCheck = {
  status: 'skipped',
  ran_at: null,
  duration_ms: null,
  results: [],
};

const stripPrefix = (path: string, dir: string): string => path.slice(dir.length + 1);

/**
 * The expected workspace, path → bytes: every fixture at its workspace path,
 * then every expected file on top. An expected file replaces a fixture at the
 * same path, and also one in its way (a fixture file where an expected
 * folder goes, or the reverse).
 */
export function expectedWorkspace(
  files: readonly StoredTaskFile[],
  expectedDir: string,
): Map<string, StoredTaskFile> {
  const out = new Map<string, StoredTaskFile>();
  for (const f of files) if (f.kind === 'fixture') out.set(stripPrefix(f.path, FIXTURES_DIR), f);
  for (const f of files) {
    if (f.kind !== 'expected') continue;
    const path = stripPrefix(f.path, expectedDir);
    for (const existing of out.keys()) {
      if (existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)) out.delete(existing);
    }
    out.set(path, f);
  }
  return out;
}

async function writeTree(root: string, files: Iterable<[string, StoredTaskFile]>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, file] of files) {
    // Walk paths have no '..' or empty segment; refuse one anyway rather than write outside root.
    if (path.split('/').some((s) => s === '' || s === '..' || s === '.')) {
      throw new Error(`refusing to write ${JSON.stringify(path)}`);
    }
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: 'wx', mode: 0o644 });
  }
}

/** The three folders one file-touching check runs on. */
interface Materialised {
  fixturesDir: string;
  expectedWorkspaceDir: string | null;
  verifyDir: string;
}

async function materialise(
  root: string,
  task: AnalysedTask,
  expectedDir: string | null,
): Promise<Materialised> {
  const fixturesDir = join(root, 'workspace');
  const verifyDir = join(root, 'verify');
  await writeTree(
    fixturesDir,
    task.files
      .filter((f) => f.kind === 'fixture')
      .map((f) => [stripPrefix(f.path, FIXTURES_DIR), f]),
  );
  await writeTree(
    verifyDir,
    task.files
      .filter((f) => f.path.startsWith(`${VERIFY_DIR}/`))
      .map((f) => [stripPrefix(f.path, VERIFY_DIR), f]),
  );
  let expectedWorkspaceDir: string | null = null;
  if (expectedDir !== null) {
    expectedWorkspaceDir = join(root, 'expected-workspace');
    await writeTree(expectedWorkspaceDir, expectedWorkspace(task.files, expectedDir));
  }
  return { fixturesDir, expectedWorkspaceDir, verifyDir };
}

/** Runs every check of the plan in entry order. Never throws for the task's content. */
export async function selfCheckTask(task: AnalysedTask, deps: SelfCheckDeps): Promise<SelfCheck> {
  const plan = task.plan;
  if (plan === null) return SKIPPED_SELF_CHECK;
  const now = deps.now ?? (() => new Date());
  const ranAt = now().toISOString();
  const started = performance.now();
  const results: SelfCheckResult[] = [];

  for (const entry of plan.entries) {
    const mode = selfCheckModeFor(entry.type, plan.expectedDir !== null);
    const input = {
      entries: [entry],
      reference: plan.reference,
      negativeControl: plan.negativeControl,
      scratch: deps.scratch,
      python: deps.python,
    };
    if (mode === 'answer' || mode === 'none') {
      // No folder is read in these modes.
      results.push(
        ...(await runSelfChecks({
          ...input,
          fixturesDir: '',
          expectedWorkspaceDir: null,
          verifyDir: '',
        })),
      );
      continue;
    }
    let scratch: ScratchDir | null = null;
    try {
      scratch = await deps.scratch('suite-check');
      const dirs = await materialise(scratch.path, task, plan.expectedDir);
      results.push(...(await runSelfChecks({ ...input, ...dirs })));
    } catch (err) {
      results.push({
        key: entry.key,
        type: entry.type,
        mode,
        status: 'error',
        score: null,
        comment: `could not prepare the self-check: ${(err as Error).message}`,
      });
    } finally {
      await scratch?.dispose().catch(() => {});
    }
  }

  const expectedFiles =
    plan.expectedDir === null
      ? undefined
      : [...expectedWorkspace(task.files, plan.expectedDir)]
          .filter(([, f]) => f.kind === 'expected')
          .map(([path, f]) => ({ path, sha256: f.sha256 }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    status: selfCheckStatus(results),
    ran_at: ranAt,
    duration_ms: Math.round(performance.now() - started),
    results,
    ...(expectedFiles ? { expected_workspace: expectedFiles } : {}),
  };
}
