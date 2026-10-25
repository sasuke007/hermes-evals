/**
 * GET /experiments/:id/comparison (plan 10.3, UI_FLOWS 16) and the verdict
 * figures the experiment views show while an experiment runs.
 *
 * Each answer is read in one REPEATABLE READ READ ONLY transaction whose
 * first statement reads the experiment row, so every later statement sees
 * the snapshot of that row's results revision. The answer is then cached in
 * process by (experiment, candidate, key, filter, results revision, status,
 * configuration names): the 0001 triggers move the results revision on
 * every run status change and every score set published or superseded, so a
 * retry, a cancellation, an execution error or a re-score always misses;
 * the status is in the key because completing, pausing or resuming an
 * experiment moves no run but changes what the answer says (provisional or
 * final); and the names, read in the same snapshot right after the row,
 * because renaming a configuration moves no run either, yet the answer
 * names it (the refs, the secondary rows, the not-computable sentence).
 *
 * The cache is bounded (LRU); a key whose revision has moved on is never
 * asked for again and ages out.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  SCORE_KEY_PRIMARY,
  type ComparisonFilter,
  type ComparisonQuery,
  type ComparisonView,
} from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { computeComparisonStats, seedFromExperimentId } from '../../statistics/compute.js';
import {
  keySelectionOf,
  keySelectionValue,
  type KeySelection,
} from '../../statistics/contracts.js';
import { experimentNotFound } from '../views/not-found.js';
import { LruCache } from './cache.js';
import { ComparisonInputError, comparisonInputsOf, unknownCandidate } from './inputs.js';
import type { VersionFacts } from '../views/queries.js';
import {
  READ_ONLY_SNAPSHOT,
  experimentHead,
  experimentVersions,
  loadExperimentResults,
  type ExperimentHead,
  type ExperimentResults,
} from './results.js';
import { buildComparisonView } from './view.js';
import { chipVerdict, verdictFiguresOf, type VerdictFigures } from './verdicts.js';

/** Answers kept in process, per kind (plan 10.3: about 200). */
export const COMPARISON_CACHE_SIZE = 200;

/** The comparison of one candidate and key, from one read of the results. */
export function comparisonViewOf(
  results: ExperimentResults,
  figures: VerdictFigures,
  candidateVersionId: string,
  key: KeySelection,
  filter: ComparisonFilter,
): ComparisonView {
  const inputs = comparisonInputsOf(results, candidateVersionId, key);
  // On the primary key the selected candidate's statistics are its verdict figures.
  const stats =
    (key.kind === 'primary' ? figures.byCandidate.get(inputs.candidateVersionId) : undefined) ??
    computeComparisonStats(inputs.stats, { seed: seedFromExperimentId(results.id) });
  const candidateVerdicts = new Map(
    [...figures.byCandidate].map(([id, s]) => [id, chipVerdict(s, results.status)]),
  );
  return buildComparisonView({ results, inputs, stats, candidateVerdicts, filter });
}

const cacheKey = (parts: readonly (string | number)[]): string => JSON.stringify(parts);

/**
 * What an answer reads besides the question: the results revision, the
 * status, and the configurations' names in experiment order (the baseline
 * first), which a rename changes without moving the revision.
 */
const stateOf = (
  head: ExperimentHead,
  versions: ReadonlyMap<string, VersionFacts>,
): (string | number)[] => [
  head.resultsRevision,
  head.status,
  ...[head.baselineVersionId, ...head.candidateVersionIds].map(
    (id) => versions.get(id)?.name ?? '',
  ),
];

@Injectable()
export class ComparisonService {
  private readonly views = new LruCache<string, ComparisonView>(COMPARISON_CACHE_SIZE);
  private readonly figures = new LruCache<string, VerdictFigures>(COMPARISON_CACHE_SIZE);

  constructor(@Inject(DB) private readonly db: AppDb) {}

  /**
   * GET /experiments/:id/comparison: 404 for an unknown experiment, 400 for
   * a candidate it does not test or a named key some selected task lacks.
   */
  async comparison(experimentId: string, query: ComparisonQuery = {}): Promise<ComparisonView> {
    const key = keySelectionOf(query.key ?? SCORE_KEY_PRIMARY);
    const filter = query.filter ?? 'all';
    try {
      return await this.db.transaction(async (tx) => {
        const head = await experimentHead(tx, experimentId);
        if (!head) throw experimentNotFound(experimentId);
        const candidate = query.candidate ?? head.candidateVersionIds[0]!;
        if (!head.candidateVersionIds.includes(candidate)) {
          throw unknownCandidate(experimentId, candidate);
        }
        const versions = await experimentVersions(tx, head);
        const state = stateOf(head, versions);
        const viewKey = cacheKey([
          experimentId,
          candidate,
          keySelectionValue(key),
          filter,
          ...state,
        ]);
        const hit = this.views.get(viewKey);
        if (hit) return hit;
        const results = await loadExperimentResults(tx, experimentId, head, versions);
        if (!results) throw experimentNotFound(experimentId);
        const figuresKey = cacheKey([experimentId, ...state]);
        const figures = this.figures.get(figuresKey) ?? verdictFiguresOf(results);
        this.figures.set(figuresKey, figures);
        const view = comparisonViewOf(results, figures, candidate, key, filter);
        this.views.set(viewKey, view);
        return view;
      }, READ_ONLY_SNAPSHOT);
    } catch (err) {
      if (err instanceof ComparisonInputError) {
        throw new BadRequestException({ statusCode: 400, message: err.message });
      }
      throw err;
    }
  }

  /**
   * Every candidate's statistics on the primary key at the current results,
   * cached like the comparison; null for an unknown experiment. The
   * Overview's provisional verdicts come from here.
   */
  async verdictFigures(experimentId: string): Promise<VerdictFigures | null> {
    return this.db.transaction(async (tx) => {
      const head = await experimentHead(tx, experimentId);
      if (!head) return null;
      const versions = await experimentVersions(tx, head);
      const key = cacheKey([experimentId, ...stateOf(head, versions)]);
      const hit = this.figures.get(key);
      if (hit) return hit;
      const results = await loadExperimentResults(tx, experimentId, head, versions);
      if (!results) return null;
      const figures = verdictFiguresOf(results);
      this.figures.set(key, figures);
      return figures;
    }, READ_ONLY_SNAPSHOT);
  }
}
