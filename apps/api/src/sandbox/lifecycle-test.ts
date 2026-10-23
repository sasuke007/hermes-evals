/**
 * Lifecycle checks on a live engine: a trial past its deadline is stopped
 * with everything it started; a cancel stops it the same way; an orphan
 * left by a crashed worker blocks a replacement until it is cleared; the
 * worker reads a hostile trial's files without leaving them or hanging; and
 * a trial that fills the disk or creates too many files is stopped.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../database/ids.js';
import { EngineError, type EngineClient } from './engine-client.js';
import { readTrialFile, walkTrialTree, type TrialEntry, type TrialTree } from './trial-files.js';
import { clearRun, prepareTrialDirs, removeTrialDirs, runTrial } from './trial-runner.js';
import { trialContainerBody, type TrialSpec } from './trial-spec.js';
import type { SelfTestCheck } from './self-test.js';

export interface LifecycleDeps {
  engine: EngineClient;
  trialsDir: string;
  image: string;
  volume: string;
}

async function spec(deps: LifecycleDeps, script: string): Promise<TrialSpec> {
  const attemptId = newId();
  await prepareTrialDirs(deps.trialsDir, attemptId);
  return {
    name: `hermes-evals-run-${attemptId}`,
    runId: attemptId,
    attemptId,
    image: deps.image,
    volume: deps.volume,
    network: 'none',
    entrypoint: ['/bin/sh', '-c'],
    cmd: [script],
    env: {},
    deadline: Math.floor(Date.now() / 1000) + 120,
  };
}

const quiet = { onStdoutLine: () => {}, onStderr: () => {} };

/** Everything an agent could leave in its workspace to trip up the worker reading it. */
function hostileScript(victimAttempt: string): string {
  return [
    'set -e',
    'cd /workspace',
    'echo hello > ok.txt',
    'ln -s / root-link',
    'ln -s /data/suites suites-link',
    'ln -s /trials trials-link',
    'ln -s . loop',
    `ln -s /trials/${victimAttempt}/workspace/secret.txt peek.txt`,
    'd=deep; for i in $(seq 40); do d=$d/d; done; mkdir -p $d',
    'mkfifo pipe',
    'echo locked > locked; chmod 000 locked',
    `printf x > "$(printf 'bad\\377name')"`,
    'truncate -s 10G sparse',
    'echo PLANTED',
  ].join('\n');
}

// Detached grandchildren that would outlive a process-group kill. It prints nothing:
// the deadline must not depend on the container producing output.
const STUBBORN = 'setsid sleep 1000 & nohup sleep 1000 >/dev/null 2>&1 & sleep 1000';

export async function runLifecycleChecks(deps: LifecycleDeps): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];

  const deadlineSpec = await spec(deps, STUBBORN);
  const started = Date.now();
  const deadline = await runTrial({
    engine: deps.engine,
    spec: deadlineSpec,
    deadlineMs: 3000,
    stopGraceSeconds: 2,
    onStdoutLine: () => {},
    onStderr: () => {},
  });
  const leftAfterDeadline = await deps.engine.list([`hermes-evals.run=${deadlineSpec.runId}`]);
  checks.push({
    name: 'a trial past its deadline is stopped with everything it started',
    ok:
      deadline.stopReason === 'deadline' &&
      leftAfterDeadline.length === 0 &&
      Date.now() - started < 20_000,
    detail: `stop reason ${deadline.stopReason}, exit ${deadline.exitCode}, ${leftAfterDeadline.length} containers left, ${Date.now() - started} ms`,
  });

  const cancelSpec = await spec(deps, STUBBORN);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 1500);
  const cancelled = await runTrial({
    engine: deps.engine,
    spec: cancelSpec,
    deadlineMs: 60_000,
    stopGraceSeconds: 2,
    signal: abort.signal,
    onStdoutLine: () => {},
    onStderr: () => {},
  });
  checks.push({
    name: 'a cancelled trial is stopped',
    ok: cancelled.stopReason === 'cancelled',
    detail: `stop reason ${cancelled.stopReason}, exit ${cancelled.exitCode}`,
  });

  // A worker crashes mid-trial: its container keeps running, unattended.
  const orphanSpec = await spec(deps, STUBBORN);
  const orphanId = await deps.engine.createContainer(
    orphanSpec.name,
    trialContainerBody(orphanSpec),
  );
  await deps.engine.start(orphanId);
  let blocked = false;
  try {
    await deps.engine.createContainer(orphanSpec.name, trialContainerBody(orphanSpec));
  } catch (err) {
    blocked = err instanceof EngineError && err.status === 409;
  }
  const removed = await clearRun(deps.engine, orphanSpec.runId);
  const leftAfterClear = await deps.engine.list([`hermes-evals.run=${orphanSpec.runId}`]);
  checks.push({
    name: 'an orphaned trial blocks a replacement until it is confirmed gone',
    ok: blocked && removed >= 1 && leftAfterClear.length === 0,
    detail: `replacement create ${blocked ? 'refused with 409' : 'NOT refused'}; cleared ${removed}; ${leftAfterClear.length} left`,
  });
  for (const used of [deadlineSpec, cancelSpec, orphanSpec]) {
    await removeTrialDirs(deps.trialsDir, used.attemptId);
  }

  checks.push(await hostileOutputCheck(deps));
  checks.push(...(await diskLimitChecks(deps)));
  return checks;
}

/** A trial plants links, a loop, a FIFO and other traps; the worker then reads its workspace. */
async function hostileOutputCheck(deps: LifecycleDeps): Promise<SelfTestCheck> {
  const SECRET = `victim-secret-${newId()}`;
  const victim = newId();
  const victimDirs = await prepareTrialDirs(deps.trialsDir, victim);
  await writeFile(join(victimDirs.workspace, 'secret.txt'), SECRET);

  const hostile = await spec(deps, hostileScript(victim));
  const lines: string[] = [];
  const outcome = await runTrial({
    engine: deps.engine,
    spec: hostile,
    deadlineMs: 60_000,
    ...quiet,
    onStdoutLine: (line) => lines.push(line),
  });
  const workspace = join(deps.trialsDir, hostile.attemptId, 'workspace');
  const problems: string[] = [];
  const started = Date.now();
  let tree: TrialTree | undefined;
  try {
    tree = await walkTrialTree(workspace);
    const kind = (path: string): TrialEntry | undefined =>
      tree?.entries.find((e) => e.path === path);
    for (const link of ['root-link', 'suites-link', 'trials-link', 'loop', 'peek.txt']) {
      if (kind(link)?.kind !== 'symlink') problems.push(`${link} not listed as a link`);
      if (tree.entries.some((e) => e.path.startsWith(`${link}/`)))
        problems.push(`walked into ${link}`);
    }
    if (kind('pipe')?.kind !== 'special') problems.push('pipe not listed as special');
    if (!tree.entries.some((e) => e.kind === 'unreadable' && e.reason.includes('UTF-8')))
      problems.push('bad name not flagged');
    if (!tree.entries.some((e) => e.kind === 'dir' && !e.entered))
      problems.push('depth cap not applied');

    const reads: Record<string, string> = {};
    for (const path of [
      ...tree.entries.filter((e) => e.kind === 'file').map((e) => e.path),
      'pipe',
      'peek.txt',
      `trials-link/${victim}/workspace/secret.txt`,
      'suites-link',
    ]) {
      const read = await readTrialFile(workspace, path);
      if (read.ok && read.content.toString('utf8').includes(SECRET))
        problems.push(`read the secret via ${path}`);
      reads[path] = read.ok ? `ok:${read.content.length}` : read.reason;
    }
    const expect: Record<string, string> = {
      'ok.txt': 'ok:6',
      locked: 'unreadable',
      sparse: 'too_large',
      pipe: 'not_regular',
      'peek.txt': 'not_regular',
      [`trials-link/${victim}/workspace/secret.txt`]: 'outside_root',
    };
    for (const [path, want] of Object.entries(expect)) {
      if (reads[path] !== want) problems.push(`${path}: ${reads[path]}, expected ${want}`);
    }
  } catch (err) {
    problems.push(`threw: ${(err as Error).message}`);
  }
  const elapsed = Date.now() - started;
  if (elapsed > 5000) problems.push(`took ${elapsed} ms`);
  if (!lines.includes('PLANTED'))
    problems.push(`the trial did not plant its traps (exit ${outcome.exitCode})`);
  await removeTrialDirs(deps.trialsDir, hostile.attemptId);
  await removeTrialDirs(deps.trialsDir, victim);
  return {
    name: "the worker reads a hostile trial's files without following links, leaving the trial or blocking",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${tree?.entries.length} entries listed and read in ${elapsed} ms; links, loop, FIFO, unreadable file, bad name, 10 GB sparse file and a parent-link read all refused`
        : problems.join('; '),
  };
}

/** A trial that writes without end, by size or by file count, is stopped by the watchdog. */
async function diskLimitChecks(deps: LifecycleDeps): Promise<SelfTestCheck[]> {
  const cases = [
    {
      name: 'a trial that fills the disk is stopped',
      script: 'while true; do head -c 8388608 /dev/zero >> /workspace/fill; done',
      limit: { maxBytes: 64 * 1024 * 1024, maxEntries: 50_000 },
    },
    {
      name: 'a trial that creates files without end is stopped',
      script: 'i=0; while true; do : > /workspace/f$i; i=$((i+1)); done',
      limit: { maxBytes: 2 * 1024 * 1024 * 1024, maxEntries: 2000 },
    },
  ];
  const checks: SelfTestCheck[] = [];
  for (const c of cases) {
    const filler = await spec(deps, c.script);
    const root = join(deps.trialsDir, filler.attemptId);
    const outcome = await runTrial({
      engine: deps.engine,
      spec: filler,
      deadlineMs: 60_000,
      stopGraceSeconds: 1,
      ...quiet,
      diskLimit: {
        roots: [join(root, 'home'), join(root, 'workspace')],
        intervalMs: 250,
        ...c.limit,
      },
    });
    const after = await walkTrialTree(join(root, 'workspace'), {
      maxDepth: 4,
      maxEntries: 1_000_000,
    });
    await removeTrialDirs(deps.trialsDir, filler.attemptId);
    checks.push({
      name: c.name,
      ok: outcome.stopReason === 'disk_limit',
      detail: `stop reason ${outcome.stopReason} after ${outcome.durationMs} ms (${outcome.limitDetail ?? 'no limit hit'}); left ${Math.round(after.diskBytes / 1048576)} MiB in ${after.entries.length} files`,
    });
  }
  return checks;
}
