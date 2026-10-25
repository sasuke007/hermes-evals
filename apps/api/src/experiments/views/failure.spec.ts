import { describe, expect, it } from 'vitest';
import type { ExperimentFailure } from '@hermes-evals/shared';
import { firstLine } from '../../execution/lifecycle/first-line.js';
import { identicalIn } from './failure.js';
import type { ErrorRunFacts } from './queries.js';

const failureWith = (stderrTail: string): ExperimentFailure => ({
  at: '2026-10-25T09:00:00.000Z',
  threshold: 14,
  category: 'setup',
  exit_code: 1,
  message: 'Hermes exited with code 1 before it started the run',
  // As finish.ts records it from the tripping attempt.
  stderr_first_line: firstLine(stderrTail),
  attempt_id: 'A',
  run_id: 'R',
});

const runs = (n: number, stderrTail: string): ErrorRunFacts[] =>
  Array.from({ length: n }, (_, i) => ({
    experimentId: 'E',
    runId: `R${i}`,
    category: 'setup',
    errorMessage: 'failed',
    stderrTail,
  }));

describe('identicalIn', () => {
  it('counts every run with a first stderr line longer than the 500 characters stored', () => {
    const tail = `{"level":"error","msg":"${'x'.repeat(600)}"}\nTraceback (most recent call last):`;
    const failure = failureWith(tail);
    expect(failure.stderr_first_line).toHaveLength(500);
    expect(identicalIn(failure, runs(14, tail))).toBe(14);
  });

  it('compares like with like when the cut ends in whitespace', () => {
    const tail = `${'a'.repeat(498)}  ${'b'.repeat(20)}\nmore`;
    const failure = { ...failureWith(tail), stderr_first_line: `${'a'.repeat(498)}  ` };
    expect(identicalIn(failure, runs(3, tail))).toBe(3);
  });

  it("skips Hermes's session banner, which differs in every run", () => {
    // A run that printed a result has only the banner on stderr: compared on it, every
    // such failure was "in 1 of N runs".
    const banner = (i: number) => `Session: local-${i}abc\nsession_id: local-${i}abc`;
    expect(firstLine(banner(1))).toBeNull();
    expect(firstLine(`${banner(2)}\nTraceback (most recent call last):`)).toBe(
      'Traceback (most recent call last):',
    );
    const failure = failureWith(banner(0));
    expect(failure.stderr_first_line).toBeNull();
    const facts = [0, 1, 2].map((i) => ({ ...runs(1, banner(i))[0]!, runId: `R${i}` }));
    expect(identicalIn(failure, facts)).toBe(3);
    // A line that only looks like it is kept.
    expect(firstLine('Session: expired, log in again')).toBe('Session: expired, log in again');
  });

  it('falls back to the category without a stderr line, and tells different lines apart', () => {
    const failure = { ...failureWith(''), stderr_first_line: null };
    expect(identicalIn(failure, runs(2, 'anything'))).toBe(2);
    const other = failureWith('boom: one thing');
    expect(identicalIn(other, [...runs(2, 'boom: one thing'), ...runs(3, 'boom: another')])).toBe(
      2,
    );
  });
});
