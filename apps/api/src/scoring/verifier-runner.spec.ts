/**
 * The container verifier runner against FakeEngine: the body each run asks
 * docker-guard for (checked with the guard's own policy), the folder it
 * mounts, the outcome rules, and the cleanup. The "container" runs the
 * script with the host's python3 against the mounted folder, so what the
 * runner copied is what the script reads; the gated real-container spec
 * (sandbox/verifier-container.spec.ts) shows the confinement itself.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCreateBody } from '@hermes-evals/docker-guard/policy';
import { VerifierScriptParamsSchema } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeEngine,
  type FakeContainerInfo,
  type FakeTrialScript,
} from '../../test/support/fake-engine.js';
import { VERIFIER_MOUNT } from '../sandbox/verifier-spec.js';
import { scoreVerifierScript, useVerifierRunner } from './verifier.js';
import {
  containerVerifierRunner,
  subprocessVerifierRunner,
  sweepVerifierScratch,
  VerifierUnavailable,
} from './verifier-runner.js';

const GUARD = {
  trialImage: 'hermes-evals/trial:test',
  trialVolume: 'hermes-evals-trials',
  trialNetworks: ['hermes-evals-trial-0'],
};

const PRELUDE = `import argparse, json, os, sys
parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home", required=True)
args = parser.parse_args()
`;

let root: string;
let trialsDir: string;
let task: string;
let refused: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verifier-runner-'));
  trialsDir = join(root, 'trials');
  task = join(root, 'task');
  await mkdir(trialsDir);
  await mkdir(join(task, 'verify', 'lib'), { recursive: true });
  await mkdir(join(task, 'workspace', 'docs'), { recursive: true });
  await mkdir(join(task, 'home', 'memories'), { recursive: true });
  await writeFile(join(task, 'workspace', 'docs', 'a.txt'), 'alpha');
  await writeFile(join(task, 'home', 'memories', 'USER.md'), 'Prefers EUR');
  await writeFile(join(task, 'verify', 'helper.py'), 'BONUS = 0\n');
  refused = [];
});

afterEach(async () => {
  useVerifierRunner(null);
  await rm(root, { recursive: true, force: true });
});

/** The scratch folder a container mounts, as the worker sees it. */
const mounted = (info: FakeContainerInfo): string => {
  const mounts = (info.body.HostConfig as { Mounts: Array<{ VolumeOptions: { Subpath: string } }> })
    .Mounts;
  return join(trialsDir, mounts[0]!.VolumeOptions.Subpath);
};

/** Runs the container's argv with the host's python3, /check mapped onto the mounted folder. */
function pythonContainer(info: FakeContainerInfo): FakeTrialScript {
  const check = checkCreateBody(info.body, GUARD, info.name);
  if (!check.ok) {
    refused.push(...check.reasons);
    return { createError: `docker-guard refused: ${check.reasons.join('; ')}` };
  }
  const folder = mounted(info);
  const [, ...args] = info.argv.map((arg) => arg.replace(VERIFIER_MOUNT, folder));
  const cwd = (info.body.WorkingDir as string).replace(VERIFIER_MOUNT, folder);
  const ran = spawnSync('python3', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  return {
    steps: [{ stdoutRaw: ran.stdout }, { stderr: ran.stderr }],
    exitCode: ran.status ?? 1,
  };
}

const runner = (engine: FakeEngine) =>
  containerVerifierRunner({
    engine,
    image: GUARD.trialImage,
    volume: GUARD.trialVolume,
    trialsDir,
  });

const options = (script: string, extra: Record<string, unknown> = {}) => ({
  scriptPath: join(task, 'verify', script),
  verifyDir: join(task, 'verify'),
  answer: { total: 3 },
  workspaceDir: join(task, 'workspace'),
  homeDir: join(task, 'home'),
  timeoutS: 5,
  scratchDir: join(root, 'unused-scratch'),
  ...extra,
});

describe('containerVerifierRunner', () => {
  it('runs the script in a guard-approved container on copies of its inputs, then removes both', async () => {
    await writeFile(
      join(task, 'verify', 'lib', 'check.py'),
      `${PRELUDE}import sys; sys.path.insert(0, "..")
from helper import BONUS
answer = json.load(open(args.answer))
text = open(os.path.join(args.workspace, "docs", "a.txt")).read()
user = open(os.path.join(args.home, "memories", "USER.md")).read()
print("working", file=sys.stderr)
print(json.dumps({"score": 1 if answer == {"total": 3} and text == "alpha" and "EUR" in user else 0, "comment": os.getcwd().endswith("verify/lib") and "in lib" or "elsewhere"}))
`,
    );
    const engine = new FakeEngine({ script: pythonContainer });
    const run = await runner(engine).run(options('lib/check.py'));
    expect(refused).toEqual([]);
    expect(run.outcome).toEqual({ ok: true, score: 1, comment: 'in lib' });
    expect(run.evidence).toMatchObject({
      argv: [
        '/usr/local/bin/python3',
        '/check/verify/lib/check.py',
        '--answer',
        '/check/answer.json',
        '--workspace',
        '/check/workspace',
        '--home',
        '/check/home',
      ],
      exit_code: 0,
      timed_out: false,
      stdout_line: '{"score": 1, "comment": "in lib"}',
      stderr_tail: 'working\n',
    });
    const [container] = engine.containers;
    expect(container!.info.name).toMatch(/^hermes-evals-verify-[0-9A-Z]{26}$/);
    expect(container!.info.network).toBe('none');
    expect(container!.info.env).toEqual({ PATH: expect.any(String) });
    expect(engine.present()).toEqual([]);
    expect(readdirSync(trialsDir)).toEqual([]);
  });

  it('gives an empty home when the caller has none, and leaves links out of the copies', async () => {
    await symlink('/etc/passwd', join(task, 'workspace', 'passwd'));
    await writeFile(
      join(task, 'verify', 'check.py'),
      `${PRELUDE}print(json.dumps({"score": 1, "comment": ",".join(sorted(os.listdir(args.workspace))) + "|" + ",".join(os.listdir(args.home))}))\n`,
    );
    const run = await runner(new FakeEngine({ script: pythonContainer })).run(
      options('check.py', { homeDir: undefined }),
    );
    expect(run.outcome).toEqual({ ok: true, score: 1, comment: 'docs|' });
  });

  it('applies the contract: a broken result line, a non-zero exit with the --home hint', async () => {
    await writeFile(join(task, 'verify', 'line.py'), `${PRELUDE}print("score: 1")\n`);
    await writeFile(
      join(task, 'verify', 'old.py'),
      PRELUDE.replace('parser.add_argument("--home", required=True)\n', ''),
    );
    const engine = new FakeEngine({ script: pythonContainer });
    expect((await runner(engine).run(options('line.py'))).outcome).toMatchObject({
      ok: false,
      error: 'the last stdout line is not JSON',
    });
    const old = await runner(engine).run(options('old.py'));
    expect(old.outcome).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^exited with code 2: the script does not accept --home/),
    });
  });

  it('kills the container at the deadline', async () => {
    await writeFile(join(task, 'verify', 'slow.py'), PRELUDE);
    const engine = new FakeEngine({ script: () => ({ hang: true }) });
    const run = await runner(engine).run(options('slow.py', { timeoutS: 0.2 }));
    expect(run.outcome).toMatchObject({ ok: false, error: 'timed out after 0.2 s' });
    expect(run.evidence).toMatchObject({ timed_out: true, exit_code: 137 });
    expect(engine.calls.some((call) => call.startsWith('kill '))).toBe(true);
    expect(engine.present()).toEqual([]);
    expect(readdirSync(trialsDir)).toEqual([]);
  });

  it('names the memory limit when the kernel killed the script', async () => {
    await writeFile(join(task, 'verify', 'big.py'), PRELUDE);
    const run = await runner(new FakeEngine({ script: () => ({ oomKilled: true }) })).run(
      options('big.py'),
    );
    expect(run.outcome).toMatchObject({
      ok: false,
      error: 'was killed by its 512 MiB memory limit',
    });
  });

  it('throws VerifierUnavailable when the container cannot be created, and cleans up', async () => {
    await writeFile(join(task, 'verify', 'check.py'), PRELUDE);
    const engine = new FakeEngine({ script: () => ({ createError: 'docker-guard is down' }) });
    await expect(runner(engine).run(options('check.py'))).rejects.toBeInstanceOf(
      VerifierUnavailable,
    );
    expect(readdirSync(trialsDir)).toEqual([]);
    const outside = options('check.py', { verifyDir: join(task, 'workspace') });
    await expect(runner(engine).run(outside)).rejects.toThrow(/is not inside the folder/);
  });
});

describe('scoreVerifierScript and the installed runner', () => {
  const params = VerifierScriptParamsSchema.parse({ script: 'check.py' });
  const input = () => ({
    verifyDir: join(task, 'verify'),
    answer: null,
    workspaceDir: join(task, 'workspace'),
    scratchDir: join(root, 'scratch'),
  });

  beforeEach(async () => {
    await mkdir(join(root, 'scratch'));
    await writeFile(
      join(task, 'verify', 'check.py'),
      `${PRELUDE}print(json.dumps({"score": 1}))\n`,
    );
  });

  it('uses the installed runner unless the caller passes one', async () => {
    const engine = new FakeEngine({ script: pythonContainer });
    useVerifierRunner(runner(engine));
    expect(await scoreVerifierScript(params, input())).toMatchObject({ status: 'passed' });
    expect(engine.containers).toHaveLength(1);
    const own = await scoreVerifierScript(params, {
      ...input(),
      runner: subprocessVerifierRunner,
    });
    expect(own).toMatchObject({ status: 'passed' });
    expect(engine.containers).toHaveLength(1);
  });

  it('rethrows VerifierUnavailable instead of grading the key', async () => {
    const engine = new FakeEngine({ script: () => ({ startError: 'no such image' }) });
    await expect(
      scoreVerifierScript(params, { ...input(), runner: runner(engine) }),
    ).rejects.toBeInstanceOf(VerifierUnavailable);
  });
});

describe('sweepVerifierScratch', () => {
  it('removes only the old verify-<id> folders', async () => {
    const old = join(trialsDir, 'verify-01K8ZQ7M3V5X9C2B4N6P8R0T1W');
    const fresh = join(trialsDir, 'verify-01K8ZQ7M3V5X9C2B4N6P8R0T1X');
    const attempt = join(trialsDir, '01K8ZQ7M3V5X9C2B4N6P8R0T1Y');
    for (const dir of [old, fresh, attempt]) await mkdir(join(dir, 'verify'), { recursive: true });
    const longAgo = new Date(Date.now() - 7 * 3600_000);
    await utimes(old, longAgo, longAgo);
    await utimes(attempt, longAgo, longAgo);
    expect(await sweepVerifierScratch(trialsDir)).toBe(1);
    expect((await readdir(trialsDir)).sort()).toEqual(
      ['verify-01K8ZQ7M3V5X9C2B4N6P8R0T1X', '01K8ZQ7M3V5X9C2B4N6P8R0T1Y'].sort(),
    );
    expect(existsSync(old)).toBe(false);
    expect(await sweepVerifierScratch(join(root, 'absent'))).toBe(0);
  });
});
