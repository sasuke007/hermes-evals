/**
 * The Outcome section's pure pieces that the database specs reach only in
 * part: the score evidence as each check type stores it (Phase 3 question
 * 5), and the error banner of a run stopped at the token cap (question 8).
 */
import { describe, expect, it } from 'vitest';
import {
  ExecutionErrorViewSchema,
  ScoreEvidenceViewSchema,
  type ScoreEvidence,
} from '@hermes-evals/shared';
import { evidenceView, executionErrorView } from './outcome.js';

const parse = (evidence: ScoreEvidence) => ScoreEvidenceViewSchema.parse(evidenceView(evidence));

describe('the score evidence', () => {
  it('is pointers only, with every scorer detail null, for a key that wrote none', () => {
    expect(parse({ event_seqs: [7, 0, -1], artifact_ids: ['art_1'] })).toEqual({
      eventSeqs: [7],
      artifactIds: ['art_1'],
      judge: null,
      trajectory: null,
      text: null,
      jsonMatch: null,
    });
    expect(parse({})).toMatchObject({ eventSeqs: [], artifactIds: [] });
  });

  it("carries the judge's model, tokens, cost and each call's status and latency", () => {
    const view = parse({
      judge: {
        provider: 'custom',
        base_url: 'http://judge.internal:8000/v1',
        model: 'grader-1',
        calls: 2,
        tokens: { input: 1200, output: 80, total: 1280 },
        cost_usd: 0.0042,
        latency_ms: 2400,
        finish_reason: 'stop',
        call_log: [
          { status: 503, latency_ms: 900 },
          { status: 200, latency_ms: 1500 },
        ],
      },
    });
    expect(view.judge).toEqual({
      provider: 'custom',
      baseUrl: 'http://judge.internal:8000/v1',
      model: 'grader-1',
      calls: 2,
      tokens: { input: 1200, output: 80, total: 1280 },
      costUsd: 0.0042,
      latencyMs: 2400,
      finishReason: 'stop',
      callLog: [
        { status: 503, latencyMs: 900 },
        { status: 200, latencyMs: 1500 },
      ],
    });
  });

  it('reads a judge row stored before Phase 4: no base URL, finish reason or call log', () => {
    const view = parse({
      judge: {
        provider: 'nous',
        model: 'Hermes-4-70B',
        calls: 1,
        tokens: { input: 900, output: 40, total: 940 },
        cost_usd: null,
        latency_ms: 800,
      },
    });
    expect(view.judge).toMatchObject({
      baseUrl: null,
      costUsd: null,
      finishReason: null,
      callLog: [],
    });
  });

  it("carries the trajectory's counts, text_match's items and json_match's mismatches", () => {
    const view = parse({
      event_seqs: [4, 9],
      trajectory: { tool: 'mcp__invoice_db__list_invoices', calls: 3, matched_seqs: [4, 9] },
      text: {
        items: [
          { kind: 'phrase', label: '1.5%', found: true },
          { kind: 'pattern', label: '30 ?days', found: false },
        ],
        truncated: false,
      },
      json_match: { unit: 'keys', matched: 4, total: 5, mismatches: ['bands[2].net'] },
    });
    expect(view.trajectory).toEqual({
      tool: 'mcp__invoice_db__list_invoices',
      calls: 3,
      matchedSeqs: [4, 9],
      mode: null,
    });
    expect(view.text).toEqual({
      items: [
        { kind: 'phrase', label: '1.5%', found: true },
        { kind: 'pattern', label: '30 ?days', found: false },
      ],
      truncated: false,
    });
    expect(view.jsonMatch).toEqual({
      unit: 'keys',
      matched: 4,
      total: 5,
      mismatches: ['bands[2].net'],
    });
  });

  it("keeps a whole-trajectory comparison's mode", () => {
    const view = parse({
      trajectory: { tool: 'read_file', calls: 2, matched_seqs: [], mode: 'superset' },
    });
    expect(view.trajectory).toEqual({
      tool: 'read_file',
      calls: 2,
      matchedSeqs: [],
      mode: 'superset',
    });
  });
});

describe('the banner of a run stopped at the token cap', () => {
  const message =
    'The model gateway stopped the run at its token cap: HTTP 429: This attempt reached its token cap of 2000000 tokens (2000418 used; MODEL_TOKEN_CAP_PER_ATTEMPT)';

  it('names the cap and says a retry gets a fresh one, never an automatic retry', () => {
    const view = ExecutionErrorViewSchema.parse(
      executionErrorView({
        attempt: {
          number: 1,
          errorCategory: 'limit',
          errorMessage: message,
          exitCode: 1,
          durationMs: 214_400,
          stderrTail: 'hermes: provider error (429); exit 1\n',
        },
        budgetS: 300,
        worker: null,
        stderrTotalLines: 1,
      }),
    );
    expect(view).toMatchObject({
      category: 'limit',
      reason: message,
      meta: 'after 214 s',
      exitCode: 1,
      stderrTail: { lines: ['hermes: provider error (429); exit 1'], totalLines: 1 },
    });
    expect(view.explanation).toMatch(/MODEL_TOKEN_CAP_PER_ATTEMPT/);
    expect(view.explanation).toMatch(/never retried automatically/);
  });
});
