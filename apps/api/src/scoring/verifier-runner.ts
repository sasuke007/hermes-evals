/**
 * Where a verifier script runs (plan 14, R7). Until Phase 5b the worker ran
 * each script as its own subprocess (runVerifier in verifier.ts), with the
 * worker's uid and network. Before suites can arrive as a .zip, every
 * verifier run moves into a container of its own, created through
 * docker-guard: scoring, the load self-checks and the draft self-checks.
 * The worker installs this runner for the whole process at start
 * (SandboxService, through useVerifierRunner), so every caller of
 * scoreVerifierScript gets it without passing it along.
 *
 * The container (sandbox/verifier-spec.ts): the trial image's python3;
 * network none; a read-only root and a small tmpfs; the script's folder,
 * the answer, the workspace and the home mounted read-only from a scratch
 * subpath of the trials volume; no environment but PATH; cap-drop ALL and
 * no-new-privileges; the trial uid; pids and memory limits; the verifier's
 * deadline, after which it is killed and removed. docker-guard admits
 * exactly that spec (its verifier-policy.ts) and refuses any other verifier
 * container: a network, a writable mount, another image, an added
 * capability.
 *
 * The contract does not change: the last non-empty stdout line is a JSON
 * object with `score` from 0 to 1 and an optional `comment`; anything else
 * is `error` (verifier.ts verifierOutcome, verifierResult). Callers take a
 * VerifierRunner, so tests on a machine without Docker use the subprocess.
 */
import { cp, lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { newId } from '../database/ids.js';
import type { EngineClient } from '../sandbox/engine-client.js';
import { utf8Tail } from '../sandbox/streams.js';
import { forceRemoveTree } from '../sandbox/trial-runner.js';
import { runVerifierContainer } from '../sandbox/verifier-container.js';
import {
  VERIFIER_INPUTS,
  VERIFIER_LIMITS,
  verifierArgv,
  verifierSubpath,
  type VerifierLimits,
} from '../sandbox/verifier-spec.js';
import {
  MAX_LINE_BYTES,
  runVerifier,
  VERIFIER_TAIL_BYTES,
  verifierOutcome,
  VerifierUnavailable,
  type VerifierOptions,
  type VerifierRun,
} from './verifier.js';

export { useVerifierRunner, currentVerifierRunner, VerifierUnavailable } from './verifier.js';

/**
 * Runs one verifier script to completion or its deadline. Never throws for
 * anything the script does: a broken contract, a non-zero exit or the
 * deadline is an outcome (VerifierOutcome), with the evidence of the run.
 * Throws VerifierUnavailable when the script could not be run at all.
 */
export interface VerifierRunner {
  run(options: VerifierOptions): Promise<VerifierRun>;
}

/** The worker's own subprocess (the runner of Phases 3 to 6), for tests and machines without Docker. */
export const subprocessVerifierRunner: VerifierRunner = { run: runVerifier };

/** What the container runner needs from the worker. */
export interface ContainerVerifierRunnerDeps {
  /** The Docker API through docker-guard's socket. */
  engine: EngineClient;
  /** TRIAL_IMAGE: the verifier runs that image's python3. */
  image: string;
  /** TRIAL_VOLUME, and TRIALS_DIR where the worker mounts it: the scratch subpath is made there. */
  volume: string;
  trialsDir: string;
  /** Memory, pids and tmpfs of one verifier container; VERIFIER_LIMITS when absent. */
  limits?: VerifierLimits;
}

/** Seconds the container's deadline label adds to the script's timeout, before recovery may remove it. */
const DEADLINE_SLACK_S = 120;

/** A scratch subpath this old was left by a worker that died mid-run; any live one is far younger. */
export const STALE_VERIFIER_SCRATCH_MS = 6 * 60 * 60 * 1000;

const STALE_NAME = /^verify-[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Copies a folder the verifier reads: directories and regular files only.
 * A link or special file is left out, as collection leaves them out of a
 * workspace: inside the container it could only point at the container's
 * own files anyway.
 */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => {
      const entry = await lstat(source);
      return entry.isDirectory() || entry.isFile();
    },
  });
}

/** The script relative to the folder it is copied with, or null when it is not inside it. */
function scriptInFolder(scriptPath: string, folder: string): string | null {
  const rel = relative(resolve(folder), resolve(scriptPath));
  if (rel === '' || rel.startsWith('..') || resolve(folder, rel) !== resolve(scriptPath))
    return null;
  return rel.split(sep).join('/');
}

/**
 * Removes the `verify-<id>` scratch subpaths older than `maxAgeMs` that a
 * worker left when it died mid-run. Returns how many it removed; never
 * throws for one it cannot remove.
 */
export async function sweepVerifierScratch(
  trialsDir: string,
  maxAgeMs = STALE_VERIFIER_SCRATCH_MS,
  now = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(trialsDir)).filter((name) => STALE_NAME.test(name));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(trialsDir, name);
    try {
      if (now - (await stat(path)).mtimeMs < maxAgeMs) continue;
      await forceRemoveTree(path);
      removed += 1;
    } catch {
      // Gone meanwhile, or not removable: the next sweep tries again.
    }
  }
  return removed;
}

/**
 * A runner that copies the script's folder, the answer, the workspace and
 * the home into a fresh `verify-<id>` subpath of the trials volume, runs
 * the script there in the container above under `options.timeoutS`, reads
 * its stdout and stderr (the same tails and result line as runVerifier),
 * and removes the container and the subpath whatever happens. The evidence
 * shows the argv as the container ran it.
 */
export function containerVerifierRunner(deps: ContainerVerifierRunnerDeps): VerifierRunner {
  let swept = false;
  return {
    async run(options: VerifierOptions): Promise<VerifierRun> {
      if (!swept) {
        swept = true;
        void sweepVerifierScratch(deps.trialsDir);
      }
      const verifyDir = options.verifyDir ?? dirname(options.scriptPath);
      const script = scriptInFolder(options.scriptPath, verifyDir);
      if (script === null) {
        throw new VerifierUnavailable(
          `the script ${options.scriptPath} is not inside the folder ${verifyDir} it runs from`,
        );
      }
      const id = newId();
      const root = join(deps.trialsDir, verifierSubpath(id));
      try {
        try {
          await mkdir(root, { mode: 0o755 });
          await copyTree(verifyDir, join(root, VERIFIER_INPUTS.verify));
          await writeFile(
            join(root, VERIFIER_INPUTS.answer),
            `${JSON.stringify(options.answer)}\n`,
            { mode: 0o644 },
          );
          await copyTree(options.workspaceDir, join(root, VERIFIER_INPUTS.workspace));
          const home = join(root, VERIFIER_INPUTS.home);
          if (options.homeDir === undefined) await mkdir(home, { mode: 0o755 });
          else await copyTree(options.homeDir, home);
        } catch (err) {
          throw new VerifierUnavailable(
            `could not prepare the verifier's folder on the trials volume: ${(err as Error).message}`,
            { cause: err },
          );
        }

        const limits = deps.limits ?? VERIFIER_LIMITS;
        let run;
        try {
          run = await runVerifierContainer({
            engine: deps.engine,
            spec: {
              id,
              image: deps.image,
              volume: deps.volume,
              script,
              deadline: Math.ceil(Date.now() / 1000 + options.timeoutS + DEADLINE_SLACK_S),
              limits,
            },
            timeoutMs: options.timeoutS * 1000,
            tailBytes: VERIFIER_TAIL_BYTES,
            maxLineBytes: MAX_LINE_BYTES,
          });
        } catch (err) {
          throw new VerifierUnavailable(
            `could not start the verifier container: ${(err as Error).message}`,
            { cause: err },
          );
        }
        const outcome = verifierOutcome(
          {
            timedOut: run.timedOut,
            code: run.exitCode,
            signal: null,
            stderrTail: run.stderrTail,
            lastLine: run.lastLine,
            ...(run.oomKilled ? { killedBy: `its ${limits.memoryMiB} MiB memory limit` } : {}),
          },
          options.timeoutS,
        );
        return {
          outcome,
          evidence: {
            argv: verifierArgv(script),
            exit_code: run.exitCode,
            timed_out: run.timedOut,
            duration_ms: run.durationMs,
            stdout_line:
              run.lastLine === null
                ? null
                : utf8Tail(Buffer.from(run.lastLine), VERIFIER_TAIL_BYTES),
            stdout_tail: run.stdoutTail,
            stderr_tail: run.logError
              ? `${run.stderrTail}\n[output incomplete: ${run.logError}]`
              : run.stderrTail,
          },
        };
      } finally {
        await forceRemoveTree(root).catch(() => {});
      }
    },
  };
}
