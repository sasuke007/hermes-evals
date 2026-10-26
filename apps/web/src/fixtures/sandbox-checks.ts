/**
 * The sandbox isolation checks of the System fixtures (system.ts), as the System board draws
 * them, and the failures its scenarios show.
 */
import type { SandboxCheck } from '@/api/types/system';

/**
 * The isolation checks the worker runs at start-up, in their fixed order (System board): the
 * trial container's 15, then (Phase 7, Phase 5b question 3) one verifier container started
 * through docker-guard, the shape every verifier script runs in.
 */
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
  [
    'verifier-container',
    'a verifier container starts through docker-guard',
    'no network, uid 10000, inputs read-only · 0.6 s',
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

/** sandbox-verifier-refused: the guard refuses the verifier container's spec. */
export const VERIFIER_REFUSAL: Record<string, string> = {
  'verifier-container':
    'could not start: docker-guard refused the container (403): bind mount outside the trials volume',
};
