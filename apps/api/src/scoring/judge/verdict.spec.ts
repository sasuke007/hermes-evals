import { describe, expect, it } from 'vitest';
import { JUDGE_COMMENT_MAX_CHARS, parseJudgeVerdict } from './verdict.js';

describe('parseJudgeVerdict', () => {
  it('reads a score and a comment, with surrounding whitespace or one whole-answer fence', () => {
    expect(parseJudgeVerdict(' {"score": 0.75, "comment": "Names one of two."}\n')).toEqual({
      ok: true,
      score: 0.75,
      comment: 'Names one of two.',
    });
    expect(parseJudgeVerdict('```json\n{"score": 1, "comment": "ok"}\n```')).toMatchObject({
      ok: true,
      score: 1,
    });
    expect(parseJudgeVerdict('{"score": 0, "comment": "none", "reasoning": "…"}')).toMatchObject({
      ok: true,
      score: 0,
    });
  });

  it('never extracts a verdict from prose', () => {
    const verdict = parseJudgeVerdict('Sure! {"score": 0.9, "comment": "good"}');
    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringMatching(/^The judge's answer is not JSON: "Sure!/),
    });
    expect(parseJudgeVerdict('```json\n{"score": 1, "comment": "a"}\n```\nand more')).toMatchObject(
      { ok: false },
    );
  });

  it('refuses a score that is missing, a string, or outside 0 to 1', () => {
    expect(parseJudgeVerdict('{"comment": "x"}')).toEqual({
      ok: false,
      reason: 'The judge\'s answer has no numeric score: "missing".',
    });
    expect(parseJudgeVerdict('{"score": "0.8", "comment": "x"}')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no numeric score'),
    });
    expect(parseJudgeVerdict('{"score": 1.5, "comment": "x"}')).toEqual({
      ok: false,
      reason: "The judge's score 1.5 is outside 0 to 1.",
    });
    expect(parseJudgeVerdict('{"score": -0.1, "comment": "x"}')).toMatchObject({ ok: false });
    expect(parseJudgeVerdict('{"score": 8, "comment": "out of 10"}')).toMatchObject({ ok: false });
  });

  it('refuses an answer without a comment, an array, and an empty answer', () => {
    expect(parseJudgeVerdict('{"score": 1}')).toEqual({
      ok: false,
      reason: "The judge's answer has no comment.",
    });
    expect(parseJudgeVerdict('{"score": 1, "comment": "  "}')).toMatchObject({ ok: false });
    expect(parseJudgeVerdict('[1, "x"]')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a JSON object'),
    });
    expect(parseJudgeVerdict('')).toEqual({ ok: false, reason: 'The judge gave an empty answer.' });
  });

  it('says when the answer was cut off or filtered', () => {
    expect(parseJudgeVerdict('', 'length')).toEqual({
      ok: false,
      reason: 'The judge gave no answer: it was cut off at the token limit.',
    });
    expect(parseJudgeVerdict('{"score": 0.', 'length')).toMatchObject({
      reason: expect.stringContaining('(it was cut off at the token limit)'),
    });
    expect(parseJudgeVerdict('I cannot help with that.', 'content_filter')).toMatchObject({
      reason: expect.stringContaining('content filter'),
    });
  });

  it('keeps a long comment to its first characters, on one line', () => {
    const verdict = parseJudgeVerdict(
      JSON.stringify({ score: 0.5, comment: `line one\n${'x'.repeat(JUDGE_COMMENT_MAX_CHARS)}` }),
    );
    expect(verdict.ok && verdict.comment.length).toBe(JUDGE_COMMENT_MAX_CHARS + 1);
    expect(verdict.ok && verdict.comment.startsWith('line one x')).toBe(true);
  });
});
