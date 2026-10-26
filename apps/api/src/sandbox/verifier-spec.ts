/**
 * The container a verifier script runs in (plan 14, R7, Phase 5b). This is
 * the exact shape docker-guard accepts for a `hermes-evals-verify-<id>`
 * container (apps/docker-guard/src/verifier-policy.ts); anything else under
 * that name is refused there.
 *
 * What the script can see: one read-only folder at /check, a subpath of the
 * trials volume the worker filled for this run (verifier-runner.ts):
 *
 *   /check/verify/      the task's verify/ folder: the script and its neighbours
 *   /check/answer.json  the answer, JSON null when there is none
 *   /check/workspace/   the workspace it judges
 *   /check/home/        the home files it judges (`memories/…`), maybe empty
 *
 * plus a small tmpfs /tmp and the read-only image. What it can reach:
 * nothing (network none). It runs the trial image's python3 as uid 10000
 * with no capabilities and no way to gain any, under pids and memory
 * limits, with no environment but PATH (Docker adds HOME and HOSTNAME).
 */

export const VERIFIER_PYTHON = '/usr/local/bin/python3';
export const VERIFIER_MOUNT = '/check';
export const VERIFIER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Where each input sits in the container, and in the scratch subpath relative to its root. */
export const VERIFIER_INPUTS = {
  verify: 'verify',
  answer: 'answer.json',
  workspace: 'workspace',
  home: 'home',
} as const;

export interface VerifierLimits {
  memoryMiB: number;
  pids: number;
  tmpMiB: number;
}

/**
 * One verifier run needs far less than a trial (DEFAULT_LIMITS): the five
 * sample suites' scripts read a few files with the standard library.
 */
export const VERIFIER_LIMITS: VerifierLimits = { memoryMiB: 512, pids: 128, tmpMiB: 64 };

export interface VerifierContainerSpec {
  /** ULID: the container is `hermes-evals-verify-<id>` and mounts `verify-<id>`. */
  id: string;
  image: string;
  volume: string;
  /** The script, relative to the verify/ folder (`check.py`, `lib/check.py`). */
  script: string;
  /** Unix seconds after which recovery removes the container even if the worker is gone. */
  deadline: number;
  limits?: VerifierLimits;
}

const MIB = 1024 * 1024;

export const verifierContainerName = (id: string): string => `hermes-evals-verify-${id}`;
export const verifierSubpath = (id: string): string => `verify-${id}`;

/** The script's argv inside the container, as runVerifier builds it outside. */
export function verifierArgv(script: string): string[] {
  const inside = (path: string) => `${VERIFIER_MOUNT}/${path}`;
  return [
    VERIFIER_PYTHON,
    inside(`${VERIFIER_INPUTS.verify}/${script}`),
    '--answer',
    inside(VERIFIER_INPUTS.answer),
    '--workspace',
    inside(VERIFIER_INPUTS.workspace),
    '--home',
    inside(VERIFIER_INPUTS.home),
  ];
}

/** The script's folder is its working directory, so it can import its neighbours. */
function workingDir(script: string): string {
  const folder = script.split('/').slice(0, -1).join('/');
  const verify = `${VERIFIER_MOUNT}/${VERIFIER_INPUTS.verify}`;
  return folder === '' ? verify : `${verify}/${folder}`;
}

export function verifierContainerBody(spec: VerifierContainerSpec): Record<string, unknown> {
  const limits = spec.limits ?? VERIFIER_LIMITS;
  const memory = limits.memoryMiB * MIB;
  const [entrypoint, ...cmd] = verifierArgv(spec.script);
  return {
    Image: spec.image,
    Entrypoint: [entrypoint],
    Cmd: cmd,
    Env: [`PATH=${VERIFIER_PATH}`],
    User: '10000:10000',
    WorkingDir: workingDir(spec.script),
    Hostname: 'verifier',
    Labels: {
      'hermes-evals.role': 'trial',
      'hermes-evals.kind': 'verifier',
      'hermes-evals.verifier': spec.id,
      'hermes-evals.deadline': String(spec.deadline),
    },
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      Init: true,
      AutoRemove: false,
      NetworkMode: 'none',
      Mounts: [
        {
          Type: 'volume',
          Source: spec.volume,
          Target: VERIFIER_MOUNT,
          ReadOnly: true,
          VolumeOptions: { NoCopy: true, Subpath: verifierSubpath(spec.id) },
        },
      ],
      Tmpfs: { '/tmp': `rw,nosuid,nodev,noexec,size=${limits.tmpMiB}m,mode=1777` },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: 1_000_000_000,
      PidsLimit: limits.pids,
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
      RestartPolicy: { Name: 'no' },
    },
  };
}
