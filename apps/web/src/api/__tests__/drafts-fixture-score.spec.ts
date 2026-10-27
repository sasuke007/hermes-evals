/**
 * Try it in fixtures mode reads an answer as the API does (Phase 8 G5): the last ```json
 * block, else a reply that is exactly one JSON object. Anything else without a fence stays
 * missing.
 */
import { describe, expect, it } from 'vitest';
import { extractAnswerBlock } from '@/api/drafts-fixture-score';

describe('extractAnswerBlock', () => {
  it('reads the last fenced block', () => {
    const reply = 'Draft:\n```json\n{"a": 1}\n```\nFinal:\n```json\n{"a": 2}\n```\n';
    expect(extractAnswerBlock(reply)).toEqual({ status: 'found', block: '{"a": 2}', error: null });
  });

  it('takes a reply that is one JSON object without a fence as the answer', () => {
    expect(extractAnswerBlock('\n  {"total_due": 17.5}\n')).toEqual({
      status: 'found',
      block: '{"total_due": 17.5}',
      error: null,
    });
  });

  it.each([
    ['prose around the object', 'The answer is {"a": 1}.'],
    ['an array', '[1, 2]'],
    ['a scalar', '42'],
    ['an invalid object', '{"a": 1,}'],
    ['two objects', '{"a": 1}\n{"a": 2}'],
  ])('keeps %s without a fence missing', (_name, reply) => {
    expect(extractAnswerBlock(reply)).toEqual({ status: 'missing', block: null, error: null });
  });

  it('still reports an invalid fenced block as invalid', () => {
    expect(extractAnswerBlock('```json\n{"a": }\n```').status).toBe('invalid');
  });
});
