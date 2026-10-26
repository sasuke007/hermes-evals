/**
 * Test helpers for the suite import specs: suite zips built in memory (with
 * buildZip of the skill specs), byte patches for what yazl refuses to write
 * (absolute names, `..`, a lying size, encryption), and a zip of a folder on
 * disk, read and never written. The name ends in `-spec.ts`, so the build
 * leaves it out, and not in `.spec.ts`, so vitest does not run it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { buildZip, type ZipItem } from '../../resources/skills/testing.helper-spec.js';

export { buildZip, type ZipItem };

/** Replaces every occurrence of a name with one of the same byte length. */
export function patchName(zip: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = Buffer.from(zip);
  const needle = Buffer.from(from);
  let at = out.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  while (at >= 0) {
    Buffer.from(to).copy(out, at);
    at = out.indexOf(needle, at + needle.length);
  }
  return out;
}

const CENTRAL_HEADER = 0x02014b50;

/** Applies `patch` to the central directory header of the entry named `name`. */
export function patchCentral(zip: Buffer, name: string, patch: (header: Buffer) => void): Buffer {
  const out = Buffer.from(zip);
  for (let at = 0; at < out.length - 46; at++) {
    if (out.readUInt32LE(at) !== CENTRAL_HEADER) continue;
    const nameLength = out.readUInt16LE(at + 28);
    if (out.subarray(at + 46, at + 46 + nameLength).toString() === name) {
      patch(out.subarray(at, at + 46));
      return out;
    }
  }
  throw new Error(`no central header for ${name}`);
}

export const SUITE_YAML =
  'name: vendor-statements-v1\nversion_label: "0.1"\ntasks:\n  - unmatched_lines\n';

export const TASK_YAML = `summary: Lines of the statement missing from the ledger
limits:
  max_turns: 10
  run_budget_seconds: 120
  toolsets_needed: [file]
answer:
  format: fenced_json
  path: unmatched
verification:
  - key: answer
    type: json_match
    primary: true
    params: { path: unmatched, unordered: true }
`;

export const PROMPT = 'Compare statement.csv with ledger.csv. Answer in a fenced ```json block.\n';
export const REFERENCE = '{ "unmatched": ["S-104"] }\n';

/** vendor-statements-v1 of the board: one valid task, two workspace files. */
export function vendorStatements(prefix = '', extra: ZipItem[] = []): ZipItem[] {
  return [
    { path: `${prefix}suite.yaml`, content: SUITE_YAML },
    { path: `${prefix}unmatched_lines/task.yaml`, content: TASK_YAML },
    { path: `${prefix}unmatched_lines/prompt.md`, content: PROMPT },
    { path: `${prefix}unmatched_lines/reference.json`, content: REFERENCE },
    { path: `${prefix}unmatched_lines/fixtures/statement.csv`, content: 'line,amount\nS-104,12\n' },
    { path: `${prefix}unmatched_lines/fixtures/ledger.csv`, content: 'line,amount\nS-101,10\n' },
    ...extra,
  ];
}

/** Every file under `dir`, relative and sorted, as zip items (folders implied). */
export async function zipItemsOfFolder(dir: string, prefix = ''): Promise<ZipItem[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const items: ZipItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = abs.slice(dir.length + 1);
    items.push({ path: `${prefix}${rel}`, content: await readFile(abs) });
  }
  return items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
