import { ScoreEvidenceSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { binary, graded, guarded, guardedAsync, scorerError, ungradable } from './result.js';

describe('scorer results', () => {
  it('keeps a score only on passed and failed', () => {
    expect(binary(true, 'ok')).toEqual({ status: 'passed', score: 1, comment: 'ok' });
    expect(graded(false, 0.4, 'partial')).toEqual({
      status: 'failed',
      score: 0.4,
      comment: 'partial',
    });
    expect(ungradable('no block').score).toBeNull();
    expect(scorerError('broke').score).toBeNull();
    expect(() => graded(true, 1.2, 'x')).toThrow(RangeError);
    expect(() => graded(true, Number.NaN, 'x')).toThrow(RangeError);
  });

  it('records an error in the evidence, keeping other evidence', () => {
    const script = {
      argv: ['python3'],
      exit_code: 1,
      timed_out: false,
      duration_ms: 3,
      stdout_line: null,
      stdout_tail: '',
      stderr_tail: 'boom',
    };
    const result = scorerError('verifier broke', 'boom', { evidence: { script } });
    expect(result.evidence).toEqual({
      script,
      error: { message: 'verifier broke', detail: 'boom' },
    });
    expect(ScoreEvidenceSchema.safeParse(result.evidence).success).toBe(true);
  });

  it('turns a throw into an error, never a zero', async () => {
    const sync = guarded(() => {
      throw new Error('bad input');
    });
    expect(sync).toMatchObject({
      status: 'error',
      score: null,
      comment: 'the scorer failed: bad input',
    });
    expect(sync.evidence?.error?.detail).toMatch(/^at /);
    const async = await guardedAsync(() => Promise.reject(new TypeError('nope')));
    expect(async).toMatchObject({
      status: 'error',
      score: null,
      comment: 'the scorer failed: nope',
    });
    expect(guarded(() => binary(true, 'fine')).status).toBe('passed');
  });
});
