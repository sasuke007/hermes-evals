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
 *   sandbox-failed (2 of 16 checks fail) · sandbox-verifier-refused (the 16th, the verifier
 *   container, fails: the guard refuses its spec) · no-worker · nothing-running
 */
import { LOGIN_OUTCOMES, type LoginOutcome } from '@/api/login-outcomes';
import { hasScenario } from '@/api/source';
import type {
  KeyProviderStatus,
  NousLogin,
  NousStatus,
  ProviderInfo,
  SandboxStatus,
  SystemSummary,
  Worker,
} from '@/api/types/system';
import { SANDBOX_CHECKS, SANDBOX_FAILURES, VERIFIER_REFUSAL } from './sandbox-checks';

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
  'sandbox-verifier-refused',
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
export { LOGIN_OUTCOMES, type LoginOutcome };

/**
 * Running experiments for the AppShell pill: "2 running · 127 / 300 scored". The ids match
 * EXPERIMENT_IDS.mcpVsBaseline and .skillMcp in src/fixtures/experiments.ts (copied, not
 * imported, to keep this module free of the experiment fixtures).
 */
export const RUNNING_EXPERIMENTS = [
  { id: 'exp_01JBFMCPVB', name: 'MCP vs baseline, invoices-v1', scored: 87, total: 120 },
  { id: 'exp_01JBFSKMCP', name: 'Skill + MCP, invoices-v1', scored: 40, total: 180 },
];

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
  verifierRefused: boolean;
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
    verifierRefused: hasScenario('sandbox-verifier-refused'),
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
  const failures: Record<string, string> = {
    ...(state.sandboxFailed ? SANDBOX_FAILURES : {}),
    ...(state.verifierRefused ? VERIFIER_REFUSAL : {}),
  };
  const checks = SANDBOX_CHECKS.map((check) => {
    const failure = failures[check.id];
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
