/**
 * Proves isolation on the machine it runs on. Starts a probe container with
 * exactly the trial shape (through docker-guard, on a slot network, with an
 * egress registration) and runs a Python probe inside it that tries what an
 * escaping agent would: look at its mounts, write to the image, find a route
 * out, resolve platform names, open sockets to Postgres, the API, the host and
 * the internet, and ask egress for private destinations. Then it starts one
 * verifier container through docker-guard (self-test-verifier.ts), the shape
 * every verifier script runs in. The worker refuses to run experiments
 * unless every check passes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { newId } from '../database/ids.js';
import type { EgressClient, EgressLogEntry } from './egress-client.js';
import { newAttemptToken } from './egress-client.js';
import type { VerifierRunner } from '../scoring/verifier-runner.js';
import { EngineError, type EngineClient } from './engine-client.js';
import { checkVerifierContainer } from './self-test-verifier.js';
import { clearRun, prepareTrialDirs, removeTrialDirs, runTrial } from './trial-runner.js';
import { trialContainerBody } from './trial-spec.js';

export interface SelfTestDeps {
  engine: EngineClient;
  egress: EgressClient;
  trialsDir: string;
  image: string;
  volume: string;
  slot: string;
  /** Runs the verifier check's container; the worker's container runner, built from the above, by default. */
  verifier?: VerifierRunner;
}

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  ok: boolean;
  checks: SelfTestCheck[];
  probe: unknown;
  egressLog: EgressLogEntry[];
}

const PROBE = String.raw`
import base64, json, os, socket

out = {"uid": os.getuid(), "gid": os.getgid()}
out["mounts"] = [line.split()[4] for line in open("/proc/self/mountinfo").read().splitlines()]
try:
    open("/usr/local/probe-write", "w").write("x")
    out["image_writable"] = True
except OSError:
    out["image_writable"] = False
out["opt"] = sorted(os.listdir("/opt"))
out["home_parent_listing"] = sorted(os.listdir("/opt/data/.."))
routes = [l.split() for l in open("/proc/net/route").read().splitlines()[1:]]
out["default_route"] = any(r[1] == "00000000" for r in routes if len(r) > 1)

out["dns"] = {}
for name in json.loads(os.environ["PROBE_NAMES"]):
    try:
        out["dns"][name] = socket.gethostbyname(name)
    except OSError as e:
        out["dns"][name] = None

out["tcp"] = {}
for host, port in json.loads(os.environ["PROBE_TARGETS"]):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect((host, port))
        out["tcp"]["%s:%d" % (host, port)] = "open"
    except OSError as e:
        out["tcp"]["%s:%d" % (host, port)] = type(e).__name__
    finally:
        s.close()

udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.settimeout(2)
try:
    udp.sendto(b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01", ("8.8.8.8", 53))
    udp.recvfrom(512)
    out["udp_dns_8888"] = "answered"
except OSError as e:
    out["udp_dns_8888"] = type(e).__name__

def via_proxy(authority, auth):
    try:
        s = socket.create_connection(("egress", 3128), timeout=5)
    except OSError as e:
        return "unreachable: " + type(e).__name__
    head = "CONNECT %s HTTP/1.1\r\nHost: %s\r\n" % (authority, authority)
    if auth:
        head += "Proxy-Authorization: Basic %s\r\n" % base64.b64encode(auth.encode()).decode()
    s.sendall((head + "\r\n").encode())
    data = b""
    while b"\r\n\r\n" not in data and len(data) < 4096:
        chunk = s.recv(1024)
        if not chunk:
            break
        data += chunk
    s.close()
    lines = data.decode(errors="replace").split("\r\n")
    reason = [l.split(":", 1)[1].strip() for l in lines[1:] if l.lower().startswith("x-egress-reason:")]
    return lines[0] + (" [%s]" % reason[0] if reason else "")

auth = os.environ["PROBE_ATTEMPT"] + ":" + os.environ["PROBE_TOKEN"]
out["proxy"] = {a: via_proxy(a, auth) for a in json.loads(os.environ["PROBE_PROXY_TARGETS"])}
public_auth = os.environ["PROBE_PUBLIC_ATTEMPT"] + ":" + os.environ["PROBE_PUBLIC_TOKEN"]
out["proxy_public"] = {a: via_proxy(a, public_auth) for a in json.loads(os.environ["PROBE_PUBLIC_TARGETS"])}
def raw_http(port, request):
    try:
        s = socket.create_connection(("egress", port), timeout=5)
        s.sendall(request.encode())
        line = s.recv(256).split(b"\r\n")[0].decode(errors="replace")
        s.close()
        return line
    except OSError as e:
        return "error: " + type(e).__name__

# A request target Node's parser accepts but the URL parser rejects once crashed egress.
out["gateway_malformed"] = raw_http(8080, "GET http://[/x HTTP/1.1\r\nHost: x\r\n\r\n")
out["gateway_after"] = raw_http(8080, "GET /health HTTP/1.1\r\nHost: egress\r\nConnection: close\r\n\r\n")
out["proxy_without_credentials"] = via_proxy("example.com:443", None)
out["proxy_wrong_token"] = via_proxy("example.com:443", os.environ["PROBE_ATTEMPT"] + ":" + "x" * 43)
print("PROBE_RESULT " + json.dumps(out))
`;

/** Mount points a trial may have; anything else visible is a leak. */
const FORBIDDEN_MOUNT_PREFIXES = [
  '/data',
  '/trials',
  '/run',
  '/var/run',
  '/suites',
  '/repo',
  '/app',
  '/Users',
  '/home',
  '/root',
  '/host',
];

const FIXED_TARGETS: Array<[string, number]> = [
  ['172.17.0.1', 22],
  ['172.17.0.1', 2375],
  ['192.168.5.1', 22],
  ['192.168.5.2', 22],
  // The host's Nous proxy, when the host-nous profile is used.
  ['192.168.5.2', 8645],
  ['192.168.65.1', 22],
  ['192.168.65.254', 80],
  ['169.254.169.254', 80],
  ['1.1.1.1', 443],
  ['8.8.8.8', 53],
  ['93.184.215.14', 443],
];

const PROXY_TARGETS = [
  '127.0.0.1:443',
  // egress's own loopback, where the host-nous bridge listens, and the host proxy behind it.
  '127.0.0.1:8645',
  'host.docker.internal:8645',
  '[::1]:443',
  '[::ffff:127.0.0.1]:443',
  '10.0.0.1:443',
  '169.254.169.254:80',
  'postgres:5432',
  'api:3000',
  'host.docker.internal:443',
  'host.lima.internal:22',
  'localtest.me:443',
  'example.com:443',
];

/**
 * The same private targets, sent by a second probe attempt registered in public
 * mode (as for web and browser toolsets) with their ports allowed. There the
 * allowlist cannot refuse them first, so a 403 proves the address and name
 * checks themselves. Public hosts are left out: they would be allowed.
 */
const PUBLIC_MODE_TARGETS = PROXY_TARGETS.filter((t) => t !== 'example.com:443');
const PUBLIC_MODE_PORTS = [22, 3000, 5432, 8645];
/** Refusals that come before the address checks; a public-mode refusal must not be one of these. */
const EARLY_REFUSALS = ['host is not on the allowlist', 'port is not allowed'];

async function defaultGateway(): Promise<string | null> {
  try {
    const rows = (await readFile('/proc/net/route', 'utf8'))
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/));
    const row = rows.find((r) => r[1] === '00000000');
    if (!row?.[2]) return null;
    const hex = row[2];
    return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
  } catch {
    return null;
  }
}

async function platformTargets(): Promise<Array<[string, number]>> {
  const targets: Array<[string, number]> = [];
  for (const [name, ports] of [
    ['postgres', [5432]],
    ['api', [3000]],
    ['web', [80]],
  ] as const) {
    try {
      const { address } = await lookup(name);
      for (const port of ports) targets.push([address, port]);
    } catch {
      // service not running here
    }
  }
  const gateway = await defaultGateway();
  if (gateway) targets.push([gateway, 22], [gateway, 5432], [gateway, 3000], [gateway, 8080]);
  return targets;
}

export async function runIsolationSelfTest(deps: SelfTestDeps): Promise<SelfTestReport> {
  const attemptId = newId();
  const token = newAttemptToken();
  const dirs = await prepareTrialDirs(deps.trialsDir, attemptId);
  await writeFile(join(dirs.workspace, 'probe.py'), PROBE);
  await deps.egress.register(attemptId, {
    token,
    mode: 'allowlist',
    allowHosts: [],
    provider: null,
    expiresAt: Date.now() + 5 * 60_000,
  });
  const publicAttemptId = newId();
  const publicToken = newAttemptToken();
  await deps.egress.register(publicAttemptId, {
    token: publicToken,
    mode: 'public',
    allowHosts: [],
    allowPorts: PUBLIC_MODE_PORTS,
    provider: null,
    expiresAt: Date.now() + 5 * 60_000,
  });

  const backendTargets = await platformTargets();
  const lines: string[] = [];
  const stderr: Buffer[] = [];
  let outcome;
  try {
    outcome = await runTrial({
      engine: deps.engine,
      spec: {
        name: `hermes-evals-probe-${attemptId}`,
        runId: attemptId,
        attemptId,
        image: deps.image,
        volume: deps.volume,
        network: deps.slot,
        entrypoint: ['/usr/local/bin/python3'],
        cmd: ['/workspace/probe.py'],
        env: {
          HOME: '/opt/data',
          PROBE_ATTEMPT: attemptId,
          PROBE_TOKEN: token,
          PROBE_NAMES: JSON.stringify([
            'egress',
            'postgres',
            'api',
            'web',
            'worker',
            'docker-guard',
            'nous-proxy',
            'mock-model',
            'host.docker.internal',
            'host.lima.internal',
            'example.com',
          ]),
          PROBE_TARGETS: JSON.stringify([
            ...backendTargets,
            ...FIXED_TARGETS,
            ['egress', 3128],
            ['egress', 8080],
            // Where egress's development host forward listens, on loopback only.
            ['egress', 8645],
          ]),
          PROBE_PROXY_TARGETS: JSON.stringify(PROXY_TARGETS),
          PROBE_PUBLIC_ATTEMPT: publicAttemptId,
          PROBE_PUBLIC_TOKEN: publicToken,
          PROBE_PUBLIC_TARGETS: JSON.stringify(PUBLIC_MODE_TARGETS),
        },
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
      deadlineMs: 240_000,
      onStdoutLine: (line) => lines.push(line),
      onStderr: (chunk) => stderr.push(chunk),
    });
  } finally {
    await removeTrialDirs(deps.trialsDir, attemptId);
    await deps.egress.remove(publicAttemptId);
  }
  const egressRecord = await deps.egress.remove(attemptId);

  const resultLine = lines.find((l) => l.startsWith('PROBE_RESULT '));
  const checks: SelfTestCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  if (!resultLine) {
    check(
      'probe ran',
      false,
      `exit ${outcome.exitCode}; stderr: ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`,
    );
    return { ok: false, checks, probe: null, egressLog: egressRecord?.log ?? [] };
  }
  const probe = JSON.parse(resultLine.slice('PROBE_RESULT '.length)) as {
    uid: number;
    mounts: string[];
    image_writable: boolean;
    opt: string[];
    home_parent_listing: string[];
    default_route: boolean;
    dns: Record<string, string | null>;
    tcp: Record<string, string>;
    udp_dns_8888: string;
    proxy: Record<string, string>;
    proxy_public: Record<string, string>;
    proxy_without_credentials: string;
    proxy_wrong_token: string;
    gateway_malformed: string;
    gateway_after: string;
  };

  check('runs as uid 10000', probe.uid === 10000, `uid ${probe.uid}`);
  check(
    'image is read-only',
    !probe.image_writable,
    probe.image_writable ? 'wrote to /usr/local' : 'write refused',
  );
  const leaks = probe.mounts.filter((m) =>
    FORBIDDEN_MOUNT_PREFIXES.some((p) => m === p || m.startsWith(`${p}/`)),
  );
  check(
    'sees only its own home and workspace',
    leaks.length === 0 && probe.mounts.includes('/opt/data') && probe.mounts.includes('/workspace'),
    leaks.length ? `unexpected mounts: ${leaks.join(', ')}` : `mounts: ${probe.mounts.join(' ')}`,
  );
  check(
    'cannot list other attempts',
    !probe.home_parent_listing.some((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n)),
    `/opt/data/.. contains ${probe.home_parent_listing.join(', ')}`,
  );
  check(
    'has no default route',
    !probe.default_route,
    probe.default_route ? 'a default route exists' : 'no default route',
  );
  const resolved = Object.entries(probe.dns)
    .filter(([, ip]) => ip !== null)
    .map(([name]) => name);
  check(
    'resolves only egress',
    resolved.length === 1 && resolved[0] === 'egress',
    `resolved: ${resolved.join(', ') || 'nothing'}`,
  );
  const open = Object.entries(probe.tcp)
    .filter(([, state]) => state === 'open')
    .map(([target]) => target);
  const unexpected = open.filter((t) => !t.endsWith(':3128') && !t.endsWith(':8080'));
  check(
    'reaches nothing but egress',
    unexpected.length === 0 && open.length >= 2,
    `open: ${open.join(', ') || 'none'}; checked ${Object.keys(probe.tcp).length} targets`,
  );
  check(
    'cannot send DNS to the internet',
    probe.udp_dns_8888 !== 'answered',
    `UDP 8.8.8.8:53 ${probe.udp_dns_8888}`,
  );
  const proxyAllowed = Object.entries(probe.proxy).filter(([, line]) => !line.includes(' 403 '));
  check(
    'egress refuses every private and unlisted destination',
    proxyAllowed.length === 0,
    proxyAllowed.length
      ? `not refused: ${proxyAllowed.map(([t, l]) => `${t} -> ${l}`).join('; ')}`
      : `${Object.keys(probe.proxy).length} destinations refused with 403`,
  );
  const publicWeak = Object.entries(probe.proxy_public).filter(
    ([, line]) => !line.includes(' 403 ') || EARLY_REFUSALS.some((r) => line.includes(r)),
  );
  check(
    'egress refuses private addresses and names even in public mode',
    publicWeak.length === 0 &&
      Object.keys(probe.proxy_public).length === PUBLIC_MODE_TARGETS.length,
    publicWeak.length
      ? `not refused for the right reason: ${publicWeak.map(([t, l]) => `${t} -> ${l}`).join('; ')}`
      : `${PUBLIC_MODE_TARGETS.length} refused: ${[...new Set(Object.values(probe.proxy_public).map((l) => /\[(.*)\]/.exec(l)?.[1] ?? '?'))].join(', ')}`,
  );
  check(
    'a malformed request cannot take egress down',
    probe.gateway_malformed.includes(' 400 ') && probe.gateway_after.includes(' 200 '),
    `malformed target: ${probe.gateway_malformed}; then /health: ${probe.gateway_after}`,
  );
  check(
    'egress requires the attempt token',
    probe.proxy_without_credentials.includes(' 407 ') && probe.proxy_wrong_token.includes(' 407 '),
    `${probe.proxy_without_credentials}; ${probe.proxy_wrong_token}`,
  );
  const denials = (egressRecord?.log ?? []).filter((e) => e.decision === 'denied').length;
  check('egress logged the refusals', denials >= PROXY_TARGETS.length, `${denials} denials logged`);

  for (const guardCheck of await checkGuardRefusals(deps)) checks.push(guardCheck);
  // The 16th: a verifier container, as scoring and every load start one (Phase 5b question 3).
  checks.push(await checkVerifierContainer(deps));

  return { ok: checks.every((c) => c.ok), checks, probe, egressLog: egressRecord?.log ?? [] };
}

/**
 * The guard, live: what a compromised worker would try through the Docker API
 * must be refused, and the guard must hide every non-trial container.
 */
async function checkGuardRefusals(deps: SelfTestDeps): Promise<SelfTestCheck[]> {
  const attemptId = newId();
  const base = trialContainerBody({
    name: `hermes-evals-probe-${attemptId}`,
    runId: attemptId,
    attemptId,
    image: deps.image,
    volume: deps.volume,
    network: deps.slot,
    cmd: ['--version'],
    env: {},
    deadline: Math.floor(Date.now() / 1000) + 60,
  }) as { HostConfig: Record<string, unknown> };
  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      'privileged container',
      () =>
        deps.engine.createContainer(`hermes-evals-probe-${attemptId}`, {
          ...base,
          HostConfig: { ...base.HostConfig, Privileged: true },
        }),
    ],
    [
      'host root bind',
      () =>
        deps.engine.createContainer(`hermes-evals-probe-${attemptId}`, {
          ...base,
          HostConfig: { ...base.HostConfig, Binds: ['/:/host'] },
        }),
    ],
    [
      'host network',
      () =>
        deps.engine.createContainer(`hermes-evals-probe-${attemptId}`, {
          ...base,
          HostConfig: { ...base.HostConfig, NetworkMode: 'host' },
        }),
    ],
    [
      'another image',
      () =>
        deps.engine.createContainer(`hermes-evals-probe-${attemptId}`, {
          ...base,
          Image: 'postgres:17-alpine',
        }),
    ],
  ];
  const refused: string[] = [];
  const allowed: string[] = [];
  for (const [name, attempt] of attempts) {
    try {
      await attempt();
      allowed.push(name);
    } catch (err) {
      if (err instanceof EngineError && err.status === 403) refused.push(name);
      else allowed.push(`${name} (${(err as Error).message})`);
    }
  }
  // Leave nothing behind if a create was wrongly accepted.
  await clearRun(deps.engine, attemptId).catch(() => undefined);

  const visible = await deps.engine.list([]);
  const strangers = visible
    .filter((c) => c.Labels['hermes-evals.role'] !== 'trial')
    .map((c) => c.Names.join(','));
  return [
    {
      name: 'docker-guard refuses escapes through the Docker API',
      ok: allowed.length === 0,
      detail: allowed.length ? `accepted: ${allowed.join('; ')}` : `refused: ${refused.join(', ')}`,
    },
    {
      name: 'docker-guard shows only trial containers',
      ok: strangers.length === 0,
      detail: strangers.length
        ? `visible: ${strangers.join(', ')}`
        : `${visible.length} trial containers visible, nothing else`,
    },
  ];
}
