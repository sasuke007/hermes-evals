/**
 * The history an estimate is computed from (plan 7.2): executed attempts of
 * runs on a suite directory (any version of it) under configuration versions
 * with a given config_hash. One query serves every (directory, hash) pair the
 * New experiment page asks about, keeping the most recent attempts of each.
 */
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
  attempts,
  configurationVersions,
  experiments,
  runs,
  suites,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { AttemptHistory, PastAttempt } from './per-run-estimate.js';

/** Most recent attempts per pair the medians are taken over; older ones only count in `total`. */
export const HISTORY_SAMPLE = 200;

/** Map key of one (suite directory, config hash) pair. */
export const historyKey = (sourcePath: string, configHash: string): string =>
  `${sourcePath}\u0000${configHash}`;

/**
 * Past executed attempts for every pair of the given directories and config
 * hashes, keyed by historyKey. Pairs with no attempt are absent.
 */
export async function attemptHistory(
  db: AppDb,
  sourcePaths: readonly string[],
  configHashes: readonly string[],
  sample: number = HISTORY_SAMPLE,
): Promise<Map<string, AttemptHistory>> {
  if (sourcePaths.length === 0 || configHashes.length === 0) return new Map();
  const pair = sql`${suites.sourcePath}, ${configurationVersions.configHash}`;
  const ranked = db
    .select({
      sourcePath: suites.sourcePath,
      configHash: configurationVersions.configHash,
      durationMs: attempts.durationMs,
      tokens: attempts.tokens,
      rank: sql<number>`(row_number() over (partition by ${pair} order by ${attempts.finishedAt} desc, ${attempts.id} desc))::int`.as(
        'rank',
      ),
      total: sql<number>`(count(*) over (partition by ${pair}))::int`.as('total'),
    })
    .from(attempts)
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .innerJoin(suites, eq(suites.id, experiments.suiteId))
    .where(
      and(
        eq(attempts.status, 'executed'),
        isNotNull(attempts.durationMs),
        inArray(suites.sourcePath, [...sourcePaths]),
        inArray(configurationVersions.configHash, [...configHashes]),
      ),
    )
    .as('ranked');
  const rows = await db.select().from(ranked).where(lte(ranked.rank, sample));

  const byPair = new Map<string, { attempts: PastAttempt[]; total: number }>();
  for (const row of rows) {
    const key = historyKey(row.sourcePath, row.configHash);
    const entry = byPair.get(key) ?? { attempts: [], total: row.total };
    entry.attempts.push({ durationMs: row.durationMs!, tokens: row.tokens ?? null });
    byPair.set(key, entry);
  }
  return byPair;
}
