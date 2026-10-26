/**
 * Where an upload of a kind goes in a draft task (POST …/tasks/:key/files),
 * and the uploads refused for their size that a task keeps (Phase 5b
 * question 11): a refusal holds the path the file would have had, so a file
 * stored there later, or a DELETE of the path, drops it.
 */
import {
  HOME_MEMORIES_DIR,
  HOME_SEED_PATHS,
  TASK_HOME_DIR,
  type DraftRefusedUpload,
  type DraftUploadKind,
} from '@hermes-evals/shared';
import { badRequest } from '../http-errors.js';
import { FIXTURES_DIR } from '../loader/limits.js';
import type { DraftLayout } from './draft-folder.js';

/** The folder task.yaml must name before an expected or expected-home file can be stored. */
export interface FolderToName {
  field: 'expectedWorkspace' | 'expectedHome';
  dir: string;
}

export interface UploadTarget {
  /** The file's path in the task folder, not yet checked against the path rules. */
  path: string;
  /** The folder task.yaml does not name yet, which the upload names (`expected`, `expected_home`); else null. */
  names: FolderToName | null;
}

/** `memories/USER.md` and `USER.md` both mean `memories/USER.md`. */
const inMemories = (name: string): string =>
  name.startsWith(`${HOME_MEMORIES_DIR}/`) ? name : `${HOME_MEMORIES_DIR}/${name}`;

/**
 * The path of an upload of `kind` named `name` (inside the kind's folder)
 * in a task laid out as `layout`. 400 for a home seed that is neither
 * MEMORY.md nor USER.md.
 */
export function uploadTarget(
  kind: DraftUploadKind,
  name: string,
  layout: DraftLayout,
): UploadTarget {
  switch (kind) {
    case 'fixture':
      return { path: `${FIXTURES_DIR}/${name}`, names: null };
    case 'home_seed': {
      const path = `${TASK_HOME_DIR}/${inMemories(name)}`;
      if (!(HOME_SEED_PATHS as readonly string[]).includes(path)) {
        throw badRequest(`a home seed is ${HOME_SEED_PATHS.map((p) => p.slice(5)).join(' or ')}`);
      }
      return { path, names: null };
    }
    case 'expected':
      return {
        path: `${layout.expectedDir ?? 'expected'}/${name}`,
        names: layout.expectedDir === null ? { field: 'expectedWorkspace', dir: 'expected' } : null,
      };
    case 'expected_home':
      return {
        path: `${layout.expectedHomeDir ?? 'expected_home'}/${inMemories(name)}`,
        names:
          layout.expectedHomeDir === null ? { field: 'expectedHome', dir: 'expected_home' } : null,
      };
  }
}

/** The refusals without the one at `path`. */
export const withoutRefusalAt = (
  refused: readonly DraftRefusedUpload[],
  path: string,
): DraftRefusedUpload[] => refused.filter((u) => u.path !== path);

/** The refusals with `refusal` in place of an older one at its path, by path. */
export const withRefusal = (
  refused: readonly DraftRefusedUpload[],
  refusal: DraftRefusedUpload,
): DraftRefusedUpload[] =>
  [...withoutRefusalAt(refused, refusal.path), refusal].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
