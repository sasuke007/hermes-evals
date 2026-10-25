/**
 * What recovery deletes from the trials volume (plan 8.5, 8.6): the home of
 * an attempt it has just finalised, and, at most every 10 minutes, the whole
 * directory of every attempt finished more than TRIAL_RETENTION_DAYS ago.
 *
 * Both run only on trees no container can still change: a finalised
 * attempt's containers were confirmed gone first, and a finished attempt's
 * long ago. Both go through forceRemoveTree, which restores the owner
 * permissions an agent can take away (it shares the worker's uid), and a
 * tree that still cannot be deleted is logged and skipped, never allowed to
 * stop the rest: one poisoned directory must not halt retention for good.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { and, inArray, lt } from 'drizzle-orm';
import { attempts } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { forceRemoveTree, removeTrialDirs } from '../../sandbox/trial-runner.js';
import type { LifecycleLogger, LifecycleSettings } from './types.js';

/** Retention scans the trials volume at most this often. */
export const RETENTION_INTERVAL_MS = 10 * 60_000;

const ATTEMPT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Rows per statement when retention works through a long list. */
const CHUNK = 500;

const codeOf = (err: unknown): string =>
  (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

/**
 * Deletes the home of an attempt recovery finalised (worker_lost or
 * cancelled), as the runner's finish does for an attempt it ends itself:
 * a handed-back or crashed attempt otherwise kept Hermes's session state,
 * unredacted, for the whole retention window. The workspace, launch.json and
 * stderr.log stay for retention. Never throws.
 */
export async function deleteLostHome(
  trialsDir: string,
  attemptId: string,
  logger: LifecycleLogger,
): Promise<boolean> {
  if (!ATTEMPT_ID.test(attemptId)) return false;
  try {
    await forceRemoveTree(join(trialsDir, attemptId, 'home'));
    return true;
  } catch (err) {
    logger.warn({ attemptId, err: codeOf(err) }, 'home of a lost attempt not deleted');
    return false;
  }
}

export interface RetentionDeps {
  db: AppDb;
  trialsDir: string;
  settings: Pick<LifecycleSettings, 'trialRetentionDays'>;
  logger: LifecycleLogger;
  /** When retention last ran here; updated by each pass that scans. */
  retention?: { lastRunAt: number };
  now?: () => number;
  /** Deletes one attempt's directory; removeTrialDirs unless a test supplies one. */
  removeTrialDir?: (trialsDir: string, attemptId: string) => Promise<void>;
}

/** Trial directories of attempts that finished before the retention window; how many were deleted. */
export async function removeExpiredTrialDirs(deps: RetentionDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  if (deps.retention) {
    if (now - deps.retention.lastRunAt < RETENTION_INTERVAL_MS) return 0;
    deps.retention.lastRunAt = now;
  }
  let names: string[];
  try {
    names = (await readdir(deps.trialsDir)).filter((name) => ATTEMPT_ID.test(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const cutoff = new Date(now - deps.settings.trialRetentionDays * 86_400_000);
  let removed = 0;
  for (let i = 0; i < names.length; i += CHUNK) {
    const expired = await deps.db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(inArray(attempts.id, names.slice(i, i + CHUNK)), lt(attempts.finishedAt, cutoff)));
    for (const { id } of expired) {
      try {
        await (deps.removeTrialDir ?? removeTrialDirs)(deps.trialsDir, id);
        removed += 1;
      } catch (err) {
        deps.logger.warn(
          { attemptId: id, err: codeOf(err) },
          'trial directory not deleted; retention goes on with the rest',
        );
      }
    }
  }
  return removed;
}
