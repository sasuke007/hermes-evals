import { describe, expect, it } from 'vitest';
import type { ScorerType, VerificationEntry } from '@hermes-evals/shared';
import { verificationSentence } from './sentences.js';

const entry = (
  type: ScorerType,
  params: Record<string, unknown>,
  primary = false,
): VerificationEntry => ({ key: 'k', type, primary, params });

describe('verificationSentence', () => {
  // Every sentence the web fixtures show (apps/web/src/fixtures/suites.ts), from the same params.
  it.each([
    [
      entry('numeric_tolerance', { path: 'total_due', abs: 0.01 }),
      'numeric_tolerance on total_due, within ±0.01 of the reference',
    ],
    [
      entry('json_match', {
        path: 'duplicates',
        unordered: true,
        inner_unordered: true,
        pass_at: 1.0,
      }),
      'json_match on duplicates, unordered, pass at 1.0',
    ],
    [
      entry('json_match', { path: 'overdue', unordered: true, pass_at: 1.0 }),
      'json_match on overdue, unordered, pass at 1.0',
    ],
    [
      entry('json_match', { path: 'balances', pass_at: 1.0 }),
      'json_match on balances, pass at 1.0',
    ],
    [
      entry('trajectory_match', {
        tool: 'read_file',
        args: { path: 'invoices.csv' },
        min_calls: 1,
      }),
      'trajectory_match: calls read_file on invoices.csv at least once',
    ],
    [
      entry('trajectory_match', { tool: 'invoice-db.list_invoices', min_calls: 1 }),
      'trajectory_match: calls invoice-db.list_invoices at least once',
    ],
    [
      entry('llm_judge', { rubric: 'credit_method.md', pass_at: 0.7 }),
      'llm_judge with rubric credit_method.md, pass at score ≥ 0.7',
    ],
    [
      entry('exact_match', { path: 'missing_po', trim: true, case_sensitive: true }),
      'exact_match on missing_po, whitespace trimmed, case-sensitive',
    ],
    [
      entry('verifier_script', { script: 'check_late_fees.py', timeout_s: 30, pass_at: 1.0 }),
      'verifier_script check_late_fees.py returns score ≥ 1.0, timeout 30 s',
    ],
  ])('%# matches the fixture sentence', (e, sentence) => {
    expect(verificationSentence(e)).toBe(sentence);
  });

  it('states the defaults the scorer applies', () => {
    expect(verificationSentence(entry('exact_match', { path: 'po' }))).toBe(
      'exact_match on po, whitespace trimmed, case-sensitive',
    );
    expect(verificationSentence(entry('json_match', {}))).toBe(
      'json_match on the whole answer, pass at 1.0',
    );
    expect(verificationSentence(entry('verifier_script', { script: 'check.py' }))).toBe(
      'verifier_script check.py returns score ≥ 1.0, timeout 30 s',
    );
    expect(verificationSentence(entry('llm_judge', { rubric: 'r.md' }))).toBe(
      'llm_judge with rubric r.md, pass at score ≥ 0.7',
    );
    expect(verificationSentence(entry('trajectory_match', { tool: 'search' }))).toBe(
      'trajectory_match: calls search at least once',
    );
  });

  it('states what text_match looks for', () => {
    expect(
      verificationSentence(entry('text_match', { path: 'rule', contains: ['1.5%', '30 days'] })),
    ).toBe('text_match on rule, contains "1.5%", "30 days"');
    expect(
      verificationSentence(
        entry('text_match', { pattern: '^net \\d+$', case_sensitive: true, pass_at: 0.5 }, true),
        'terms',
      ),
    ).toBe('text_match on terms, matches /^net \\d+$/, case-sensitive, pass at 0.5');
  });

  it('uses answer.path for the primary entry only', () => {
    expect(verificationSentence(entry('numeric_tolerance', { abs: 0.5 }, true), 'total')).toBe(
      'numeric_tolerance on total, within ±0.5 of the reference',
    );
    expect(verificationSentence(entry('numeric_tolerance', { abs: 0.5 }), 'total')).toBe(
      'numeric_tolerance on the whole answer, within ±0.5 of the reference',
    );
  });

  it('spells out the other options', () => {
    expect(verificationSentence(entry('numeric_tolerance', { path: 'x', rel: 0.05 }))).toBe(
      'numeric_tolerance on x, within ±5% of the reference',
    );
    expect(verificationSentence(entry('numeric_tolerance', { path: 'x', abs: 1, rel: 0.07 }))).toBe(
      'numeric_tolerance on x, within ±1 or ±7% of the reference',
    );
    expect(verificationSentence(entry('numeric_tolerance', { path: 'x' }))).toBe(
      'numeric_tolerance on x, equal to the reference',
    );
    expect(
      verificationSentence(
        entry('json_match', {
          path: 'p',
          inner_unordered: true,
          exclude_keys: ['id', 'at'],
          pass_at: 0.75,
        }),
      ),
    ).toBe('json_match on p, inner lists unordered, ignoring id, at, pass at 0.75');
    expect(
      verificationSentence(entry('exact_match', { path: 'p', trim: false, case_sensitive: false })),
    ).toBe('exact_match on p, whitespace kept, case-insensitive');
    expect(
      verificationSentence(entry('llm_judge', { rubric: 'r.md', pass_at: 0.8, model: 'judge-1' })),
    ).toBe('llm_judge with rubric r.md, pass at score ≥ 0.8, judged by judge-1');
  });

  it('describes call counts and full-trajectory modes', () => {
    const t = (params: Record<string, unknown>) =>
      verificationSentence(entry('trajectory_match', { tool: 'run', ...params }));
    expect(t({ min_calls: 0 })).toBe('trajectory_match: calls run any number of times');
    expect(t({ min_calls: 2 })).toBe('trajectory_match: calls run at least 2 times');
    expect(t({ min_calls: 1, max_calls: 1 })).toBe('trajectory_match: calls run exactly once');
    expect(t({ min_calls: 0, max_calls: 3 })).toBe('trajectory_match: calls run at most 3 times');
    expect(t({ min_calls: 2, max_calls: 4 })).toBe(
      'trajectory_match: calls run between 2 and 4 times',
    );
    expect(t({ min_calls: 0, max_calls: 0 })).toBe('trajectory_match: never calls run');
    expect(t({ args: { q: 'x', n: 2 } })).toBe(
      'trajectory_match: calls run with q: "x", n: 2 at least once',
    );
    expect(t({ mode: 'superset' })).toBe(
      'trajectory_match: calls to run match the trajectory (superset mode)',
    );
  });

  it('describes file checks', () => {
    expect(
      verificationSentence(
        entry('file_check', {
          path: 'summary.csv',
          must_exist: true,
          format: 'csv',
          columns: ['vendor', 'outstanding'],
          row_count: 5,
        }),
      ),
    ).toBe('file_check: summary.csv exists with columns vendor, outstanding; 5 rows');
    expect(
      verificationSentence(entry('file_check', { path: 'a.csv', format: 'csv', row_count: 1 })),
    ).toBe('file_check: a.csv exists as CSV; 1 row');
    expect(
      verificationSentence(
        entry('file_check', { path: 'out.json', format: 'json', json_schema: {} }),
      ),
    ).toBe('file_check: out.json exists as JSON matching its schema');
    expect(
      verificationSentence(
        entry('file_check', { path: 'notes.md', must_exist: false, contains: ['Total', 'EUR'] }),
      ),
    ).toBe('file_check: notes.md (optional); contains "Total", "EUR"');
    expect(verificationSentence(entry('file_check', { path: 'log.txt', format: 'text' }))).toBe(
      'file_check: log.txt exists as text',
    );
    expect(
      verificationSentence(
        entry('file_check', { root: 'home', path: 'memories/USER.md', contains: ['EUR'] }),
      ),
    ).toBe('file_check: memories/USER.md in the home exists; contains "EUR"');
  });

  it('says so when params do not validate', () => {
    expect(verificationSentence(entry('json_match', { pass_at: 2 }))).toBe(
      'json_match · params are not valid',
    );
    expect(verificationSentence(entry('verifier_script', {}))).toBe(
      'verifier_script · params are not valid',
    );
  });
});
