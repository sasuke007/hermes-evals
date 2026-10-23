import type { GuardConfig } from '../src/policy.js';

export const config: GuardConfig = {
  trialImage: 'hermes-evals/trial:v0.22.4-4d04303',
  trialVolume: 'hermes-evals-trials',
  trialNetworks: ['hermes-evals-trial-0', 'hermes-evals-trial-1'],
};

export const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0T1W';

/** The body the worker sends for a trial: the only shape the guard accepts. */
export function trialBody(): Record<string, unknown> {
  return {
    Image: config.trialImage,
    Entrypoint: ['/opt/hermes/.venv/bin/hermes'],
    Cmd: ['chat', '--query-file', '/opt/data/task.txt', '--oneshot', '--format', 'stream-json'],
    Env: ['HOME=/opt/data', 'HERMES_HOME=/opt/data'],
    User: '10000:10000',
    WorkingDir: '/workspace',
    Hostname: 'trial',
    Labels: {
      'hermes-evals.role': 'trial',
      'hermes-evals.attempt': ATTEMPT,
      'hermes-evals.run': ATTEMPT,
    },
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
      NetworkMode: 'hermes-evals-trial-0',
      Mounts: [
        {
          Type: 'volume',
          Source: 'hermes-evals-trials',
          Target: '/opt/data',
          VolumeOptions: { NoCopy: true, Subpath: `${ATTEMPT}/home` },
        },
        {
          Type: 'volume',
          Source: 'hermes-evals-trials',
          Target: '/workspace',
          VolumeOptions: { NoCopy: true, Subpath: `${ATTEMPT}/workspace` },
        },
      ],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,exec,size=512m,mode=1777' },
      Memory: 1536 * 1024 * 1024,
      MemorySwap: 1536 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 1024,
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '1' } },
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig: { EndpointsConfig: { 'hermes-evals-trial-0': {} } },
  };
}
