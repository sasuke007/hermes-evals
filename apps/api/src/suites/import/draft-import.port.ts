/**
 * What the imports need from the drafts module, which owns the draft tables
 * and their views (plan 4.6): read the open draft of a folder, add tasks to
 * it, and open the draft of a new suite. The import builds the tasks
 * (parsers.ts) and stores their files in the blob store, and records each
 * blob (blobs rows) before it calls these, so a draft file never names a
 * blob without its row. The drafts module computes readiness, positions,
 * revisions and the change list as on any other edit.
 *
 * The drafts module provides the implementation under DRAFT_IMPORT_PORT
 * (SuiteImportModule.withDrafts).
 */
import type { SuiteDraftView } from '@hermes-evals/shared';
import type { DraftTaskFolder } from '../drafts/materialise.js';

export const DRAFT_IMPORT_PORT = Symbol('DRAFT_IMPORT_PORT');

/** The open draft of a folder, as the task import reads it. */
export interface DraftForImport {
  /** Every task of the draft, removed ones included (their keys stay taken), with its files. */
  tasks: readonly DraftTaskFolder[];
}

/** The draft of a new suite, from a validated zip (origin `zip`). */
export interface ImportedSuiteDraft {
  /** The suite's name, which is also its folder under SUITES_DIR. */
  name: string;
  versionLabel: string;
  description: string | null;
  /**
   * suite.yaml as the zip held it, exactly as read. The draft keeps it
   * (suite_drafts.suite_yaml), and the save patches only the fields the
   * draft changed into it, so its comments and folding survive (Phase 5b
   * question 17).
   */
  suiteYaml: string;
  /** In suite.yaml order, then the other folders by name, as a reload orders them. */
  tasks: readonly DraftTaskFolder[];
  /**
   * True when the zip holds verifier scripts and the user ticked "I trust
   * these scripts" (R7): the draft records when (scripts_trusted_at).
   * False for a zip without scripts.
   */
  scriptsTrusted: boolean;
}

export interface DraftImportPort {
  /** The open draft of `folder`, or null when it has none. */
  draftForImport(folder: string): Promise<DraftForImport | null>;
  /**
   * Adds `tasks` at the end of the draft of `folder`, in order, as `added`
   * tasks. Refuses with an HttpException as any other draft write does: 404
   * without a draft, 409 while a save runs or when a key was taken meanwhile.
   */
  addImportedTasks(folder: string, tasks: readonly DraftTaskFolder[]): Promise<SuiteDraftView>;
  /**
   * Opens the draft of a new suite with every task added. 409 when the name
   * is taken (a suite folder, a suite name or another draft holds it).
   */
  createImportedSuiteDraft(draft: ImportedSuiteDraft): Promise<SuiteDraftView>;
}
