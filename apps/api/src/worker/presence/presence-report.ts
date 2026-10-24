/**
 * What a worker reports about itself on its `workers` row (decision D5): the
 * names in its environment and the isolation self-test it ran at start, in
 * the `workers.sandbox` shape. Pure functions, so the rules are tested
 * without a database or a sandbox.
 */
import { ENV_NAME_PATTERN } from '@hermes-evals/shared';
import type { WorkerSandbox } from '../../database/schema/worker-sandbox.js';
import type { SandboxState } from '../../sandbox/sandbox.service.js';
import type { SelfTestCheck } from '../../sandbox/self-test.js';

/**
 * Sorted names of the variables in `env` that a definition could reference
 * (ENV_NAME_PATTERN) and that hold a non-empty value. An empty value counts as
 * not set: a stdio server given `INVOICE_DB_URL=` cannot work. Never values.
 */
export function presentEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => ENV_NAME_PATTERN.test(name) && Boolean(value))
    .map(([name]) => name)
    .sort();
}

/**
 * Stable ids for the self-test's checks (sandbox/self-test.ts), in its order.
 * The names there are the plain-English claims the System page shows; the
 * ids are what the page and its tests key on, so rewording a claim does not
 * change them.
 */
export const SELF_TEST_CHECK_IDS: Readonly<Record<string, string>> = {
  'probe ran': 'probe-ran',
  'runs as uid 10000': 'unprivileged-user',
  'image is read-only': 'read-only-image',
  'sees only its own home and workspace': 'own-mounts-only',
  'cannot list other attempts': 'no-other-runs',
  'has no default route': 'no-default-route',
  'resolves only egress': 'gateway-dns-only',
  'reaches nothing but egress': 'gateway-only',
  'cannot send DNS to the internet': 'no-internet-dns',
  'egress refuses every private and unlisted destination': 'refuses-private',
  'egress refuses private addresses and names even in public mode': 'refuses-private-web',
  'a malformed request cannot take egress down': 'gateway-survives-malformed',
  'egress requires the attempt token': 'run-token',
  'egress logged the refusals': 'logs-refusals',
  'docker-guard refuses escapes through the Docker API': 'docker-refuses-escapes',
  'docker-guard shows only trial containers': 'docker-trial-only',
};

/** The check's stable id; a check this table does not know gets a slug of its name. */
export function selfTestCheckId(name: string): string {
  const known = SELF_TEST_CHECK_IDS[name];
  if (known) return known;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'check';
}

/** Why there are no checks to show, per state; the API turns it into one failed check. */
export const SANDBOX_UNAVAILABLE_ERROR =
  'docker-guard or egress is not reachable from the worker, so isolation could not be checked';
export const SELF_TEST_NOT_RUN_ERROR =
  'the isolation self-test could not run; the worker log has the error';

export interface SandboxReportInput {
  /** SandboxService.status() after verify(). */
  state: SandboxState;
  checks: SelfTestCheck[];
  /** When verify() finished. */
  checkedAt: Date;
  /** TRIAL_IMAGE as configured. */
  image: string;
  /** The image id the engine reported, `sha256:<hex>`, when it could be read. */
  imageDigest?: string;
  /** Full git sha of the Hermes revision in the image. */
  revision: string;
}

/**
 * The `workers.sandbox` value for a self-test result, or null when no
 * self-test ran (`unverified`). `unavailable` and a self-test that threw have
 * no checks; their `error` says why, never anything secret.
 */
export function workerSandboxReport(input: SandboxReportInput): WorkerSandbox | null {
  if (input.state === 'unverified') return null;
  const checks = input.state === 'unavailable' ? [] : input.checks;
  const error =
    input.state === 'unavailable'
      ? SANDBOX_UNAVAILABLE_ERROR
      : input.state === 'failed' && checks.length === 0
        ? SELF_TEST_NOT_RUN_ERROR
        : undefined;
  return {
    state: input.state,
    checks: checks.map((check) => ({
      id: selfTestCheckId(check.name),
      name: check.name,
      passed: check.ok,
      detail: check.detail,
    })),
    checked_at: input.checkedAt.toISOString(),
    image: input.image,
    revision: input.revision,
    ...(input.imageDigest ? { image_digest: input.imageDigest } : {}),
    trigger: 'worker start',
    ...(error ? { error } : {}),
  };
}
