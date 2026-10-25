/**
 * Fixtures for model access, the sandbox and workers, as a small in-memory "server".
 *
 * The world is built lazily from the active scenario (src/api/source.ts) the first time a
 * data-layer function reads it, and changes as the UI drives it: starting a login issues the
 * code K7QD-P2MX valid for 15 minutes; the login then stays waiting until the dev-only control
 * in ConnectDialog (simulateNousLoginFixture) or a nous-login-* scenario resolves it, or the code
 * runs out. Every time comes from Date.now(), so the flow runs under Vitest fake timers.
 *
 * Scenarios (combine with commas, e.g. ?scenario=nous-not-connected,sandbox-failed):
 *   nous-connected (default) · nous-not-connected · nous-waiting · nous-renewal · nous-expired ·
 *   nous-declined · nous-subscription · nous-failed · nous-host · nous-host-down
 *   nous-login-approve · nous-login-decline · nous-login-expire · nous-login-subscription ·
 *   nous-login-fail: a login started from the UI resolves by itself after 6 s (expire: the code
 *   is issued with 10 s left and runs out)
 *   openrouter-missing (default) · openrouter-configured
 *   sandbox-failed (2 of 15 checks fail) · no-worker · nothing-running
 */
import { hasScenario } from '@/api/source';
import type {
  KeyProviderStatus,
  NousLogin,
  NousStatus,
  ProviderInfo,
  SandboxCheck,
  SandboxStatus,
  SystemSummary,
  Worker,
} from '@/api/types/system';

export const SYSTEM_SCENARIOS = [
  'nous-connected',
  'nous-not-connected',
  'nous-waiting',
  'nous-renewal',
  'nous-expired',
  'nous-declined',
  'nous-subscription',
  'nous-failed',
  'nous-host',
  'nous-host-down',
  'nous-login-approve',
  'nous-login-decline',
  'nous-login-expire',
  'nous-login-subscription',
  'nous-login-fail',
  'openrouter-missing',
  'openrouter-configured',
  'sandbox-failed',
  'no-worker',
  'nothing-running',
] as const;
export type SystemScenario = (typeof SYSTEM_SCENARIOS)[number];

export const NOUS_USER_CODE = 'K7QD-P2MX';
export const NOUS_VERIFY_URL = `https://portal.nousresearch.com/device?user_code=${NOUS_USER_CODE}`;
export const NOUS_BILLING_URL = 'https://portal.nousresearch.com/billing';
export const NOUS_FAILED_MESSAGE = 'Could not reach Nous Portal: connection timed out.';
export const NOUS_HOST_COMMAND = 'hermes proxy start --provider nous';
export const OPENROUTER_APPLY_COMMAND = 'docker compose up -d egress worker';
export const SELFTEST_COMMAND = 'docker compose exec worker node dist/sandbox-cli.js selftest';
/** A device code is valid for 15 minutes. */
export const LOGIN_TTL_MS = 15 * 60_000;
/** nous-login-* scenarios resolve a started login after this long. */
export const AUTO_OUTCOME_AFTER_MS = 6_000;
/** The configurations of the invoices-v1 sample, all on Nous Portal. */
export const CONFIGURATIONS_USING_NOUS = ['baseline', 'with-skill', 'with-mcp'];

/** How a waiting login can end (the dev control and the nous-login-* scenarios). */
export const LOGIN_OUTCOMES = ['approve', 'decline', 'expire', 'subscription', 'fail'] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];

/**
 * Running experiments for the AppShell pill: "2 running · 127 / 300 scored". The ids match
 * EXPERIMENT_IDS.mcpVsBaseline and .skillMcp in src/fixtures/experiments.ts (copied, not
 * imported, to keep this module free of the experiment fixtures).
 */
export const RUNNING_EXPERIMENTS = [
  { id: 'exp_01JBFMCPVB', name: 'MCP vs baseline, invoices-v1', scored: 87, total: 120 },
  { id: 'exp_01JBFSKMCP', name: 'Skill + MCP, invoices-v1', scored: 40, total: 180 },
];

/** The 15 isolation checks the worker runs at start-up, in their fixed order (System board). */
const CHECK_ROWS: [id: string, name: string, detail: string][] = [
  [
    'unprivileged-user',
    'runs as an unprivileged user (uid 10000)',
    'id -u → 10000 · no capabilities',
  ],
  ['read-only-image', 'image is read-only', 'touch /usr/local/bin/x → read-only file system'],
  [
    'own-mounts-only',
    'sees only its own home and workspace',
    'mounts: /opt/data, /workspace, /tmp (tmpfs)',
  ],
  [
    'no-other-runs',
    'cannot list other runs',
    'ls /var/lib/hermes-evals/trials → no such file or directory',
  ],
  ['no-default-route', 'has no default route', 'ip route → no default route'],
  [
    'gateway-dns-only',
    'resolves only the sandbox gateway',
    'egress → 172.30.0.2 · example.com → NXDOMAIN',
  ],
  [
    'gateway-only',
    'reaches nothing but the sandbox gateway (21 targets checked)',
    '21 of 21 refused · egress:8080 open',
  ],
  ['no-internet-dns', 'cannot send DNS to the internet', 'udp 1.1.1.1:53 → timed out'],
  [
    'refuses-private',
    'refuses private and unlisted destinations (13 refused)',
    '13 of 13 → 403 from egress',
  ],
  [
    'refuses-private-web',
    'refuses private addresses even when web access is on (12 refused)',
    '12 of 12 → 403 from egress',
  ],
  [
    'gateway-survives-malformed',
    'a malformed request cannot take the gateway down',
    '500 malformed requests → 400 · gateway healthy',
  ],
  ['run-token', "requires the run's own token", "no token → 401 · another run's token → 401"],
  ['logs-refusals', 'logs every refusal', '25 refusals logged · 25 expected'],
  [
    'docker-refuses-escapes',
    'the Docker API refuses escapes (privileged, host files, host network, other images)',
    '4 of 4 → 403 from the Docker proxy',
  ],
  [
    'docker-trial-only',
    'the Docker API shows only trial containers',
    'containers listed: 1 (this trial)',
  ],
];
export const SANDBOX_CHECKS: SandboxCheck[] = CHECK_ROWS.map(([id, name, detail]) => ({
  id,
  name,
  passed: true,
  detail,
}));

/** sandbox-failed: checks 07 and 10 fail with these details. */
export const SANDBOX_FAILURES: Record<string, string> = {
  'gateway-only': 'reaches nothing but the sandbox gateway: 192.168.5.2:22 open',
  'refuses-private-web':
    'refuses private addresses even when web access is on: 10.0.4.7:5432 reachable',
};

interface World {
  nousStatus: NousStatus;
  /** Where a cancelled login returns to. */
  statusBeforeLogin: NousStatus;
  login: NousLogin | null;
  loginStartedAt: number | null;
  pendingOutcome: LoginOutcome | null;
  autoOutcome: LoginOutcome | null;
  openRouter: KeyProviderStatus;
  pausedExperiments: number;
  sandboxFailed: boolean;
  noWorker: boolean;
  nothingRunning: boolean;
}

let world: World | null = null;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function waitingLogin(expiresAt: number): NousLogin {
  return {
    state: 'waiting_for_approval',
    userCode: NOUS_USER_CODE,
    verifyUrl: NOUS_VERIFY_URL,
    expiresAt: iso(expiresAt),
    error: null,
    billingUrl: null,
  };
}

function endedLogin(state: NousLogin['state'], error: string | null = null): NousLogin {
  return {
    state,
    userCode: null,
    verifyUrl: null,
    expiresAt: null,
    error,
    billingUrl: state === 'needs_subscription' ? NOUS_BILLING_URL : null,
  };
}

function initialNousStatus(): NousStatus {
  if (hasScenario('nous-not-connected')) return 'not_connected';
  if (hasScenario('nous-waiting')) return 'waiting_for_approval';
  if (hasScenario('nous-renewal')) return 'relogin_required';
  if (hasScenario('nous-expired')) return 'expired';
  if (hasScenario('nous-declined')) return 'denied';
  if (hasScenario('nous-subscription')) return 'needs_subscription';
  if (hasScenario('nous-failed')) return 'failed';
  if (hasScenario('nous-host')) return 'host';
  if (hasScenario('nous-host-down')) return 'host_unreachable';
  return 'connected';
}

function initialAutoOutcome(): LoginOutcome | null {
  for (const outcome of LOGIN_OUTCOMES) {
    if (hasScenario(`nous-login-${outcome}`)) return outcome;
  }
  return null;
}

function initWorld(): World {
  const now = Date.now();
  const nousStatus = initialNousStatus();
  let login: NousLogin | null = null;
  // "Code K7QD-P2MX · 14:52 left", as drawn.
  if (nousStatus === 'waiting_for_approval') login = waitingLogin(now + (14 * 60 + 52) * 1000);
  if (nousStatus === 'expired') login = endedLogin('expired');
  if (nousStatus === 'denied') login = endedLogin('denied');
  if (nousStatus === 'needs_subscription') login = endedLogin('needs_subscription');
  if (nousStatus === 'failed') login = endedLogin('failed', NOUS_FAILED_MESSAGE);
  return {
    nousStatus,
    statusBeforeLogin: 'not_connected',
    login,
    loginStartedAt: login?.state === 'waiting_for_approval' ? now : null,
    pendingOutcome: null,
    autoOutcome: initialAutoOutcome(),
    openRouter: hasScenario('openrouter-configured') ? 'configured' : 'missing',
    pausedExperiments: nousStatus === 'relogin_required' ? 1 : 0,
    sandboxFailed: hasScenario('sandbox-failed'),
    noWorker: hasScenario('no-worker'),
    nothingRunning: hasScenario('nothing-running'),
  };
}

function w(): World {
  world ??= initWorld();
  return world;
}

/** Forget the fixture world; the next read rebuilds it from the active scenario. For tests. */
export function resetSystemFixtures(): void {
  world = null;
}

function applyOutcome(state: World, outcome: LoginOutcome): void {
  switch (outcome) {
    case 'approve':
      state.nousStatus = 'connected';
      state.login = endedLogin('connected');
      state.pausedExperiments = 0;
      break;
    case 'decline':
      state.nousStatus = 'denied';
      state.login = endedLogin('denied');
      break;
    case 'expire':
      state.nousStatus = 'expired';
      state.login = endedLogin('expired');
      break;
    case 'subscription':
      state.nousStatus = 'needs_subscription';
      state.login = endedLogin('needs_subscription');
      break;
    case 'fail':
      state.nousStatus = 'failed';
      state.login = endedLogin('failed', NOUS_FAILED_MESSAGE);
      break;
  }
  state.pendingOutcome = null;
  state.loginStartedAt = null;
}

/** Moves a waiting login on: the dev control, a nous-login-* scenario, or the code running out. */
function advance(state: World): void {
  const login = state.login;
  if (!login || login.state !== 'waiting_for_approval') return;
  const now = Date.now();
  if (state.pendingOutcome) {
    applyOutcome(state, state.pendingOutcome);
    return;
  }
  if (
    state.autoOutcome &&
    state.autoOutcome !== 'expire' &&
    state.loginStartedAt !== null &&
    now - state.loginStartedAt >= AUTO_OUTCOME_AFTER_MS
  ) {
    applyOutcome(state, state.autoOutcome);
    return;
  }
  if (login.expiresAt && now >= Date.parse(login.expiresAt)) applyOutcome(state, 'expire');
}

// ── providers ────────────────────────────────────────────────────────────

export function providersFixture(): ProviderInfo[] {
  const state = w();
  advance(state);
  const nousConnected = state.nousStatus === 'connected' || state.nousStatus === 'host';
  return [
    {
      id: 'nous',
      name: 'Nous Portal',
      authMethod: 'oauth-device',
      status: state.nousStatus,
      scope: nousConnected ? 'inference' : null,
      envVar: null,
      applyCommand: null,
      hostCommand: NOUS_HOST_COMMAND,
      billingUrl: NOUS_BILLING_URL,
      usedBy: [...CONFIGURATIONS_USING_NOUS],
      pausedExperiments: state.pausedExperiments,
      login: state.login ? { ...state.login } : null,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      authMethod: 'env-key',
      status: state.openRouter,
      scope: null,
      envVar: 'OPENROUTER_API_KEY',
      applyCommand: OPENROUTER_APPLY_COMMAND,
      hostCommand: null,
      billingUrl: null,
      usedBy: [],
      pausedExperiments: 0,
      login: null,
    },
  ];
}

/** GET /providers/nous/login */
export function nousLoginFixture(): NousLogin {
  const state = w();
  advance(state);
  return state.login ? { ...state.login } : endedLogin('not_connected');
}

/** POST /providers/nous/login: a new code; a second Connect replaces a pending one. */
export function startNousLoginFixture(): NousLogin {
  const state = w();
  const current = state.nousStatus;
  if (current !== 'waiting_for_approval') {
    state.statusBeforeLogin =
      current === 'connected' || current === 'relogin_required' ? current : 'not_connected';
  }
  const now = Date.now();
  const ttl = state.autoOutcome === 'expire' ? 10_000 : LOGIN_TTL_MS;
  state.login = waitingLogin(now + ttl);
  state.loginStartedAt = now;
  state.pendingOutcome = null;
  state.nousStatus = 'waiting_for_approval';
  return { ...state.login };
}

/** DELETE /providers/nous/login */
export function cancelNousLoginFixture(): void {
  const state = w();
  if (state.login?.state === 'waiting_for_approval') {
    state.nousStatus = state.statusBeforeLogin;
  }
  state.login = null;
  state.loginStartedAt = null;
  state.pendingOutcome = null;
}

/** POST /providers/nous/logout */
export function logoutNousFixture(): void {
  const state = w();
  state.nousStatus = 'not_connected';
  state.login = null;
  state.loginStartedAt = null;
  state.pendingOutcome = null;
}

/** Dev-only: decide how the waiting login ends; the next poll picks it up. */
export function simulateNousLoginFixture(outcome: LoginOutcome): void {
  const state = w();
  if (state.login?.state === 'waiting_for_approval') state.pendingOutcome = outcome;
}

// ── sandbox, workers, running summary ────────────────────────────────────

export function sandboxFixture(): SandboxStatus {
  const state = w();
  const checks = SANDBOX_CHECKS.map((check) => {
    const failure = state.sandboxFailed ? SANDBOX_FAILURES[check.id] : undefined;
    return failure ? { ...check, passed: false, detail: failure } : { ...check };
  });
  return {
    proven: checks.every((c) => c.passed),
    checks,
    checkedAt: iso(Date.now() - 2 * 60_000),
    trigger: 'worker start',
    revision: 'hermes-agent v0.22.4 @ 4d04303',
    image: 'nousresearch/hermes-agent:v0.22.4',
    digest: 'sha256:7a6920…',
    selftestCommand: SELFTEST_COMMAND,
  };
}

export function workersFixture(): Worker[] {
  const state = w();
  const now = Date.now();
  return [
    {
      id: 'worker-1',
      status: state.noWorker ? 'offline' : 'online',
      lastHeartbeatAt: iso(state.noWorker ? now - 2 * 60_000 : now - 3_000),
      concurrency: 3,
      // trialConcurrency(3, 4 slots): the concurrency, under the slot count.
      effectiveConcurrency: 3,
      slotsInUse: state.noWorker ? null : 2,
      slotsTotal: state.noWorker ? null : 4,
      sandboxProven: !state.sandboxFailed,
    },
  ];
}

export function systemSummaryFixture(): SystemSummary {
  const state = w();
  let experiments = RUNNING_EXPERIMENTS.map((e) => ({ ...e }));
  if (state.nothingRunning) experiments = [];
  else if (state.noWorker) experiments = experiments.slice(0, 1);
  return {
    running: {
      count: experiments.length,
      scored: experiments.reduce((sum, e) => sum + e.scored, 0),
      total: experiments.reduce((sum, e) => sum + e.total, 0),
      experiments,
    },
    workers: workersFixture(),
    queuedRuns: state.noWorker ? 28 : 0,
  };
}
