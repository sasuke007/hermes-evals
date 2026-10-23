/**
 * Where page data comes from.
 *
 * Most API endpoints do not exist yet, so every data-layer function serves
 * fixtures by default and switches to the planned endpoint (plan section 11)
 * when the app is built with VITE_API_MODE=live. Components never call fetch
 * or these helpers directly: they call the functions in src/api/<domain>.ts.
 *
 * Scenarios: add ?scenario=<name> to any URL to see a designed state
 * (src/fixtures/scenarios.ts lists them). The choice is remembered for the
 * browser tab in sessionStorage; ?scenario=clear forgets it. Two scenarios
 * apply to every fixture-backed call: `loading` never resolves and `error`
 * rejects with an ApiError like the one a stopped `api` service produces.
 */
import { ApiError } from './client';

export type ApiMode = 'fixtures' | 'live';

/** VITE_API_MODE=live calls the real API; anything else (or unset) serves fixtures. */
export const apiMode: ApiMode = import.meta.env.VITE_API_MODE === 'live' ? 'live' : 'fixtures';

export const SCENARIO_STORAGE_KEY = 'hermes-evals.scenario';
const SCENARIO_PARAM = 'scenario';

function readStored(): string | null {
  try {
    return sessionStorage.getItem(SCENARIO_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(SCENARIO_STORAGE_KEY);
    else sessionStorage.setItem(SCENARIO_STORAGE_KEY, value);
  } catch {
    /* storage unavailable: the scenario lasts only while it is in the URL */
  }
}

/**
 * The active fixture scenario: ?scenario=… from the current URL, else the one
 * remembered for this tab, else null. `?scenario=clear` forgets it.
 */
export function scenario(): string | null {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const fromUrl = new URLSearchParams(search).get(SCENARIO_PARAM);
  if (fromUrl !== null) {
    const value = fromUrl.trim();
    if (value === '' || value === 'clear') {
      writeStored(null);
      return null;
    }
    writeStored(value);
    return value;
  }
  return readStored();
}

/** True when `name` is the active scenario. A comma-separated value activates several. */
export function hasScenario(name: string): boolean {
  const active = scenario();
  if (active === null) return false;
  return active.split(',').some((s) => s.trim() === name);
}

/** Simulated latency for fixtures: short in the browser, none under Vitest. */
export const FIXTURE_LATENCY_MS = import.meta.env.MODE === 'test' ? 0 : 180;

export interface FixtureOptions {
  /**
   * The request this fixture stands in for, as the error message names it,
   * for example `GET /api/experiments`. Used by the `error` scenario.
   */
  request?: string;
  /** Overrides FIXTURE_LATENCY_MS, for example a slower reload or test start. */
  latencyMs?: number;
  /** Status and detail for the `error` scenario. Default: 502, the api service is down. */
  error?: { status: number; detail: string };
}

/** What the `error` scenario rejects with when a call names no error of its own. */
export const DEFAULT_FIXTURE_ERROR = {
  status: 502,
  detail: 'upstream api:8080 connection refused',
} as const;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Fixtures are plain JSON; a deep copy keeps callers from editing the shared sample data. */
function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Serve a fixture as if it came from the API: after a short delay, as a deep
 * copy. The `loading` scenario never resolves; the `error` scenario rejects
 * with an ApiError whose message reads like the real one, e.g.
 * `GET /api/experiments → 502 · upstream api:8080 connection refused`.
 */
export async function fixture<T>(value: T | (() => T), options: FixtureOptions = {}): Promise<T> {
  if (hasScenario('loading')) return new Promise<T>(() => {});
  await sleep(options.latencyMs ?? FIXTURE_LATENCY_MS);
  if (hasScenario('error')) {
    const { status, detail } = options.error ?? DEFAULT_FIXTURE_ERROR;
    throw new ApiError(status, options.request ?? 'GET /api', detail);
  }
  const resolved = typeof value === 'function' ? (value as () => T)() : value;
  return cloneJson(resolved);
}

/**
 * Reject like the API would, for fixture actions whose designed outcome is a
 * refusal (for example a 409 on launch). Honours `loading` like fixture().
 */
export async function fixtureFailure(
  request: string,
  status: number,
  detail: string,
  latencyMs?: number,
): Promise<never> {
  if (hasScenario('loading')) return new Promise<never>(() => {});
  await sleep(latencyMs ?? FIXTURE_LATENCY_MS);
  throw new ApiError(status, request, detail);
}
