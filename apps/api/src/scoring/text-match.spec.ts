import { ScoreEvidenceSchema, type JsonValue } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { scoreAnswer, scoreReferenceAsAnswer, type AnswerKey } from './answer.js';
import { extractAnswer } from './extraction.js';
import { parseScorerParams } from './registry.js';
import {
  capText,
  compileTextPattern,
  MAX_TEXT_MATCH_BYTES,
  PATTERN_TIMEOUT_MS,
  scoreTextMatch,
  testPattern,
} from './text-match.js';

/** Params through the registry's strict schema, as the loader stores them. */
function params(written: Record<string, unknown>) {
  const parsed = parseScorerParams('text_match', written);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

const key = (written: Record<string, unknown>): AnswerKey => ({
  type: 'text_match',
  params: params(written),
});

const block = (value: unknown) => `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

/** DESIGN_CHECKS_FIX_PROMPT.md Part F's sample task `late_fee_rule`. */
const LATE_FEE = {
  reference: {
    rule: 'Invoices unpaid 30 days after the due date are charged a late fee of 1.5% per month.',
  },
  key: key({ path: 'rule', contains: ['1.5%', '30 days'] }),
};

describe('text_match on Part F sample', () => {
  it('passes the reference itself (the self-check)', () => {
    const result = scoreReferenceAsAnswer(LATE_FEE.key, LATE_FEE.reference);
    expect(result).toMatchObject({ status: 'passed', score: 1 });
    expect(result.comment).toBe('found 2 of 2: "1.5%" ✓ "30 days" ✓');
  });

  it('scores the share found and fails below pass_at', () => {
    const reply = extractAnswer(block({ rule: 'A late fee of 1.5% per month applies.' }));
    const result = scoreAnswer(LATE_FEE.key, reply, LATE_FEE.reference);
    expect(result).toMatchObject({ status: 'failed', score: 0.5 });
    expect(result.comment).toBe('found 1 of 2: "1.5%" ✓ "30 days" ✗');
    expect(result.evidence).toEqual({
      text: {
        items: [
          { kind: 'phrase', label: '1.5%', found: true },
          { kind: 'phrase', label: '30 days', found: false },
        ],
        truncated: false,
      },
    });
    expect(ScoreEvidenceSchema.parse(result.evidence)).toEqual(result.evidence);
    expect(result.expected).toEqual({ contains: ['1.5%', '30 days'] });
    expect(result.observed).toBe('A late fee of 1.5% per month applies.');
  });

  it('passes at or above a lower pass_at', () => {
    const half = key({ path: 'rule', contains: ['1.5%', '30 days'], pass_at: 0.5 });
    const reply = extractAnswer(block({ rule: 'A late fee of 1.5% per month applies.' }));
    expect(scoreAnswer(half, reply, LATE_FEE.reference)).toMatchObject({
      status: 'passed',
      score: 0.5,
    });
  });

  it('is ungradable without an answer block, never a zero', () => {
    const result = scoreAnswer(LATE_FEE.key, extractAnswer('No JSON here.'), LATE_FEE.reference);
    expect(result).toMatchObject({ status: 'ungradable', score: null });
  });

  it('fails an answer without the path and errors a reference without it', () => {
    const noRule = scoreAnswer(LATE_FEE.key, extractAnswer(block({ fee: 1 })), LATE_FEE.reference);
    expect(noRule).toMatchObject({ status: 'failed', score: 0 });
    expect(noRule.comment).toBe('the answer has no value at rule');
    const broken = scoreReferenceAsAnswer(LATE_FEE.key, { fee: 1 });
    expect(broken).toMatchObject({ status: 'error', score: null });
  });
});

describe('scoreTextMatch', () => {
  it('ignores case by default and honours case_sensitive', () => {
    const text = 'Charged a LATE FEE of 1.5%';
    expect(scoreTextMatch(text, params({ contains: ['late fee'] })).status).toBe('passed');
    expect(
      scoreTextMatch(text, params({ contains: ['late fee'], case_sensitive: true })).status,
    ).toBe('failed');
    expect(scoreTextMatch(text, params({ pattern: 'late\\s+fee' })).status).toBe('passed');
    expect(
      scoreTextMatch(text, params({ pattern: 'late\\s+fee', case_sensitive: true })).status,
    ).toBe('failed');
  });

  it('counts each phrase and the pattern once', () => {
    const result = scoreTextMatch(
      'fee: 1.5% after 30 days',
      params({
        contains: ['1.5%', 'monthly', '30 days'],
        pattern: '\\d+(\\.\\d+)?%',
        pass_at: 0.75,
      }),
    );
    expect(result).toMatchObject({ status: 'passed', score: 0.75 });
    expect(result.evidence?.text?.items).toEqual([
      { kind: 'phrase', label: '1.5%', found: true },
      { kind: 'phrase', label: 'monthly', found: false },
      { kind: 'phrase', label: '30 days', found: true },
      { kind: 'pattern', label: '\\d+(\\.\\d+)?%', found: true },
    ]);
    expect(result.comment).toBe(
      'found 3 of 4: "1.5%" ✓ "monthly" ✗ "30 days" ✓ /\\d+(\\.\\d+)?%/ ✓',
    );
    expect(result.expected).toEqual({
      contains: ['1.5%', 'monthly', '30 days'],
      pattern: '\\d+(\\.\\d+)?%',
    });
  });

  it('rounds the share so the stored score and status agree', () => {
    const result = scoreTextMatch('a', params({ contains: ['a', 'b', 'c'], pass_at: 0.333333 }));
    expect(result).toMatchObject({ status: 'passed', score: 0.333333 });
  });

  it('matches the pattern anywhere, with ^ and $ at the ends of the whole text', () => {
    const text = 'line one\nTotal: 42\nline three';
    expect(scoreTextMatch(text, params({ pattern: 'Total: \\d+' })).status).toBe('passed');
    expect(scoreTextMatch(text, params({ pattern: '^Total' })).status).toBe('failed');
    expect(scoreTextMatch(text, params({ pattern: '^line one' })).status).toBe('passed');
  });

  it('matches a value that is not a string as its JSON text', () => {
    expect(
      scoreTextMatch({ fee: 1.5, unit: '%' }, params({ contains: ['"fee":1.5'] })).status,
    ).toBe('passed');
    expect(scoreTextMatch(1042, params({ contains: ['1042'] })).status).toBe('passed');
    expect(scoreTextMatch(['INV-1', 'INV-2'], params({ pattern: '"INV-2"\\]$' })).status).toBe(
      'passed',
    );
    expect(scoreTextMatch(null, params({ contains: ['null'] })).status).toBe('passed');
    expect(scoreTextMatch(true, params({ contains: ['TRUE'] })).status).toBe('passed');
  });

  it('matches Unicode text, the pattern in u mode', () => {
    const text = 'Frais de retard : 1,5 % — après 30 jours ✓';
    expect(scoreTextMatch(text, params({ contains: ['APRÈS 30 JOURS'] })).status).toBe('passed');
    expect(scoreTextMatch(text, params({ pattern: '\\p{Letter}+ de retard' })).status).toBe(
      'passed',
    );
    expect(scoreTextMatch('😀x', params({ pattern: '^.x$' })).status).toBe('passed');
  });

  it('searches only the first 64 KB, and says so', () => {
    const padding = 'x'.repeat(MAX_TEXT_MATCH_BYTES);
    const result = scoreTextMatch(`${padding}needle`, params({ contains: ['needle', 'x'] }));
    expect(result).toMatchObject({ status: 'failed', score: 0.5 });
    expect(result.evidence?.text?.truncated).toBe(true);
    expect(result.comment).toMatch(/\(only the first 64 KB were searched\)$/);
    const fits = scoreTextMatch(
      `${'x'.repeat(MAX_TEXT_MATCH_BYTES - 6)}needle`,
      params({ contains: ['needle'] }),
    );
    expect(fits).toMatchObject({ status: 'passed' });
    expect(fits.evidence?.text?.truncated).toBe(false);
  });

  it('cuts the text at a character boundary, never inside one', () => {
    // 'é' is 2 bytes in UTF-8: one byte of room left cuts before it, not through it.
    const text = `${'a'.repeat(MAX_TEXT_MATCH_BYTES - 1)}éz`;
    const cut = capText(text);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('a'.repeat(MAX_TEXT_MATCH_BYTES - 1));
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_MATCH_BYTES);
    const emoji = capText('😀'.repeat(MAX_TEXT_MATCH_BYTES / 4 + 1));
    expect(emoji.text).toBe('😀'.repeat(MAX_TEXT_MATCH_BYTES / 4));
    expect(capText('short')).toEqual({ text: 'short', truncated: false });
  });

  it('stops a pattern that backtracks catastrophically and makes the key an error', () => {
    const evil = params({ pattern: '^(a+)+$' });
    const started = performance.now();
    const result = scoreTextMatch(`${'a'.repeat(40)}!`, evil);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ status: 'error', score: null });
    expect(result.comment).toMatch(/^the pattern took longer than 1 s on the answer's text/);
    expect(result.evidence?.error?.detail).toBe('pattern /^(a+)+$/ on 41 bytes');
    expect(elapsed).toBeGreaterThanOrEqual(PATTERN_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(PATTERN_TIMEOUT_MS + 2_000);
    // The same pattern is harmless where it does not backtrack.
    expect(scoreTextMatch('a'.repeat(40), evil).status).toBe('passed');
  });

  it('gives testPattern the time limit it is asked for', () => {
    const regex = compileTextPattern('(x+x+)+y', true);
    if (!regex.ok) throw new Error(regex.message);
    expect(testPattern(regex.regex, 'x'.repeat(40), 50)).toBeNull();
    expect(testPattern(regex.regex, 'xxy', 50)).toBe(true);
  });

  it('errors on a pattern that does not compile, a row the loader would refuse', () => {
    const result = scoreTextMatch('text', { case_sensitive: false, pass_at: 1, pattern: '(abc' });
    expect(result).toMatchObject({
      status: 'error',
      score: null,
      comment: 'The pattern is not valid: unterminated group.',
    });
  });

  it('errors on params with neither a phrase nor a pattern, a row the schema would refuse', () => {
    expect(scoreTextMatch('text', { case_sensitive: false, pass_at: 1 }).status).toBe('error');
  });
});

describe('compileTextPattern', () => {
  it('compiles with u, and i unless case-sensitive', () => {
    const insensitive = compileTextPattern('fee', false);
    const sensitive = compileTextPattern('fee', true);
    expect(insensitive.ok && insensitive.regex.flags).toBe('iu');
    expect(sensitive.ok && sensitive.regex.flags).toBe('u');
  });

  it.each([
    ['(abc', 'The pattern is not valid: unterminated group.'],
    ['a{2,1}', 'The pattern is not valid: numbers out of order in {} quantifier.'],
    ['[z-a]', 'The pattern is not valid: range out of order in character class.'],
    // u mode refuses escapes that mean nothing, which plain mode would read as the letter.
    ['\\-', 'The pattern is not valid: invalid escape.'],
    ['*fee', 'The pattern is not valid: nothing to repeat.'],
  ])('reports %s in the editor words', (pattern, message) => {
    expect(compileTextPattern(pattern, false)).toEqual({ ok: false, message });
  });

  it('never throws', () => {
    for (const pattern of ['(', ')', '[', '\\', '(?<a>x)(?<a>y)', 'a**']) {
      expect(() => compileTextPattern(pattern, true)).not.toThrow();
    }
  });
});

describe('text_match params', () => {
  it('needs a phrase or a pattern, in the editor words', () => {
    const parsed = parseScorerParams('text_match', { contains: [] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('Add at least one phrase or a pattern.');
  });

  it('defaults case_sensitive to false and pass_at to 1', () => {
    expect(params({ contains: ['a'] })).toEqual({
      contains: ['a'],
      case_sensitive: false,
      pass_at: 1,
    });
  });
});

/** Every result of this file parses as stored score evidence. */
it('writes evidence the shared schema accepts', () => {
  const values: JsonValue[] = ['a', { a: 1 }, 'x'.repeat(MAX_TEXT_MATCH_BYTES + 10)];
  for (const value of values) {
    const result = scoreTextMatch(value, params({ contains: ['a'], pattern: 'x' }));
    expect(ScoreEvidenceSchema.safeParse(result.evidence).success).toBe(true);
  }
});
