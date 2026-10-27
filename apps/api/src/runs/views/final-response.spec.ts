/**
 * The inspector's Final response on an unfenced answer (Phase 8 G5): the
 * reply was one JSON object without a ```json fence, so there is no fence to
 * draw, the extracted range is the trimmed reply, and `unfenced` says so.
 * Every other answer keeps `unfenced` false. Broken answers are covered in
 * views.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { ExtractedAnswerSchema, FinalResponseViewSchema } from '@hermes-evals/shared';
import { extractAnswer } from '../../scoring/extraction.js';
import { finalResponseView } from './final-response.js';

const view = (text: string, stored: unknown = null) =>
  FinalResponseViewSchema.parse(
    finalResponseView(text, stored === null ? null : ExtractedAnswerSchema.parse(stored), {
      total: 10,
    }),
  );

describe('the final response of an unfenced answer', () => {
  it('shows the trimmed reply as the answer, with no fence', () => {
    const text = '\n{"total": 10}\n';
    const shown = view(text);
    expect(shown).toMatchObject({
      extraction: 'found',
      unfenced: true,
      fence: null,
      parsed: { total: 10 },
      parseError: null,
    });
    expect(text.slice(shown.extracted!.start, shown.extracted!.end)).toBe('{"total": 10}');
  });

  it('reads the flag from the stored extraction the scores came from', () => {
    const text = '{"total": 10}';
    expect(view(text, extractAnswer(text))).toMatchObject({ unfenced: true, fence: null });
    // An extraction stored before Phase 8 found nothing in this reply; the view shows what was stored.
    expect(view(text, { status: 'missing', block_count: 0 })).toMatchObject({
      extraction: 'missing',
      unfenced: false,
      extracted: null,
    });
  });

  it('keeps unfenced false on fenced, missing and invalid answers', () => {
    const fenced = view('Answer:\n```json\n{"total": 10}\n```');
    expect(fenced).toMatchObject({ extraction: 'found', unfenced: false });
    expect(fenced.fence).not.toBeNull();
    expect(view('The total is {"total": 10}.')).toMatchObject({
      extraction: 'missing',
      unfenced: false,
    });
    expect(view('```json\n{"total": 10,}\n```')).toMatchObject({
      extraction: 'invalid',
      unfenced: false,
    });
  });
});
