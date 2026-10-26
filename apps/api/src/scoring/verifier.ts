/**
 * The verifier runner (plan 4.3, 9.3, 14). A verifier is the task author's
 * Python script, run by the worker outside any trial:
 *
 *   python3 <script> --answer <scratch>/answer.json --workspace <dir> --home <dir>
 *
 * The answer file always exists; it holds JSON null when there is no answer.
 * `--home` (Phase 6 P2) is always passed: a folder holding the home files
 * collected after the run (`memories/MEMORY.md`, `memories/USER.md`, at their
 * home-relative paths), empty when there are none. A script must accept the
 * option even when it never reads it; argparse refuses an undeclared one,
 * and the error then says how to fix it (homeOptionHint).
 * The contract: the last non-empty stdout line is a JSON object with `score`
 * from 0 to 1 and an optional string `comment` (other keys are ignored). No
 * such line, bad JSON, a score out of range, a non-zero exit or the deadline
 * make the key `error`: the check broke, which says nothing about the agent.
 *
 * Containment: the script is user code, so it gets a minimal environment
 * (nothing inherited but PATH), the scratch directory as HOME and TMPDIR, no
 * stdin, and its own process group, which is SIGKILLed at the deadline and
 * again once the script exits, so nothing it started outlives it.
 *
 * Not a sandbox: the script runs as the worker's uid, so it can still read
 * the worker's own environment (/proc/1/environ in the container) and use
 * its network. Compose keeps every provider key out of that environment
 * (docker-compose.yml x-no-provider-keys); what remains is DATABASE_URL, the
 * stdio MCP values and anything else `.env` holds, until verifiers run in
 * their own `network: none` container (plan 14, Phase 5b).
 */
import { spawn } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { JsonValue, ScoreEvidence, VerifierScriptParams } from '@hermes-evals/shared';
import { ByteTail, LineSplitter, utf8Tail } from '../sandbox/streams.js';
import { graded, guardedAsync, scorerError, type ScorerResult } from './result.js';

export type ScriptEvidence = NonNullable<ScoreEvidence['script']>;

/** Evidence tails and the recorded result line are capped at this many bytes. */
export const VERIFIER_TAIL_BYTES = 4096;

/** A result line longer than this is cut, and so fails to parse. */
const MAX_LINE_BYTES = 64 * 1024;

/** After the deadline or the script's exit, how long its pipes may stay open. */
const DRAIN_GRACE_MS = 2000;

const FALLBACK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface VerifierOptions {
  /** The script; its folder is the working directory, so it can import its neighbours. */
  scriptPath: string;
  /** Written to `<scratchDir>/answer.json`; null writes JSON null. */
  answer: JsonValue | null;
  workspaceDir: string;
  /**
   * The collected home files, passed as `--home`. Absent: an empty folder
   * made in the scratch directory, as for an attempt that left no home files.
   */
  homeDir?: string;
  timeoutS: number;
  /** An empty writable directory the caller disposes: answer.json, HOME and TMPDIR. */
  scratchDir: string;
  /** The interpreter; `python3` on PATH by default. */
  python?: string;
}

export type VerifierOutcome =
  | { ok: true; score: number; comment: string | null }
  | { ok: false; error: string; detail: string | null };

export interface VerifierRun {
  outcome: VerifierOutcome;
  evidence: ScriptEvidence;
}

/** The environment a verifier runs with. Exported so tests can state it exactly. */
export function verifierEnv(scratchDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH || FALLBACK_PATH,
    LANG: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    HOME: scratchDir,
    TMPDIR: scratchDir,
  };
}

const lastLineOf = (text: string): string | null =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1) ?? null;

/** The folder `--home` names when the caller gives none: empty, in the scratch directory. */
export const EMPTY_HOME_DIR = 'empty-home';

/**
 * What to do about a script that refuses `--home`: argparse's
 * "unrecognized arguments: ... --home ..." on stderr, from a script written
 * before Phase 6. Null for any other failure.
 */
export function homeOptionHint(stderrTail: string): string | null {
  return /unrecognized arguments:.*--home/.test(stderrTail)
    ? "the script does not accept --home, which every verifier is given (Phase 6); add parser.add_argument('--home') to it"
    : null;
}

/** Reads the result line under the contract above. */
export function parseVerifierLine(line: string | null): VerifierOutcome {
  if (line === null) return { ok: false, error: 'printed no result line', detail: null };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    return {
      ok: false,
      error: 'the last stdout line is not JSON',
      detail: (err as Error).message,
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'the result line is not a JSON object', detail: null };
  }
  const { score, comment } = value as { score?: unknown; comment?: unknown };
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    return {
      ok: false,
      error: 'the result line needs a "score" from 0 to 1',
      detail: `score: ${JSON.stringify(score) ?? 'absent'}`,
    };
  }
  if (comment !== undefined && typeof comment !== 'string') {
    return { ok: false, error: 'the result line\'s "comment" must be a string', detail: null };
  }
  return { ok: true, score, comment: comment ?? null };
}

/** Runs one verifier to completion or its deadline. Never throws for anything the script does. */
export async function runVerifier(options: VerifierOptions): Promise<VerifierRun> {
  const python = options.python ?? 'python3';
  const scratch = resolve(options.scratchDir);
  const scriptPath = resolve(options.scriptPath);
  const answerPath = join(scratch, 'answer.json');
  await writeFile(answerPath, `${JSON.stringify(options.answer)}\n`);
  let homeDir = options.homeDir;
  if (homeDir === undefined) {
    homeDir = join(scratch, EMPTY_HOME_DIR);
    await mkdir(homeDir, { recursive: true });
  }
  const argv = [
    python,
    scriptPath,
    '--answer',
    answerPath,
    '--workspace',
    resolve(options.workspaceDir),
    '--home',
    resolve(homeDir),
  ];

  const stdoutTail = new ByteTail(VERIFIER_TAIL_BYTES);
  const stderrTail = new ByteTail(VERIFIER_TAIL_BYTES);
  // An object, so the callback's writes are visible after the await.
  const stdout: { lastLine: string | null } = { lastLine: null };
  const lines = new LineSplitter((line) => {
    if (line.trim() !== '') stdout.lastLine = line.trim();
  }, MAX_LINE_BYTES);

  const started = performance.now();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: dirname(scriptPath),
    env: verifierEnv(scratch),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so one kill reaches everything it started.
    detached: true,
  });
  const killGroup = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ESRCH: the group is already gone.
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutTail.push(chunk);
    lines.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => stderrTail.push(chunk));

  let timedOut = false;
  let drain: NodeJS.Timeout | undefined;
  // A grandchild that left the group could hold the pipes open forever.
  const drainSoon = () => {
    drain ??= setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, DRAIN_GRACE_MS);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup();
    drainSoon();
  }, options.timeoutS * 1000);

  const ended = await new Promise<{
    code: number | null;
    signal: string | null;
    spawnError?: Error;
  }>((done) => {
    child.once('error', (err) => done({ code: null, signal: null, spawnError: err }));
    child.once('exit', () => {
      killGroup();
      drainSoon();
    });
    child.once('close', (code, signal) => done({ code, signal }));
  });
  clearTimeout(deadline);
  clearTimeout(drain);
  killGroup();
  lines.end();

  const evidence: ScriptEvidence = {
    argv,
    exit_code: ended.code,
    timed_out: timedOut,
    duration_ms: Math.round(performance.now() - started),
    stdout_line:
      stdout.lastLine === null ? null : utf8Tail(Buffer.from(stdout.lastLine), VERIFIER_TAIL_BYTES),
    stdout_tail: stdoutTail.text(),
    stderr_tail: stderrTail.text(),
  };
  const stderrLine = lastLineOf(evidence.stderr_tail);
  let outcome: VerifierOutcome;
  if (ended.spawnError) {
    outcome = { ok: false, error: `could not start ${python}`, detail: ended.spawnError.message };
  } else if (timedOut) {
    outcome = { ok: false, error: `timed out after ${options.timeoutS} s`, detail: stderrLine };
  } else if (ended.code !== 0) {
    const how =
      ended.code === null ? `was killed by ${ended.signal}` : `exited with code ${ended.code}`;
    const hint = homeOptionHint(evidence.stderr_tail);
    outcome = {
      ok: false,
      error: hint ? `${how}: ${hint}` : how,
      detail: stderrLine,
    };
  } else {
    outcome = parseVerifierLine(stdout.lastLine);
    if (!outcome.ok && outcome.detail === null) outcome = { ...outcome, detail: stderrLine };
  }
  return { outcome, evidence };
}

/** The score of a finished run: passes at `pass_at`; any broken contract is `error`. */
export function verifierResult(run: VerifierRun, passAt: number, scriptName: string): ScorerResult {
  const evidence: ScoreEvidence = { script: run.evidence };
  if (!run.outcome.ok) {
    return scorerError(`verifier ${scriptName} ${run.outcome.error}`, run.outcome.detail, {
      evidence,
    });
  }
  const { score, comment } = run.outcome;
  const summary = `score ${score}, pass at ${passAt}`;
  return graded(score >= passAt, score, comment ? `${comment} (${summary})` : summary, {
    evidence,
  });
}

export interface VerifierKeyInput {
  /** The task's `verify/` folder, materialised; params.script is relative to it. */
  verifyDir: string;
  answer: JsonValue | null;
  workspaceDir: string;
  /** The collected home files, as `--home`; absent gives an empty folder (VerifierOptions.homeDir). */
  homeDir?: string;
  scratchDir: string;
  python?: string;
}

/** One verifier_script key, end to end. Never throws: a broken setup is `error`. */
export function scoreVerifierScript(
  params: VerifierScriptParams,
  input: VerifierKeyInput,
): Promise<ScorerResult> {
  return guardedAsync(async () => {
    const scriptPath = join(input.verifyDir, params.script);
    // The script came from the suite, but a link could still point anywhere.
    const stat = await lstat(scriptPath).catch(() => null);
    if (!stat?.isFile()) {
      return scorerError(`verifier ${params.script} is not a regular file in verify/`);
    }
    const run = await runVerifier({
      scriptPath,
      answer: input.answer,
      workspaceDir: input.workspaceDir,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      timeoutS: params.timeout_s,
      scratchDir: input.scratchDir,
      python: input.python,
    });
    return verifierResult(run, params.pass_at, params.script);
  });
}
