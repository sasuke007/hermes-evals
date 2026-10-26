/**
 * scripts/phase3-smoke.sh checks json_match's stored evidence against two
 * literals, JSON_MATCH_A and JSON_MATCH_B. Phase 7 gave the evidence its
 * compared path and its entries key by key, and the smoke, still expecting
 * the counts alone, failed on the restored stack. Here both literals are
 * derived from the real scorer, the smoke's own reference and the mock's two
 * replies (scripts/phase3-mock-scripts.json), so a change to the evidence
 * fails this spec rather than the next live run.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JsonMatchParamsSchema, type JsonValue } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { scoreJsonMatch } from '../src/scoring/json-match.js';

const SMOKE = fileURLToPath(new URL('../../../scripts/phase3-smoke.sh', import.meta.url));
const MOCK = fileURLToPath(new URL('../../../scripts/phase3-mock-scripts.json', import.meta.url));

interface MockScript {
  match: string;
  steps: { content?: string }[];
}

/** The literal the smoke exports as JSON_MATCH_<which>. */
function literal(script: string, which: 'A' | 'B'): unknown {
  const line = new RegExp(`^\\s*export JSON_MATCH_${which}='([^']*)'$`, 'm').exec(script);
  if (!line?.[1]) throw new Error(`JSON_MATCH_${which} not found in phase3-smoke.sh`);
  return JSON.parse(line[1]);
}

/** The `record` the smoke writes into ledger/reference.json (a Python dict of plain strings and numbers). */
function referenceRecord(script: string): JsonValue {
  const found = /'record': (\{[^}]*\}),\n\s*'code'/.exec(script);
  if (!found?.[1]) throw new Error('the reference record was not found in phase3-smoke.sh');
  return JSON.parse(found[1].replaceAll("'", '"')) as JsonValue;
}

/** The `record` of the final fenced JSON block of the mock script whose match starts with `prefix`. */
function replyRecord(scripts: MockScript[], prefix: string): JsonValue {
  const script = scripts.find((s) => s.match.startsWith(prefix));
  const content = script?.steps.findLast((step) => step.content)?.content ?? '';
  const block = /```json\n([\s\S]*?)\n```/.exec(content);
  if (!block?.[1]) throw new Error(`no fenced JSON reply in the mock script "${prefix}"`);
  return (JSON.parse(block[1]) as { record: JsonValue }).record;
}

/** The stored evidence as the smoke compares it: entries sorted by path. */
function evidence(observed: JsonValue, expected: JsonValue): unknown {
  // The smoke's ledger task: `params: { path: record, pass_at: 0.9 }`.
  const params = JsonMatchParamsSchema.parse({ path: 'record', pass_at: 0.9 });
  const result = scoreJsonMatch(params, observed, expected);
  const json = (result.evidence as { json_match: { entries: { path: string }[] } }).json_match;
  return { ...json, entries: json.entries.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

describe('scripts/phase3-smoke.sh json_match evidence', () => {
  it('declares the ledger task the spec scores with', async () => {
    const script = await readFile(SMOKE, 'utf8');
    expect(script).toContain(
      "'  - key: record\\n    type: json_match\\n    params: { path: record, pass_at: 0.9 }\\n'",
    );
  });

  it('expects what the scorer writes for smoke-a (every key) and smoke-b (status paid)', async () => {
    const script = await readFile(SMOKE, 'utf8');
    const scripts = JSON.parse(await readFile(MOCK, 'utf8')) as MockScript[];
    const reference = referenceRecord(script);
    const replyA = replyRecord(scripts, 'smoke-score-method');
    const replyB = replyRecord(scripts, 'Smoke score task LEDGER');
    expect(evidence(replyA, reference)).toEqual(literal(script, 'A'));
    expect(evidence(replyB, reference)).toEqual(literal(script, 'B'));
    expect(literal(script, 'B')).toMatchObject({ matched: 4, total: 5, mismatches: ['status'] });
  });
});
