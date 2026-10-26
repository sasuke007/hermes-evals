/**
 * The only writes to SUITES_DIR (plan 4.6, 14; Phase 5b). The worker mounts
 * ./suites read-write for the save of a draft alone, and every path the save
 * touches goes through this guard first:
 *
 * - a folder it names is one plain name directly under SUITES_DIR: a suite
 *   folder (`invoices-v1`), its staging folder (`.draft-<id>`, which the
 *   loader skips as a dot name) or the live folder set aside during the
 *   swap (`.draft-<id>-old`);
 * - a file it writes resolves inside one of those, and SUITES_DIR itself is
 *   resolved through any link once, so a link in its place cannot send the
 *   writes elsewhere.
 *
 * The loader never writes, and the API has no suites mount at all.
 */
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DIRECTORY_KEY_PATTERN } from '@hermes-evals/shared';

const STAGING = /^\.draft-[0-9A-HJKMNP-TV-Z]{26}(-old)?$/;

/** A folder name the save may create, replace or remove directly under SUITES_DIR. */
const isFolderName = (name: string): boolean =>
  name.length <= 255 && (DIRECTORY_KEY_PATTERN.test(name) || STAGING.test(name));

export const stagingName = (draftId: string): string => `.draft-${draftId}`;
export const asideName = (draftId: string): string => `.draft-${draftId}-old`;

export class SuitesDirGuardError extends Error {
  constructor(message: string) {
    super(`refusing to write outside SUITES_DIR: ${message}`);
    this.name = 'SuitesDirGuardError';
  }
}

export class SuitesDir {
  private constructor(readonly root: string) {}

  /** SUITES_DIR resolved through links, so every later check compares real paths. */
  static async open(suitesDir: string): Promise<SuitesDir> {
    const root = await realpath(resolve(suitesDir));
    if (!(await lstat(root)).isDirectory())
      throw new SuitesDirGuardError(`${root} is not a folder`);
    return new SuitesDir(root);
  }

  /** The absolute path of the folder `name` directly under SUITES_DIR. */
  folder(name: string): string {
    if (!isFolderName(name)) {
      throw new SuitesDirGuardError(
        `${JSON.stringify(name)} is not a suite or staging folder name`,
      );
    }
    const path = join(this.root, name);
    if (dirname(path) !== this.root) throw new SuitesDirGuardError(JSON.stringify(name));
    return path;
  }

  /** `path`, after checking it is inside one of the folders above. */
  inside(path: string): string {
    const full = resolve(path);
    const rel = full.slice(this.root.length + 1);
    if (!full.startsWith(`${this.root}${sep}`) || rel === '') {
      throw new SuitesDirGuardError(full);
    }
    this.folder(rel.split(sep)[0]!);
    return full;
  }

  /** Renames one folder under SUITES_DIR to another name there (the swap's two steps). */
  async move(from: string, to: string): Promise<void> {
    await rename(this.folder(from), this.folder(to));
  }

  /** Removes a folder under SUITES_DIR and everything in it; absent is fine. */
  async remove(name: string): Promise<void> {
    await rm(this.folder(name), { recursive: true, force: true });
  }

  /** Whether `name` exists under SUITES_DIR, as anything (a folder, a file, a link). */
  async exists(name: string): Promise<boolean> {
    try {
      await lstat(this.folder(name));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}
