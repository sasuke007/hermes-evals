/**
 * vitest globalSetup: the API tests need python3, as the worker image has it.
 * Verifier self-checks run it (scoring/verifier.ts), and the loader specs
 * load suites whose verifiers are Python. Without it the verifier specs
 * would test nothing and the loader specs would fail as if a scorer were
 * broken, so the run stops at once and says why.
 */
import { spawnSync } from 'node:child_process';

export default function requirePython(): void {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(
      'python3 is required to run the API tests: verifier self-checks run it, as the worker image does',
    );
  }
}
