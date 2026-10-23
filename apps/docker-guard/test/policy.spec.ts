import { describe, expect, it } from 'vitest';
import { checkCreateBody, decideRoute, restrictListQuery } from '../src/policy.js';
import { ATTEMPT, config, trialBody } from './fixtures.js';

type Body = ReturnType<typeof trialBody> & { HostConfig: Record<string, unknown> };

const mutate = (change: (body: Body) => void): Body => {
  const body = trialBody() as Body;
  change(body);
  return body;
};

describe('create body', () => {
  it('accepts the trial shape the worker sends', () => {
    const result = checkCreateBody(trialBody(), config);
    expect(result.ok ? 'ok' : result.reasons).toBe('ok');
  });

  const escapes: Array<[string, (body: Body) => void]> = [
    ['privileged mode', (b) => (b.HostConfig.Privileged = true)],
    ['a host bind of /', (b) => (b.HostConfig.Binds = ['/:/host'])],
    [
      'the docker socket',
      (b) => (b.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']),
    ],
    ['another image', (b) => (b.Image = 'alpine:3')],
    ['root', (b) => (b.User = '0:0')],
    ['no user', (b) => delete (b as Record<string, unknown>).User],
    ['an added capability', (b) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['keeping capabilities', (b) => (b.HostConfig.CapDrop = [])],
    ['a writable root', (b) => (b.HostConfig.ReadonlyRootfs = false)],
    ['no init', (b) => (b.HostConfig.Init = false)],
    ['host networking', (b) => (b.HostConfig.NetworkMode = 'host')],
    ['the default bridge', (b) => (b.HostConfig.NetworkMode = 'bridge')],
    ['the backend network', (b) => (b.HostConfig.NetworkMode = 'hermes-evals_backend')],
    [
      'a second network',
      (b) =>
        ((b.NetworkingConfig as { EndpointsConfig: Record<string, object> }).EndpointsConfig[
          'hermes-evals-trial-1'
        ] = {}),
    ],
    ['host pid namespace', (b) => (b.HostConfig.PidMode = 'host')],
    ['host ipc namespace', (b) => (b.HostConfig.IpcMode = 'host')],
    ['host user namespace', (b) => (b.HostConfig.UsernsMode = 'host')],
    [
      'devices',
      (b) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm' }]),
    ],
    ['published ports', (b) => (b.HostConfig.PortBindings = { '22/tcp': [{ HostPort: '2222' }] })],
    ['extra hosts', (b) => (b.HostConfig.ExtraHosts = ['host.docker.internal:host-gateway'])],
    ['custom dns', (b) => (b.HostConfig.Dns = ['8.8.8.8'])],
    ['another runtime', (b) => (b.HostConfig.Runtime = 'nvidia')],
    ['unmasked proc paths', (b) => (b.HostConfig.MaskedPaths = [])],
    ['sysctls', (b) => (b.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
    [
      'volumes from another container',
      (b) => (b.HostConfig.VolumesFrom = ['hermes-evals-worker-1']),
    ],
    ['seccomp unconfined', (b) => (b.HostConfig.SecurityOpt = ['seccomp=unconfined'])],
    ['swap', (b) => (b.HostConfig.MemorySwap = -1)],
    ['no memory limit', (b) => (b.HostConfig.Memory = 0)],
    ['too many pids', (b) => (b.HostConfig.PidsLimit = 100_000)],
    ['a huge tmpfs', (b) => (b.HostConfig.Tmpfs = { '/tmp': 'rw,nosuid,nodev,size=9999m' })],
    ['a tmpfs elsewhere', (b) => (b.HostConfig.Tmpfs = { '/etc': 'rw,nosuid,nodev,size=10m' })],
    [
      'another volume',
      (b) =>
        ((b.HostConfig.Mounts as Array<{ Source: string }>)[0]!.Source = 'hermes-evals_evaldata'),
    ],
    ['a bind mount', (b) => ((b.HostConfig.Mounts as Array<{ Type: string }>)[0]!.Type = 'bind')],
    [
      'the whole trials volume',
      (b) =>
        ((
          b.HostConfig.Mounts as Array<{ VolumeOptions: { Subpath: string } }>
        )[0]!.VolumeOptions.Subpath = ''),
    ],
    [
      'another attempt directory',
      (b) =>
        ((
          b.HostConfig.Mounts as Array<{ VolumeOptions: { Subpath: string } }>
        )[1]!.VolumeOptions.Subpath = '01K8ZQ7M3V5X9C2B4N6P8R0T1X/workspace'),
    ],
    [
      'a parent path',
      (b) =>
        ((
          b.HostConfig.Mounts as Array<{ VolumeOptions: { Subpath: string } }>
        )[1]!.VolumeOptions.Subpath = `${ATTEMPT}/../x`),
    ],
    [
      'home mounted as workspace',
      (b) => ((b.HostConfig.Mounts as Array<{ Target: string }>)[1]!.Target = '/opt/data'),
    ],
    [
      'a mount over /etc',
      (b) => ((b.HostConfig.Mounts as Array<{ Target: string }>)[0]!.Target = '/etc'),
    ],
    ['no trial label', (b) => delete (b.Labels as Record<string, string>)['hermes-evals.role']],
    [
      'a foreign label',
      (b) => ((b.Labels as Record<string, string>)['com.docker.compose.project'] = 'x'),
    ],
    ['a tty', (b) => (b.Tty = true)],
    ['stdin', (b) => (b.OpenStdin = true)],
    ['an unknown top-level field', (b) => ((b as Record<string, unknown>).Volumes = { '/x': {} })],
    ['auto remove', (b) => (b.HostConfig.AutoRemove = true)],
    ['a restart policy', (b) => (b.HostConfig.RestartPolicy = { Name: 'always' })],
  ];

  it.each(escapes)('refuses %s', (_name, change) => {
    expect(checkCreateBody(mutate(change), config).ok).toBe(false);
  });
});

describe('routes', () => {
  const allowed = (method: string, url: string) => decideRoute(method, url, config).allow;

  const NAME = 'hermes-evals-run-01K8ZQ7M3V5X9C2B4N6P8R0T1W';
  const ID = 'a'.repeat(64);

  it('allows only the calls a trial lifecycle needs', () => {
    expect(allowed('GET', '/v1.45/_ping')).toBe(true);
    expect(allowed('GET', '/info')).toBe(true);
    expect(allowed('GET', `/images/${encodeURIComponent(config.trialImage)}/json`)).toBe(true);
    expect(allowed('POST', `/v1.45/containers/create?name=${NAME}`)).toBe(true);
    for (const op of ['start', 'stop?t=10', 'kill?signal=SIGKILL', 'wait?condition=next-exit']) {
      expect(allowed('POST', `/containers/${ID}/${op}`), op).toBe(true);
    }
    expect(allowed('GET', `/containers/${NAME}/logs?follow=1&stdout=1&stderr=1`)).toBe(true);
    expect(allowed('GET', `/containers/${ID}/json`)).toBe(true);
    expect(allowed('DELETE', `/containers/${ID}?force=1&v=1`)).toBe(true);
    expect(allowed('GET', '/containers/json?all=1')).toBe(true);
  });

  it('addresses containers only by full id or trial name, with known parameters', () => {
    for (const [method, url] of [
      ['POST', '/containers/abc123/stop'],
      ['POST', '/containers/postgres/stop'],
      ['DELETE', '/containers/hermes-evals-postgres-1?force=1'],
      ['POST', `/containers/${ID}/stop?t=10&signal=SIGKILL`],
      ['POST', `/containers/${ID}/kill?signal=SIGSTOP`],
      ['GET', `/containers/${ID}/logs?follow=1&details=1`],
      ['DELETE', `/containers/${ID}?link=1`],
      ['GET', '/info?x=1'],
      ['GET', '/containers/json?all=1&size=1'],
      ['GET', '/images/%E0%A4%A/json'],
    ] as const) {
      expect(allowed(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it('refuses everything else', () => {
    for (const [method, url] of [
      ['POST', `/containers/${ID}/exec`],
      ['POST', '/exec/abc/start'],
      ['POST', '/build'],
      ['POST', '/images/create?fromImage=alpine'],
      ['GET', '/images/alpine/json'],
      ['POST', '/networks/create'],
      ['POST', '/networks/hermes-evals_backend/connect'],
      ['POST', '/volumes/create'],
      ['DELETE', '/volumes/hermes-evals_pgdata'],
      ['GET', `/containers/${ID}/archive?path=/`],
      ['PUT', `/containers/${ID}/archive?path=/`],
      ['POST', `/containers/${ID}/attach?stream=1`],
      ['POST', `/containers/${ID}/update`],
      ['POST', `/containers/${ID}/commit`],
      ['GET', '/secrets'],
      ['POST', '/swarm/init'],
      ['POST', '/plugins/pull'],
      ['GET', '/events'],
      ['POST', '/containers/create?name=postgres'],
      ['POST', '/containers/create'],
      ['POST', `/containers/create?name=${NAME}&platform=linux/amd64`],
      ['GET', '/containers/..%2F..%2Fsecrets/json'],
    ] as const) {
      expect(allowed(method, url), `${method} ${url}`).toBe(false);
    }
  });

  it('refuses request targets that are not plain paths, and forwards only the normalised path', () => {
    for (const target of [
      '//docker/containers/create',
      'http://docker/containers/json',
      '*',
      'containers/json',
    ]) {
      expect(allowed('GET', target), target).toBe(false);
    }
    const decision = decideRoute('GET', `/v1.45/containers/x/../${ID}/json`, config);
    expect(decision.allow && decision.path).toBe(`/containers/${ID}/json`);
    const encoded = decideRoute('POST', '/containers/abc/%2e%2e/%2e%2e/build', config);
    expect(encoded.allow).toBe(false);
  });

  it('forces the trial label onto container lists', () => {
    const forced = new URL(
      restrictListQuery('/containers/json?all=1&filters={"label":["x=y"]}'),
      'http://g',
    );
    expect(JSON.parse(forced.searchParams.get('filters')!)).toEqual({
      label: ['x=y', 'hermes-evals.role=trial'],
    });
    const bare = new URL(restrictListQuery('/containers/json'), 'http://g');
    expect(JSON.parse(bare.searchParams.get('filters')!)).toEqual({
      label: ['hermes-evals.role=trial'],
    });
  });
});
