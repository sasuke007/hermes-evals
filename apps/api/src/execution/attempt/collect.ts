/**
 * Artifact collection (plan 8.5), run after the container is removed so
 * nothing changes under the walk. The agent controls every name, link and
 * file type in the workspace, and the worker reads it in its own view, where
 * the trials and data volumes hold every other attempt and the blob store.
 * So it is read only through trial-files.ts: an lstat walk that never follows
 * a link, and reads that refuse links, FIFOs, devices and anything that
 * resolves outside the workspace.
 *
 * Each regular file becomes an artifact with root `workspace`: its content
 * goes to the blob store and its origin comes from comparing it with the
 * inputs copied in before the run (fixture or document, unchanged or
 * modified), or `agent` for anything else (collect-files.ts). Files over
 * 25 MB are recorded with `too_large` and no content. Links, special files
 * and unreadable names are not artifacts; the `collected` event lists them,
 * with the inputs the agent deleted.
 *
 * collectTrialFiles then collects the home's memories/ (collect-home.ts,
 * Phase 6 P2) with what the workspace left of the budget, before the runner
 * deletes the home, and the same event describes both. The memory tool's
 * empty `*.lock` files there are skipped (collect-files.ts isMemoryLockFile);
 * a workspace file of that name is collected like any other.
 *
 * What one attempt may add to the blob store is bounded too
 * (MAX_COLLECTED_BYTES): each file's apparent size, which is what the store
 * writes, is charged before it is read, and a file past the budget is
 * recorded with `over_budget` and no content. The disk cap the trial ran
 * under counts allocated blocks, so without this, sparse files would turn a
 * few megabytes on the trials volume into a hundred gigabytes of blobs on
 * the disk Postgres shares. Content the store already holds (an unchanged
 * input, a repeated file) is not charged.
 */
import type { AttemptEventInput, AttemptArtifact, PlannedHomeSeed } from '../contracts.js';
import {
  MAX_COLLECTED_BYTES,
  restoreOwnerAccess,
  walkTrialTree,
} from '../../sandbox/trial-files.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { collectEntries } from './collect-files.js';
import { collectHomeMemories, type HomeCollection } from './collect-home.js';
import type { InputFile } from './materialise.js';

/** Entries the `collected` event lists by name; the rest are counted. */
export const MAX_LISTED = 50;

export interface Collection {
  artifacts: AttemptArtifact[];
  /** The `collected` platform event. */
  event: AttemptEventInput;
}

/** The workspace's collection, and what it charged the attempt's budget. */
export interface WorkspaceCollection extends Collection {
  /** Bytes new to the blob store. */
  newBytes: number;
}

/** Walks the workspace, stores what can be stored, and labels every file. */
export async function collectWorkspace(
  workspace: string,
  manifest: ReadonlyMap<string, InputFile>,
  blobs: BlobStore,
  now = Date.now,
  budgetBytes = MAX_COLLECTED_BYTES,
): Promise<WorkspaceCollection> {
  const tree = await walkTrialTree(workspace);
  const { artifacts, notCollected, storedBytes, newBytes, seen } = await collectEntries(
    workspace,
    tree.entries,
    'workspace',
    manifest,
    blobs,
    budgetBytes,
  );
  const overBudgetPaths = artifacts
    .filter((a) => a.skippedReason === 'over_budget')
    .map((a) => a.path);

  const deleted = [...manifest.keys()].filter((path) => !seen.has(path)).sort();
  const event: AttemptEventInput = {
    ts: now(),
    type: 'platform',
    payload: {
      type: 'platform',
      subtype: 'collected',
      files: artifacts.length,
      stored: artifacts.filter((a) => a.sha256 !== null).length,
      stored_bytes: storedBytes,
      new_bytes: newBytes,
      too_large: artifacts.filter((a) => a.skippedReason === 'too_large').map((a) => a.path),
      ...(overBudgetPaths.length > 0
        ? {
            budget_exceeded: true,
            budget_bytes: budgetBytes,
            over_budget: overBudgetPaths.slice(0, MAX_LISTED),
            over_budget_count: overBudgetPaths.length,
          }
        : {}),
      agent_files: artifacts.filter((a) => a.origin === 'agent').length,
      not_collected: notCollected.slice(0, MAX_LISTED),
      not_collected_count: notCollected.length,
      deleted_inputs: deleted.slice(0, MAX_LISTED),
      deleted_input_count: deleted.length,
      truncated: tree.truncated,
    },
  };
  return { artifacts, event, newBytes };
}

/** What collectTrialFiles reads: the attempt's two directories and what was placed in them. */
export interface TrialFilesInput {
  /** AttemptPlan.paths.workspace and .home. */
  workspace: string;
  home: string;
  /** The workspace inputs (MaterialisedTrial.manifest). */
  manifest: ReadonlyMap<string, InputFile>;
  /** The home seeds the plan placed (AttemptPlan.task.homeSeeds), by home-relative path. */
  homeSeeds: readonly PlannedHomeSeed[];
  blobs: BlobStore;
  now?: () => number;
  /** MAX_COLLECTED_BYTES by default, shared by both directories, the workspace first. */
  budgetBytes?: number;
}

/**
 * The home part of the `collected` event: how many memory files, which of
 * them the agent wrote, what was not collected and which seeds it deleted.
 * A failure to collect the home is `home_error`; the workspace's artifacts
 * stand either way.
 */
function homeFields(home: HomeCollection | { error: string }): Record<string, unknown> {
  if ('error' in home) return { home_files: 0, home_error: home.error };
  return {
    home_files: home.artifacts.length,
    home_stored: home.artifacts.filter((a) => a.sha256 !== null).length,
    home_new_bytes: home.newBytes,
    home_agent_files: home.artifacts.filter((a) => a.origin === 'agent').length,
    home_too_large: home.artifacts
      .filter((a) => a.skippedReason === 'too_large')
      .map((a) => `home/${a.path}`),
    home_over_budget: home.artifacts
      .filter((a) => a.skippedReason === 'over_budget')
      .map((a) => `home/${a.path}`)
      .slice(0, MAX_LISTED),
    home_not_collected: home.notCollected
      .slice(0, MAX_LISTED)
      .map((n) => ({ ...n, path: `home/${n.path}` })),
    home_not_collected_count: home.notCollected.length,
    deleted_home_seeds: home.deletedSeeds.map((path) => `home/${path}`),
    home_truncated: home.truncated,
  };
}

/**
 * Collects everything an attempt leaves (plan 8.5, Phase 6 P2): the
 * workspace, with the owner permissions the agent removed restored first,
 * then the home's memories/ with what is left of the budget. Call it after
 * the container is removed and before the home is deleted. A workspace that
 * cannot be collected throws (the runner records it on the event); a home
 * that cannot be collected is `home_error` on the event and no artifact.
 */
export async function collectTrialFiles(input: TrialFilesInput): Promise<Collection> {
  const now = input.now ?? Date.now;
  const budget = input.budgetBytes ?? MAX_COLLECTED_BYTES;
  // A directory the agent made unlistable would otherwise hide its files from collection.
  await restoreOwnerAccess(input.workspace);
  const workspace = await collectWorkspace(
    input.workspace,
    input.manifest,
    input.blobs,
    now,
    budget,
  );
  const seeds = new Map(input.homeSeeds.map((s) => [s.path, { sha256: s.sha256, size: s.size }]));
  let home: HomeCollection | { error: string };
  try {
    home = await collectHomeMemories(
      input.home,
      seeds,
      input.blobs,
      Math.max(0, budget - workspace.newBytes),
    );
  } catch (err) {
    home = { error: err instanceof Error ? err.message : String(err) };
  }
  const homeArtifacts = 'error' in home ? [] : home.artifacts;
  return {
    artifacts: [...workspace.artifacts, ...homeArtifacts],
    event: {
      ...workspace.event,
      payload: { ...workspace.event.payload, ...homeFields(home) },
    },
  };
}
