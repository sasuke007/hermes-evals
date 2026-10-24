/**
 * The two hashes that identify a suite version (plan 3.1, 4.4).
 *
 * - Content hash: what is on disk. sha256 over the list of (relative path,
 *   sha256 of the bytes) of every file the loader reads, sorted by path. It is
 *   encoded as JSON, so no path can be confused with a separator. A task's own
 *   content hash is the same over that task's files, with paths relative to
 *   the task folder; its version number goes up only when it changes.
 * - Check hash: what the loader concluded about those files. sha256 over the
 *   loader version, every scorer version, and each task's key, validity and
 *   self-check status. The same files judged by a newer loader or scorer get a
 *   new version even though their content hash is unchanged.
 */
import { createHash } from 'node:crypto';
import { SCORER_TYPES } from '@hermes-evals/shared';
import { comparePaths } from './walk.js';

export interface HashedFile {
  path: string;
  sha256: string;
}

export const sha256Hex = (content: Uint8Array | string): string =>
  createHash('sha256').update(content).digest('hex');

/** sha256 of the sorted (path, sha256) list. Throws on a repeated path, which would be a loader bug. */
export function contentHash(files: readonly HashedFile[]): string {
  const sorted = [...files].sort((a, b) => comparePaths(a.path, b.path));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.path === sorted[i - 1]!.path) {
      throw new Error(`file ${sorted[i]!.path} hashed twice`);
    }
  }
  return sha256Hex(JSON.stringify(sorted.map((f) => [f.path, f.sha256])));
}

/** What the check hash records about one task. */
export interface TaskVerdict {
  key: string;
  valid: boolean;
  /** SelfCheck.status: passed, failed, error, or skipped when load errors stopped the checks. */
  selfCheckStatus: string;
}

export interface CheckHashInput {
  loaderVersion: number;
  scorerVersions: Readonly<Record<string, number>>;
  tasks: readonly TaskVerdict[];
}

/** sha256 over the loader and scorer versions and every task's verdict, in a fixed order. */
export function checkHash(input: CheckHashInput): string {
  const scorers = SCORER_TYPES.map((type) => [type, input.scorerVersions[type] ?? null]);
  const tasks = [...input.tasks]
    .sort((a, b) => comparePaths(a.key, b.key))
    .map((t) => [t.key, t.valid, t.selfCheckStatus]);
  return sha256Hex(JSON.stringify({ loader: input.loaderVersion, scorers, tasks }));
}
