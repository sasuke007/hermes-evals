/**
 * Whether a new suite's name is free (SA.10 "Name taken"), by the drafts
 * module's rule (draft-store.ts): the name is also the suite's folder under
 * SUITES_DIR, so a directory the loader knows (not one gone `missing`), a
 * directory whose suite.yaml declares it, or another draft takes it. The
 * API has no suites mount: a folder never loaded is unknown here, and the
 * save refuses it.
 */
import type { AppDb } from '../../database/types.js';
import { draftHoldingName, folderHoldingName } from '../drafts/draft-store.js';

/** At most this many suggestions are tried before falling back to a stamped name. */
const MAX_SUGGESTIONS = 100;

/** The folder holding `name` (a suite directory or a draft), or null when it is free. */
export async function suiteNameHolder(db: AppDb, name: string): Promise<string | null> {
  return (await folderHoldingName(db, name)) ?? (await draftHoldingName(db, name));
}

/** A free name to import as: `invoices-v1-copy`, then `invoices-v1-copy-2`, … */
export async function freeSuiteName(db: AppDb, name: string): Promise<string> {
  for (let n = 1; n <= MAX_SUGGESTIONS; n++) {
    const candidate = n === 1 ? `${name}-copy` : `${name}-copy-${n}`;
    if ((await suiteNameHolder(db, candidate)) === null) return candidate;
  }
  return `${name}-copy-${Date.now()}`;
}
