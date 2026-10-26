/**
 * Where the scripted mock model (mock-model.ts) gets its scripts: the
 * environment variable MOCK_SCRIPTS, for short overrides, and the file or
 * directory MOCK_SCRIPTS_FILE names (Phase 6b question 11, Phase 7). Every
 * suite's and smoke test's scripts together are about 59 KB, half of the
 * 128 KiB Linux lets one environment string hold, so they come from a file
 * Compose mounts instead of the environment.
 *
 *   MOCK_SCRIPTS       JSON array of { "match": "...", "steps": [...] }
 *   MOCK_SCRIPTS_FILE  a file holding such an array, or a directory whose
 *                      `*.json` files each hold one, read in name order
 *                      (so `./scripts` gives the mock every
 *                      `scripts/*mock-scripts.json` at once)
 *
 * The scripts of MOCK_SCRIPTS come first, so an override wins over a file's
 * script with the same phrase: the mock plays the first script whose phrase
 * a request holds. Both are read once, at start; a bad value stops the mock
 * with the variable's or the file's name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const StepSchema = z.union([
  z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }),
  z.object({ content: z.string() }),
]);
export const StepsSchema = z.array(StepSchema).min(1);
export const ScriptsSchema = z.array(z.object({ match: z.string().min(1), steps: StepsSchema }));

export type MockStep = z.infer<typeof StepSchema>;
export type MockScript = z.infer<typeof ScriptsSchema>[number];

/** Reads one JSON text against its schema; a bad value throws naming `source`. */
export function parseJson<T>(source: string, raw: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${source} is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** What MOCK_SCRIPTS_FILE gave: the scripts and the files they came from, in order. */
export interface ScriptsFile {
  path: string;
  files: string[];
  scripts: MockScript[];
}

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/**
 * The scripts of MOCK_SCRIPTS_FILE. A directory's `*.json` files are read in
 * name order and their scripts kept in that order; a directory with none
 * gives no scripts (Docker creates an empty directory where a bind mount's
 * source is missing, so the start log says how many files were read).
 */
export function readScriptsFile(path: string): ScriptsFile {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch (err) {
    throw new Error(
      `MOCK_SCRIPTS_FILE ${path} cannot be read (${errorCode(err) ?? 'unknown error'})`,
      { cause: err },
    );
  }
  const files = isDirectory
    ? readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => join(path, entry.name))
        .sort()
    : [path];
  const scripts = files.flatMap((file) =>
    parseJson(`MOCK_SCRIPTS_FILE ${file}`, readFileSync(file, 'utf8'), ScriptsSchema),
  );
  return { path, files, scripts };
}
