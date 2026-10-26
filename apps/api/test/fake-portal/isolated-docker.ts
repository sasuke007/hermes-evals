/**
 * Docker helpers for the nous-login spec (./nous-login.docker.spec.ts):
 * the CLI, HTTP requests made from inside a container to its own service
 * (the test network is internal and nothing is published, so the host
 * cannot reach it), and the isolation checks it runs on every container
 * before any login starts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';

const run = promisify(execFile);
/** The trial image's Python, which runs nous-login, the fake portal and the client below. */
export const PYTHON = '/opt/hermes/.venv/bin/python';

/** `docker <args>`, with this process's environment (DOCKER_CONTEXT included); its stdout. */
export const docker = async (...args: string[]): Promise<string> =>
  (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

export interface Started {
  name: string;
  /** Where the service listens, as its own container reaches it. */
  port: number;
}

export interface Answer {
  status: number;
  text: string;
}

/**
 * One HTTP request made inside `target`'s container to its own service, with
 * proxies off (the login container's HTTP_PROXY points nowhere): the network
 * is internal and nothing is published, so the host cannot reach it.
 */
const CLIENT = [
  'import json, sys, urllib.error, urllib.request',
  'method, url = sys.argv[1], sys.argv[2]',
  'body = sys.argv[3].encode() if len(sys.argv) > 3 else None',
  'opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))',
  'request = urllib.request.Request(url, data=body, method=method)',
  'try:',
  '    with opener.open(request, timeout=20) as r: status, text = r.status, r.read().decode()',
  'except urllib.error.HTTPError as e: status, text = e.code, e.read().decode()',
  'sys.stdout.write(json.dumps({"status": status, "text": text}))',
].join('\n');

export async function fetchIn(
  target: Started,
  method: string,
  path: string,
  body?: string,
): Promise<Answer> {
  const url = `http://127.0.0.1:${target.port}${path}`;
  const out = await docker(
    'exec',
    target.name,
    PYTHON,
    '-c',
    CLIENT,
    method,
    url,
    ...(body === undefined ? [] : [body]),
  );
  return JSON.parse(out) as Answer;
}

export const json = (answer: Answer): unknown => JSON.parse(answer.text);

/**
 * Before it starts: on the internal test network alone, no published port,
 * and no volume but the anonymous ones the image may declare (none is
 * declared today; each would go with `docker rm -v`): never a bind mount
 * and never a named volume, so never the nous-home volume.
 */
export async function expectIsolated(name: string, network: string): Promise<void> {
  const inspect = JSON.parse(await docker('inspect', name)) as Array<{
    Mounts: Array<{ Type: string; Name?: string; Source?: string }>;
    HostConfig: { PortBindings: Record<string, unknown> | null };
    NetworkSettings: { Networks: Record<string, unknown> };
  }>;
  const [c] = inspect;
  for (const mount of c!.Mounts) {
    expect(mount.Type, `${name} mount ${JSON.stringify(mount)}`).toBe('volume');
    expect(mount.Name ?? '', `${name} mount ${JSON.stringify(mount)}`).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(JSON.stringify(c!.Mounts)).not.toContain('nous-home');
  expect(Object.keys(c!.HostConfig.PortBindings ?? {}), `${name} ports`).toEqual([]);
  expect(Object.keys(c!.NetworkSettings.Networks), `${name} networks`).toEqual([network]);
}

/** Once it runs: no default route, IPv4 or IPv6, so only the test network is reachable. */
export async function expectNoRoute(name: string): Promise<void> {
  const routes = await docker(
    'exec',
    name,
    'sh',
    '-c',
    'cat /proc/net/route; cat /proc/net/ipv6_route 2>/dev/null || true',
  );
  const defaults = routes.split('\n').filter((line) => {
    const fields = line.trim().split(/\s+/);
    // IPv4 (Iface Destination ...): destination 0.0.0.0. IPv6 (dest plen src slen next metric
    // refcnt use flags iface): ::/0, unless it is the kernel's unreachable route (RTF_REJECT).
    if (fields[1] === '00000000') return true;
    const reject = (Number.parseInt(fields[8] ?? '0', 16) & 0x200) !== 0;
    return fields[0] === '0'.repeat(32) && fields[1] === '00' && !reject;
  });
  expect(defaults, `${name} default routes`).toEqual([]);
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
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
