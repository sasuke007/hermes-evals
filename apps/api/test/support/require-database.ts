/**
 * vitest globalSetup for the Postgres 17 e2e suite: TEST_DATABASE_URL must
 * name the throwaway test server (docs/phases/phase-1.md 6.1). Every e2e file
 * skips itself without it, so a run with the variable missing or misspelled
 * would report every file skipped and exit 0, which reads as green. This
 * stops it at once and says why. It also refuses port 5432, the Compose
 * database's: the specs create and drop databases, and must never touch it.
 */
export default function requireDatabase(): void {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required for the Postgres 17 e2e suite (see docs/phases/phase-1.md 6.1); ' +
        'without it every file would skip and the run would read as green',
    );
  }
  let port: string;
  try {
    port = new URL(url).port || '5432';
  } catch {
    throw new Error('TEST_DATABASE_URL is not a postgres:// URL');
  }
  if (port === '5432') {
    throw new Error(
      'TEST_DATABASE_URL points at port 5432, the Compose database; use the throwaway test server (port 55433 in docs/phases/phase-1.md 6.1)',
    );
  }
}
