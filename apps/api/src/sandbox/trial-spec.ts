/**
 * The container a trial runs in. This is the exact shape docker-guard
 * accepts; anything more permissive is refused there as well.
 *
 * What the trial can see: its own home at /opt/data and workspace at
 * /workspace (two subpaths of the trials volume), a tmpfs /tmp, and a
 * read-only image. What it can reach: only the egress service on its slot
 * network. It runs as uid 10000 with no capabilities and no way to gain any.
 */

export const TRIAL_HOME = '/opt/data';
export const TRIAL_WORKSPACE = '/workspace';
export const HERMES_ENTRYPOINT = '/opt/hermes/.venv/bin/hermes';

export interface TrialLimits {
  memoryMiB: number;
  cpus: number;
  pids: number;
  tmpMiB: number;
  shmMiB?: number;
}

export const DEFAULT_LIMITS: TrialLimits = { memoryMiB: 1536, cpus: 1, pids: 1024, tmpMiB: 512 };

export interface TrialSpec {
  /** Container name: one live container per run. */
  name: string;
  runId: string;
  attemptId: string;
  image: string;
  volume: string;
  /** The slot network this trial has to itself, or 'none' for a fully offline container. */
  network: string;
  entrypoint?: string[];
  cmd: string[];
  env: Record<string, string>;
  /** Unix seconds after which recovery stops the container even if the worker is gone. */
  deadline: number;
  limits?: TrialLimits;
}

const MIB = 1024 * 1024;

export function trialContainerBody(spec: TrialSpec): Record<string, unknown> {
  const limits = spec.limits ?? DEFAULT_LIMITS;
  const memory = limits.memoryMiB * MIB;
  return {
    Image: spec.image,
    Entrypoint: spec.entrypoint ?? [HERMES_ENTRYPOINT],
    Cmd: spec.cmd,
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    User: '10000:10000',
    WorkingDir: TRIAL_WORKSPACE,
    Hostname: 'trial',
    Labels: {
      'hermes-evals.role': 'trial',
      'hermes-evals.run': spec.runId,
      'hermes-evals.attempt': spec.attemptId,
      'hermes-evals.deadline': String(spec.deadline),
    },
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StopSignal: 'SIGTERM',
    StopTimeout: 10,
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      Init: true,
      AutoRemove: false,
      NetworkMode: spec.network,
      Mounts: [
        {
          Type: 'volume',
          Source: spec.volume,
          Target: TRIAL_HOME,
          VolumeOptions: { NoCopy: true, Subpath: `${spec.attemptId}/home` },
        },
        {
          Type: 'volume',
          Source: spec.volume,
          Target: TRIAL_WORKSPACE,
          VolumeOptions: { NoCopy: true, Subpath: `${spec.attemptId}/workspace` },
        },
      ],
      Tmpfs: { '/tmp': `rw,nosuid,nodev,exec,size=${limits.tmpMiB}m,mode=1777` },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(limits.cpus * 1e9),
      PidsLimit: limits.pids,
      ...(limits.shmMiB ? { ShmSize: limits.shmMiB * MIB } : {}),
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '50m', 'max-file': '1' } },
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig:
      spec.network === 'none' ? undefined : { EndpointsConfig: { [spec.network]: {} } },
  };
}
