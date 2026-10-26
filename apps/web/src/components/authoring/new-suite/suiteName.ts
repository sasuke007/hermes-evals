/**
 * Whether a new suite's name can be used (SA.2, SA.10): it is also the folder, so it must be
 * a folder name the loader reads, and no suite on disk or open draft may hold it. A folder
 * gone from disk releases its name. Pure; the API checks the same when the draft is created.
 */
import { DIRECTORY_KEY_PATTERN } from '@hermes-evals/shared';

export type SuiteNameProblem =
  | { kind: 'empty' }
  /** Not a folder name: "Use letters, digits, ., _ and -, starting with a letter or digit." */
  | { kind: 'invalid' }
  /** A suite or a draft holds it, at `path` (`./suites/invoices-v1`). */
  | { kind: 'taken'; path: string; draft: boolean };

export interface NameHolder {
  name: string;
  path: string;
  draft: boolean;
}

export function suiteNameProblem(
  name: string,
  holders: readonly NameHolder[],
): SuiteNameProblem | null {
  if (name === '') return { kind: 'empty' };
  if (!DIRECTORY_KEY_PATTERN.test(name)) return { kind: 'invalid' };
  const holder = holders.find((h) => h.name === name);
  return holder ? { kind: 'taken', path: holder.path, draft: holder.draft } : null;
}

/** `./suites/<name>/`, or the placeholder while there is no usable name. */
export const folderLine = (name: string, usable: boolean): string =>
  usable ? `./suites/${name}/` : './suites/<name>/';

/** Who holds which name: every suite still on disk, and every open draft. */
export function nameHolders(
  suites: readonly { name: string; path: string; lastLoad: { outcome: string } }[],
  drafts: readonly { folder: string; path: string }[],
): NameHolder[] {
  return [
    ...suites
      .filter((s) => s.lastLoad.outcome !== 'missing')
      .map((s) => ({ name: s.name, path: s.path, draft: false })),
    ...drafts.map((d) => ({ name: d.folder, path: d.path, draft: true })),
  ];
}
