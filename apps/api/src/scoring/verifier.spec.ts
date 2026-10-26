import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerifierScriptParamsSchema, type JsonValue } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_HOME_DIR,
  VERIFIER_TAIL_BYTES,
  homeOptionHint,
  parseVerifierLine,
  runVerifier,
  scoreVerifierScript,
  verifierEnv,
  verifierResult,
} from './verifier.js';

/**
 * The interpreter itself (test/support/require-python.ts makes sure there is
 * one). On macOS /usr/bin/python3 is an xcrun shim that adds SDKROOT, CPATH
 * and others to the environment before starting the real one, which would
 * hide what the runner itself passes.
 */
const realPython = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
}).stdout.trim();

/** Common argument parsing, as every verifier in a suite does it (`--home` since Phase 6). */
const PRELUDE = `import argparse, json, os, sys, subprocess, time
parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home", required=True)
args = parser.parse_args()
`;

/** How verifiers were written before Phase 6: no `--home`, which argparse then refuses. */
const OLD_PRELUDE = PRELUDE.replace('parser.add_argument("--home", required=True)\n', '');

describe('parseVerifierLine', () => {
  it('reads a score and an optional comment, ignoring other keys', () => {
    expect(parseVerifierLine('{"score": 0.5}')).toEqual({ ok: true, score: 0.5, comment: null });
    expect(parseVerifierLine('{"key": "check", "score": 1, "comment": "rate 2%"}')).toEqual({
      ok: true,
      score: 1,
      comment: 'rate 2%',
    });
  });

  it.each([
    [null, 'printed no result line'],
    ['score: 1', 'the last stdout line is not JSON'],
    ['[1]', 'the result line is not a JSON object'],
    ['{"score": 1.5}', 'the result line needs a "score" from 0 to 1'],
    ['{"score": -0.1}', 'the result line needs a "score" from 0 to 1'],
    ['{"score": "1"}', 'the result line needs a "score" from 0 to 1'],
    ['{"comment": "no score"}', 'the result line needs a "score" from 0 to 1'],
    ['{"score": 1, "comment": 3}', 'the result line\'s "comment" must be a string'],
  ])('refuses %j', (line, error) => {
    expect(parseVerifierLine(line)).toMatchObject({ ok: false, error });
  });
});

describe('runVerifier', () => {
  let root: string;
  let workspace: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'verifier-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'policy_terms.json'), '{"late_fee_rate": 0.02}');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Writes a script and runs it with a fresh scratch directory. */
  async function run(
    body: string,
    options: {
      answer?: JsonValue | null;
      timeoutS?: number;
      python?: string;
      homeDir?: string;
      prelude?: string;
    } = {},
  ) {
    n += 1;
    const dir = join(root, `task-${n}`);
    const scratch = join(root, `scratch-${n}`);
    mkdirSync(join(dir, 'verify'), { recursive: true });
    mkdirSync(scratch);
    const scriptPath = join(dir, 'verify', 'check.py');
    writeFileSync(scriptPath, (options.prelude ?? PRELUDE) + body);
    const result = await runVerifier({
      scriptPath,
      answer: options.answer === undefined ? { total: 1 } : options.answer,
      workspaceDir: workspace,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      timeoutS: options.timeoutS ?? 10,
      scratchDir: scratch,
      python: options.python,
    });
    return { ...result, dir, scratch };
  }

  /** Waits until a process no longer exists. */
  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('takes the last non-empty stdout line as the result', async () => {
    const { outcome, evidence } = await run(
      'print("loading")\nprint(json.dumps({"score": 1, "comment": "ok"}))\nprint("   ")\n',
    );
    expect(outcome).toEqual({ ok: true, score: 1, comment: 'ok' });
    expect(evidence).toMatchObject({
      exit_code: 0,
      timed_out: false,
      stdout_line: '{"score": 1, "comment": "ok"}',
    });
    expect(evidence.argv.slice(0, 1)).toEqual(['python3']);
    expect(evidence.argv.slice(2, 3)).toEqual(['--answer']);
    expect(evidence.argv.slice(4, 6)).toEqual(['--workspace', workspace]);
    expect(evidence.argv.at(-2)).toBe('--home');
  });

  it('passes --home: the collected home files, or an empty folder when there are none', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'memories'), { recursive: true });
    writeFileSync(join(home, 'memories', 'USER.md'), 'Reports in EUR.');
    const script =
      'path = os.path.join(args.home, "memories", "USER.md")\n' +
      'text = open(path).read() if os.path.exists(path) else None\n' +
      'print(json.dumps({"score": 1 if text else 0, "comment": f"{text!r} in {sorted(os.listdir(args.home))}"}))\n';
    const seeded = await run(script, { homeDir: home });
    expect(seeded.outcome).toEqual({
      ok: true,
      score: 1,
      comment: "'Reports in EUR.' in ['memories']",
    });
    expect(seeded.evidence.argv.slice(-2)).toEqual(['--home', home]);

    const bare = await run(script);
    expect(bare.outcome).toEqual({ ok: true, score: 0, comment: 'None in []' });
    expect(bare.evidence.argv.slice(-2)).toEqual(['--home', join(bare.scratch, EMPTY_HOME_DIR)]);
  });

  it('says how to fix a script written before --home existed', async () => {
    const { outcome, evidence } = await run('print(json.dumps({"score": 1}))\n', {
      prelude: OLD_PRELUDE,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error:
        "exited with code 2: the script does not accept --home, which every verifier is given (Phase 6); add parser.add_argument('--home') to it",
    });
    expect(evidence.stderr_tail).toMatch(/unrecognized arguments: --home/);
    expect(homeOptionHint('error: unrecognized arguments: --verbose')).toBeNull();
  });

  it('passes the answer as a file, and JSON null when there is none', async () => {
    const script =
      'answer = json.load(open(args.answer))\n' +
      'policy = json.load(open(os.path.join(args.workspace, "policy_terms.json")))\n' +
      'print(json.dumps({"score": 1 if answer and answer.get("total") == 1 else 0, "comment": f"rate {policy[\'late_fee_rate\']}, answer {answer!r}"}))\n';
    expect((await run(script)).outcome).toMatchObject({ ok: true, score: 1 });
    expect((await run(script, { answer: null })).outcome).toEqual({
      ok: true,
      score: 0,
      comment: 'rate 0.02, answer None',
    });
  });

  it('turns a crash into an error carrying the last stderr line', async () => {
    const { outcome, evidence } = await run(
      'policy = json.load(open(os.path.join(args.workspace, "policy_terms.json")))\nprint(policy["grace_days"])\n',
    );
    expect(outcome).toEqual({
      ok: false,
      error: 'exited with code 1',
      detail: "KeyError: 'grace_days'",
    });
    expect(evidence.exit_code).toBe(1);
    expect(evidence.stderr_tail).toMatch(/Traceback/);
  });

  it('errors on a non-zero exit even after a valid result line', async () => {
    const { outcome } = await run('print(json.dumps({"score": 1}))\nsys.exit(3)\n');
    expect(outcome).toMatchObject({ ok: false, error: 'exited with code 3' });
  });

  it('errors when nothing is printed', async () => {
    expect((await run('pass\n')).outcome).toMatchObject({
      ok: false,
      error: 'printed no result line',
    });
  });

  it('kills the whole process group at the deadline', async () => {
    const started = Date.now();
    const { outcome, evidence, scratch } = await run(
      'child = subprocess.Popen(["sleep", "60"])\n' +
        'open(os.path.join(os.environ["HOME"], "child.pid"), "w").write(str(child.pid))\n' +
        'print("waiting", flush=True)\n' +
        'time.sleep(60)\n',
      { timeoutS: 1 },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(outcome).toMatchObject({ ok: false, error: 'timed out after 1 s' });
    expect(evidence).toMatchObject({ timed_out: true, exit_code: null, stdout_tail: 'waiting\n' });
    const pid = Number(readFileSync(join(scratch, 'child.pid'), 'utf8'));
    expect(await gone(pid)).toBe(true);
  });

  it('kills what the script left running when it exits', async () => {
    const started = Date.now();
    const { outcome, scratch } = await run(
      // The child inherits stdout, so without the kill the pipe would stay open for 60 s.
      'child = subprocess.Popen(["sleep", "60"])\n' +
        'open(os.path.join(os.environ["HOME"], "child.pid"), "w").write(str(child.pid))\n' +
        'print(json.dumps({"score": 1}))\n',
    );
    expect(outcome).toMatchObject({ ok: true, score: 1 });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(join(scratch, 'child.pid'), 'utf8'));
    expect(await gone(pid)).toBe(true);
  });

  it('runs with a minimal environment that inherits nothing', async () => {
    process.env.HERMES_VERIFIER_CANARY = 'must-not-leak';
    try {
      const { outcome, dir, scratch } = await run(
        'print(json.dumps({"score": 1, "comment": json.dumps({"env": dict(os.environ), "cwd": os.getcwd()})}))\n',
        { python: realPython },
      );
      if (!outcome.ok) throw new Error(outcome.error);
      const seen = JSON.parse(outcome.comment!) as { env: Record<string, string>; cwd: string };
      expect(seen.env.HERMES_VERIFIER_CANARY).toBeUndefined();
      // macOS's CoreFoundation adds __CF_USER_TEXT_ENCODING to every process; Linux adds nothing.
      const { __CF_USER_TEXT_ENCODING: _platform, ...env } = seen.env;
      expect(env).toEqual(verifierEnv(scratch));
      expect(Object.keys(env).sort()).toEqual([
        'HOME',
        'LANG',
        'PATH',
        'PYTHONDONTWRITEBYTECODE',
        'PYTHONIOENCODING',
        'TMPDIR',
      ]);
      expect(seen.cwd.endsWith(join(dir.split('/').at(-1)!, 'verify'))).toBe(true);
    } finally {
      delete process.env.HERMES_VERIFIER_CANARY;
    }
  });

  it('caps the tails at 4 KB and keeps UTF-8 whole', async () => {
    const { outcome, evidence } = await run(
      'print("é" * 5000)\nsys.stderr.write("ü" * 5000)\nprint(json.dumps({"score": 0.25, "comment": "größe"}, ensure_ascii=False))\n',
    );
    expect(outcome).toEqual({ ok: true, score: 0.25, comment: 'größe' });
    expect(Buffer.byteLength(evidence.stdout_tail)).toBeLessThanOrEqual(VERIFIER_TAIL_BYTES);
    expect(Buffer.byteLength(evidence.stderr_tail)).toBeLessThanOrEqual(VERIFIER_TAIL_BYTES);
    expect(evidence.stdout_tail).not.toContain('\uFFFD');
    expect(evidence.stderr_tail).not.toContain('\uFFFD');
    expect(evidence.stdout_tail.endsWith('"comment": "größe"}\n')).toBe(true);
  });

  it('reports an interpreter that cannot start', async () => {
    const scratch = join(root, 'scratch-missing-python');
    mkdirSync(scratch);
    const { outcome } = await runVerifier({
      scriptPath: join(root, 'none.py'),
      answer: null,
      workspaceDir: workspace,
      timeoutS: 5,
      scratchDir: scratch,
      python: 'python3-that-does-not-exist',
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: 'could not start python3-that-does-not-exist',
    });
  });
});

describe('verifierResult', () => {
  const evidence = {
    argv: ['python3', 'check.py'],
    exit_code: 0,
    timed_out: false,
    duration_ms: 12,
    stdout_line: '{"score": 0.8}',
    stdout_tail: '{"score": 0.8}\n',
    stderr_tail: '',
  };

  it('passes at pass_at and keeps the printed score', () => {
    const run = { outcome: { ok: true as const, score: 0.8, comment: 'close' }, evidence };
    expect(verifierResult(run, 0.7, 'check.py')).toMatchObject({
      status: 'passed',
      score: 0.8,
      comment: 'close (score 0.8, pass at 0.7)',
      evidence: { script: evidence },
    });
    expect(verifierResult(run, 1, 'check.py')).toMatchObject({ status: 'failed', score: 0.8 });
  });

  it('makes a broken contract an error with no score', () => {
    const run = {
      outcome: { ok: false as const, error: 'printed no result line', detail: null },
      evidence: { ...evidence, stdout_line: null },
    };
    expect(verifierResult(run, 1, 'check.py')).toMatchObject({
      status: 'error',
      score: null,
      comment: 'verifier check.py printed no result line',
      evidence: {
        script: { stdout_line: null },
        error: { message: 'verifier check.py printed no result line' },
      },
    });
  });
});

describe('scoreVerifierScript', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'verifier-key-'));
    mkdirSync(join(root, 'verify'));
    mkdirSync(join(root, 'scratch'));
    writeFileSync(join(root, 'verify', 'helper.py'), 'SCORE = 1\n');
    writeFileSync(
      join(root, 'verify', 'check.py'),
      // Imports its neighbour: the script's folder is the working directory and on sys.path.
      `${PRELUDE}from helper import SCORE\nprint(json.dumps({"score": SCORE}))\n`,
    );
    symlinkSync(join(root, 'verify', 'check.py'), join(root, 'verify', 'link.py'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const input = () => ({
    verifyDir: join(root, 'verify'),
    answer: null,
    workspaceDir: root,
    scratchDir: join(root, 'scratch'),
  });

  it('runs the script named by the params', async () => {
    const params = VerifierScriptParamsSchema.parse({ script: 'check.py' });
    expect(await scoreVerifierScript(params, input())).toMatchObject({
      status: 'passed',
      score: 1,
    });
  });

  it('refuses a missing script and a link', async () => {
    for (const script of ['absent.py', 'link.py']) {
      const params = VerifierScriptParamsSchema.parse({ script });
      expect(await scoreVerifierScript(params, input())).toMatchObject({
        status: 'error',
        score: null,
        comment: `verifier ${script} is not a regular file in verify/`,
      });
    }
  });
});
