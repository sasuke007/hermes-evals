import { describe, expect, it } from 'vitest';
import { checkCreateBody, decideRoute } from '../src/policy.js';
import { config, trialBody, VERIFIER, VERIFIER_NAME, verifierBody } from './fixtures.js';

type Body = ReturnType<typeof verifierBody> & {
  HostConfig: Record<string, unknown> & {
    Mounts: Array<Record<string, unknown> & { VolumeOptions: Record<string, unknown> }>;
  };
  Labels: Record<string, string>;
};

const mutate = (change: (body: Body) => void): Body => {
  const body = verifierBody() as Body;
  change(body);
  return body;
};

const check = (body: unknown, name = VERIFIER_NAME) => checkCreateBody(body, config, name);

describe('verifier container body (R7)', () => {
  it('accepts the verifier shape the worker sends, under a verifier name', () => {
    const result = check(verifierBody());
    expect(result.ok ? result.kind : result.reasons).toBe('verifier');
  });

  it('accepts the minimal shape: no optional field', () => {
    const result = check(
      mutate((b) => {
        for (const key of ['Hostname', 'AttachStdin', 'AttachStdout', 'AttachStderr']) {
          delete (b as Record<string, unknown>)[key];
        }
        for (const key of ['Ulimits', 'LogConfig', 'RestartPolicy', 'Privileged', 'AutoRemove']) {
          delete b.HostConfig[key];
        }
        delete b.HostConfig.Mounts[0]!.VolumeOptions.NoCopy;
      }),
    );
    expect(result.ok ? result.kind : result.reasons).toBe('verifier');
  });

  const variations: Array<[string, (body: Body) => void]> = [
    ['a slot network', (b) => (b.HostConfig.NetworkMode = 'hermes-evals-trial-0')],
    ['the default bridge', (b) => (b.HostConfig.NetworkMode = 'bridge')],
    ['host networking', (b) => (b.HostConfig.NetworkMode = 'host')],
    [
      'a network endpoint',
      (b) =>
        ((b as Record<string, unknown>).NetworkingConfig = {
          EndpointsConfig: { 'hermes-evals-trial-0': {} },
        }),
    ],
    ['a writable mount', (b) => (b.HostConfig.Mounts[0]!.ReadOnly = false)],
    ['a mount without ReadOnly', (b) => delete b.HostConfig.Mounts[0]!.ReadOnly],
    [
      'a second mount',
      (b) =>
        b.HostConfig.Mounts.push({
          Type: 'volume',
          Source: 'hermes-evals-trials',
          Target: '/out',
          ReadOnly: true,
          VolumeOptions: { Subpath: `verify-${VERIFIER}` },
        }),
    ],
    ['another volume', (b) => (b.HostConfig.Mounts[0]!.Source = 'hermes-evals_evaldata')],
    ['a bind mount', (b) => (b.HostConfig.Mounts[0]!.Type = 'bind')],
    ['a mount elsewhere', (b) => (b.HostConfig.Mounts[0]!.Target = '/workspace')],
    [
      'an attempt directory',
      (b) => (b.HostConfig.Mounts[0]!.VolumeOptions.Subpath = `${VERIFIER}/workspace`),
    ],
    [
      'another verifier directory',
      (b) => (b.HostConfig.Mounts[0]!.VolumeOptions.Subpath = 'verify-01K8ZQ7M3V5X9C2B4N6P8R0T2B'),
    ],
    ['the whole trials volume', (b) => (b.HostConfig.Mounts[0]!.VolumeOptions.Subpath = '')],
    ['another image', (b) => (b.Image = 'python:3.12-slim')],
    ['another entrypoint', (b) => (b.Entrypoint = ['/bin/sh', '-c'])],
    ['the hermes entrypoint', (b) => (b.Entrypoint = ['/opt/hermes/.venv/bin/hermes'])],
    ['no entrypoint', (b) => delete (b as Record<string, unknown>).Entrypoint],
    ['an added capability', (b) => (b.HostConfig.CapAdd = ['NET_RAW'])],
    ['keeping capabilities', (b) => (b.HostConfig.CapDrop = [])],
    ['privileged mode', (b) => (b.HostConfig.Privileged = true)],
    ['new privileges', (b) => (b.HostConfig.SecurityOpt = ['seccomp=unconfined'])],
    ['a writable root', (b) => (b.HostConfig.ReadonlyRootfs = false)],
    ['no init', (b) => (b.HostConfig.Init = false)],
    ['root', (b) => (b.User = '0:0')],
    ['another uid', (b) => (b.User = '1000:1000')],
    ['an environment variable', (b) => (b.Env = [...(b.Env as string[]), 'DATABASE_URL=x'])],
    ['an environment without PATH', (b) => (b.Env = ['HOME=/tmp'])],
    ['no environment', (b) => delete (b as Record<string, unknown>).Env],
    ['a working directory outside verify/', (b) => (b.WorkingDir = '/check/workspace')],
    ['a working directory that climbs out', (b) => (b.WorkingDir = '/check/verify/../home')],
    ['swap', (b) => (b.HostConfig.MemorySwap = -1)],
    ['no memory limit', (b) => (b.HostConfig.Memory = 0)],
    ['a trial-sized memory limit', (b) => (b.HostConfig.Memory = 4 * 1024 * 1024 * 1024)],
    ['too many pids', (b) => (b.HostConfig.PidsLimit = 4096)],
    ['no pids limit', (b) => delete b.HostConfig.PidsLimit],
    ['a large tmpfs', (b) => (b.HostConfig.Tmpfs = { '/tmp': 'rw,nosuid,nodev,size=512m' })],
    ['no tmpfs', (b) => delete b.HostConfig.Tmpfs],
    ['host pid namespace', (b) => (b.HostConfig.PidMode = 'host')],
    [
      'devices',
      (b) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm' }]),
    ],
    ['binds', (b) => (b.HostConfig.Binds = ['/:/host:ro'])],
    ['a tty', (b) => (b.Tty = true)],
    ['stdin', (b) => (b.OpenStdin = true)],
    ['no trial label', (b) => delete b.Labels['hermes-evals.role']],
    ['no verifier kind', (b) => delete b.Labels['hermes-evals.kind']],
    ['an attempt label', (b) => (b.Labels['hermes-evals.attempt'] = VERIFIER)],
    ['no deadline', (b) => delete b.Labels['hermes-evals.deadline']],
    [
      'a label for another verifier',
      (b) => (b.Labels['hermes-evals.verifier'] = '01K8ZQ7M3V5X9C2B4N6P8R0T2B'),
    ],
    ['an unknown field', (b) => ((b as Record<string, unknown>).Volumes = { '/x': {} })],
    ['auto remove', (b) => (b.HostConfig.AutoRemove = true)],
    ['a restart policy', (b) => (b.HostConfig.RestartPolicy = { Name: 'always' })],
  ];

  it.each(variations)('refuses %s', (_name, change) => {
    expect(check(mutate(change)).ok).toBe(false);
  });

  it('checks a verifier name against the verifier shape only, and other names against the trial shape', () => {
    expect(check(trialBody()).ok).toBe(false);
    expect(checkCreateBody(verifierBody(), config, `hermes-evals-run-${VERIFIER}`).ok).toBe(false);
    expect(checkCreateBody(verifierBody(), config, `hermes-evals-probe-${VERIFIER}`).ok).toBe(
      false,
    );
    expect(checkCreateBody(verifierBody(), config).ok).toBe(false);
    expect(check(verifierBody(), 'hermes-evals-verify-01K8ZQ7M3V5X9C2B4N6P8R0T2B').ok).toBe(false);
  });

  it('allows creating and operating on verifier containers by name', () => {
    const allowed = (method: string, url: string) => decideRoute(method, url, config);
    const create = allowed('POST', `/v1.45/containers/create?name=${VERIFIER_NAME}`);
    expect(create.allow && create.name).toBe(VERIFIER_NAME);
    expect(allowed('POST', `/containers/${VERIFIER_NAME}/start`).allow).toBe(true);
    expect(allowed('GET', `/containers/${VERIFIER_NAME}/logs?follow=1&stdout=1`).allow).toBe(true);
    expect(allowed('POST', '/containers/create?name=hermes-evals-verify-x').allow).toBe(false);
  });
});
