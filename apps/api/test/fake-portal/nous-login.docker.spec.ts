/**
 * nous-login (docker/nous-login.py) in the real trial image, against the fake
 * portal (fake_portal.py) on a throwaway Docker network: every login state
 * plan 6.1 defines, a second Connect replacing the first, Disconnect, and the
 * startup check of the Hermes functions it calls (plan 16, "model access").
 *
 * Gated: RUN_SANDBOX_TESTS=1 and a Docker CLI that reaches the engine. It
 * talks to Docker directly (networks, published ports and copies, which the
 * guard rightly refuses), creates only `hermes-evals-nl-test-*` containers and
 * one network, mounts no volume (the home is a tmpfs), and removes all of it.
 * The script is copied into the containers from the working tree, to the
 * path docker/trial.Dockerfile installs it at, so the test covers the source
 * without rebuilding the shared image.
 *
 * Nothing here can reach the real Nous Portal: HERMES_PORTAL_BASE_URL and
 * NOUS_INFERENCE_BASE_URL name the fake, and every other HTTP(S) request goes
 * to a proxy address where nothing listens.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { NousLoginSchema, type NousLogin } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NousLoginStatusSchema,
  type NousLoginStatus,
} from '../../src/providers/nous-login.client.js';

const run = promisify(execFile);
const IMAGE = process.env.TRIAL_IMAGE ?? 'hermes-evals/trial:v0.22.4-4d04303';
const PYTHON = '/opt/hermes/.venv/bin/python';
const SCRIPT = '/opt/nous-login/nous-login.py';
const REPO = resolve(import.meta.dirname, '../../../..');
const PREFIX = `hermes-evals-nl-test-${randomBytes(4).toString('hex')}`;
const NETWORK = PREFIX;
/** Text no response, log or file outside the home may contain: the fake's tokens. */
const SECRET_MARKERS = ['eyJ', 'fake-refresh', 'opaque-'];

const docker = async (...args: string[]): Promise<string> =>
  (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

interface Started {
  name: string;
  url: string;
}

let staging = '';

/** A container from the trial image on the test network, with `files` copied in before it starts. */
async function container(
  role: string,
  port: number,
  options: {
    env?: Record<string, string>;
    alias?: string;
    command: string[];
    copy: [string, string][];
  },
): Promise<Started> {
  const name = `${PREFIX}-${role}`;
  const env = Object.entries(options.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await docker(
    'create',
    '--name',
    name,
    '--network',
    NETWORK,
    ...(options.alias ? ['--network-alias', options.alias] : []),
    '-p',
    `127.0.0.1::${port}`,
    '--tmpfs',
    '/opt/data:rw,uid=10000,gid=10000,mode=0700',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...env,
    '--entrypoint',
    PYTHON,
    IMAGE,
    ...options.command,
  );
  for (const [from, to] of options.copy) await docker('cp', from, `${name}:${to}`);
  await docker('start', name);
  const published = await docker('port', name, `${port}/tcp`);
  const url = `http://${published.split('\n')[0]!.trim()}`;
  await waitFor(async () => (await fetch(`${url}/health`)).ok, 15_000);
  return { name, url };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const LOGIN_ENV = {
  HOME: '/opt/data',
  HERMES_HOME: '/opt/data',
  HERMES_PORTAL_BASE_URL: 'http://portal:8700',
  NOUS_INFERENCE_BASE_URL: 'http://portal:8700/v1',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: 'portal',
};

/** nous-login started through a wrapper that changes Hermes first, as a future revision might. */
const patchedLogin = (role: string, patch: string): Promise<Started> =>
  container(role, 8650, {
    env: LOGIN_ENV,
    command: [
      '-c',
      `import sys, runpy, hermes_cli.auth as a\n${patch}\nsys.argv = ['${SCRIPT}']\nrunpy.run_path('${SCRIPT}', run_name='__main__')`,
    ],
    copy: [[join(staging, 'nous-login'), '/opt/']],
  });

describe.runIf(process.env.RUN_SANDBOX_TESTS === '1')('nous-login in the trial image', () => {
  let portal: Started;
  let login: Started;

  async function call(method: string, path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${login.url}${path}`, { method });
    const text = await res.text();
    for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
    return { status: res.status, body: JSON.parse(text) as unknown };
  }
  const status = async (): Promise<NousLoginStatus> =>
    NousLoginStatusSchema.parse((await call('GET', '/status')).body);
  const loginCall = async (method: string, path = '/login'): Promise<NousLogin> => {
    const res = await call(method, path);
    expect(res.status).toBe(200);
    return NousLoginSchema.parse(res.body);
  };
  const scenario = async (body: Record<string, unknown>) => {
    const res = await fetch(`${portal.url}/_control`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(res.ok).toBe(true);
  };
  const portalRequests = async () =>
    (
      (await (await fetch(`${portal.url}/_requests`)).json()) as {
        requests: { path: string; grantType: string | null; deviceCode: string | null }[];
      }
    ).requests;
  /** The fake issues user code FAKE-000n with device code dc-n. */
  const pollsFor = async (started: NousLogin) => {
    const code = `dc-${Number(started.userCode!.slice('FAKE-'.length))}`;
    return (await portalRequests()).filter((r) => r.deviceCode === code).length;
  };
  const until = async (state: NousLogin['state'], timeoutMs = 15_000) => {
    let last: NousLogin | null = null;
    await waitFor(async () => (last = await loginCall('GET')).state === state, timeoutMs).catch(
      () => {
        throw new Error(`login did not reach ${state}: ${JSON.stringify(last)}`);
      },
    );
    return last!;
  };
  const childProcesses = async () =>
    (await docker('exec', login.name, 'ps', '-eo', 'args'))
      .split('\n')
      .filter((l) => l.includes('--login-child'));

  beforeAll(async () => {
    staging = await mkdtemp(join(tmpdir(), 'hermes-evals-nl-'));
    await mkdir(join(staging, 'nous-login'), { mode: 0o755 });
    await chmod(join(staging, 'nous-login'), 0o755);
    await copyFile(
      join(REPO, 'docker/nous-login.py'),
      join(staging, 'nous-login', 'nous-login.py'),
    );
    await chmod(join(staging, 'nous-login', 'nous-login.py'), 0o644);
    await docker('network', 'create', '--label', 'hermes-evals.role=test', NETWORK);
    portal = await container('portal', 8700, {
      alias: 'portal',
      command: ['/tmp/fake_portal.py'],
      copy: [[join(REPO, 'apps/api/test/fake-portal/fake_portal.py'), '/tmp/fake_portal.py']],
    });
    login = await container('login', 8650, {
      env: LOGIN_ENV,
      command: [SCRIPT],
      copy: [[join(staging, 'nous-login'), '/opt/']],
    });
  }, 120_000);

  afterAll(async () => {
    const names = (await docker('ps', '-aq', '--filter', `name=${PREFIX}`))
      .split('\n')
      .filter(Boolean);
    if (names.length) await docker('rm', '-f', '-v', ...names);
    await docker('network', 'rm', NETWORK).catch(() => '');
    if (staging) await rm(staging, { recursive: true, force: true });
    expect(await docker('ps', '-aq', '--filter', `name=${PREFIX}`)).toBe('');
    expect(await docker('network', 'ls', '-q', '--filter', `name=${PREFIX}`)).toBe('');
  }, 60_000);

  it('passes its startup check against this image and starts empty', async () => {
    expect(await (await fetch(`${login.url}/health`)).json()).toEqual({ ok: true, state: 'ready' });
    // The Compose healthcheck, which must ignore the proxy variables.
    await docker('exec', login.name, PYTHON, SCRIPT, '--health');
    expect(await status()).toMatchObject({
      state: 'not_connected',
      source: 'volume',
      portalUrl: 'http://portal:8700',
      login: null,
    });
    expect((await loginCall('GET')).state).toBe('not_connected');
  });

  it('connects once the user approves, and writes the login where nous-proxy reads it', async () => {
    await scenario({ scenario: 'approve' });
    const started = await loginCall('POST');
    expect(started).toMatchObject({ state: 'waiting_for_approval', error: null });
    expect(started.userCode).toMatch(/^FAKE-\d{4}$/);
    expect(started.verifyUrl).toBe(`http://portal:8700/device?user_code=${started.userCode}`);
    expect(Date.parse(started.expiresAt!) - Date.now()).toBeGreaterThan(590_000);
    await until('connected');
    expect(await status()).toMatchObject({
      state: 'connected',
      scope: 'inference:invoke',
      login: null,
    });
    const files = await docker(
      'exec',
      login.name,
      'sh',
      '-c',
      'stat -c "%a %n" /opt/data/auth.json /opt/data/shared/nous_auth.json',
    );
    expect(files.split('\n')).toEqual([
      '600 /opt/data/auth.json',
      '600 /opt/data/shared/nous_auth.json',
    ]);
    const logs = await run('docker', ['logs', login.name]).then((r) => r.stdout + r.stderr);
    for (const marker of SECRET_MARKERS) expect(logs).not.toContain(marker);
    expect(await childProcesses()).toEqual([]);
  });

  it('disconnects as hermes logout does', async () => {
    expect((await loginCall('POST', '/logout')).state).toBe('not_connected');
    expect((await status()).state).toBe('not_connected');
    const left = await docker(
      'exec',
      login.name,
      'sh',
      '-c',
      'ls /opt/data/shared; cat /opt/data/auth.json',
    );
    expect(left).not.toContain('nous_auth.json');
    expect(JSON.parse(left.slice(left.indexOf('{')))).toMatchObject({
      providers: {},
      active_provider: null,
    });
  });

  it('reports a declined login', async () => {
    await scenario({ scenario: 'deny' });
    expect((await loginCall('POST')).state).toBe('waiting_for_approval');
    expect(await until('denied')).toMatchObject({ userCode: null, error: null });
    expect(await status()).toMatchObject({ state: 'not_connected', login: { state: 'denied' } });
  });

  it('reports a code that ran out', async () => {
    await scenario({ scenario: 'expire', expiresIn: 2 });
    const started = await loginCall('POST');
    expect(Date.parse(started.expiresAt!) - Date.now()).toBeLessThan(3_000);
    await until('expired');
  });

  it('reports a missing subscription with the billing page, and saves nothing', async () => {
    await scenario({ scenario: 'subscription_required' });
    await loginCall('POST');
    expect(await until('needs_subscription')).toMatchObject({
      billingUrl: 'http://portal:8700/billing',
    });
    expect((await status()).state).toBe('not_connected');
    // Hermes found the token unusable, refreshed it, and the portal refused.
    expect((await portalRequests()).some((r) => r.grantType === 'refresh_token')).toBe(true);
  });

  it('cancels a pending login and stops polling the portal', async () => {
    await scenario({ scenario: 'slow', approveAfterS: 60 });
    const started = await loginCall('POST');
    expect(started.state).toBe('waiting_for_approval');
    expect((await loginCall('DELETE')).state).toBe('not_connected');
    expect(await status()).toMatchObject({ state: 'not_connected', login: null });
    expect(await childProcesses()).toEqual([]);
    const polls = await pollsFor(started);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(await pollsFor(started)).toBe(polls);
  });

  it('lets a second Connect replace the first, which then stops', async () => {
    await scenario({ scenario: 'slow', approveAfterS: 4 });
    const first = await loginCall('POST');
    const second = await loginCall('POST');
    expect(second.userCode).not.toBe(first.userCode);
    expect((await childProcesses()).length).toBe(1);
    const before = await pollsFor(first);
    await until('connected');
    expect(await pollsFor(first)).toBe(before);
    expect((await status()).state).toBe('connected');
    await loginCall('POST', '/logout');
  });

  it('reports a portal it cannot reach as failed, with the reason', async () => {
    const lost = await container('lost', 8650, {
      env: { ...LOGIN_ENV, HERMES_PORTAL_BASE_URL: 'http://portal:1' },
      command: [SCRIPT],
      copy: [[join(staging, 'nous-login'), '/opt/']],
    });
    const res = await fetch(`${lost.url}/login`, { method: 'POST' });
    const failed = NousLoginSchema.parse(await res.json());
    expect(failed).toMatchObject({ state: 'failed', userCode: null });
    expect(failed.error).toMatch(/^Could not reach Nous Portal: /);
    const s = NousLoginStatusSchema.parse(await (await fetch(`${lost.url}/status`)).json());
    expect(s).toMatchObject({ state: 'not_connected', login: { state: 'failed' } });
  }, 60_000);

  it('reports unavailable when a Hermes function it calls changed or is missing', async () => {
    const changed = await patchedLogin(
      'changed',
      'a._nous_device_code_login = lambda *, open_browser=True, on_verification=None, timeout_seconds=15.0, device_label: None',
    );
    const missing = await patchedLogin('missing', 'del a.get_nous_auth_status_local');
    for (const [service, reason] of [
      [changed, 'hermes_cli.auth._nous_device_code_login now requires device_label'],
      [missing, 'hermes_cli.auth.get_nous_auth_status_local is missing'],
    ] as const) {
      expect(await (await fetch(`${service.url}/health`)).json()).toEqual({
        ok: true,
        state: 'unavailable',
      });
      const s = NousLoginStatusSchema.parse(await (await fetch(`${service.url}/status`)).json());
      expect(s).toMatchObject({ state: 'unavailable', reason });
      const start = await fetch(`${service.url}/login`, { method: 'POST' });
      expect(start.status).toBe(503);
      expect(await start.json()).toEqual({ state: 'unavailable', reason });
    }
  }, 60_000);
});
