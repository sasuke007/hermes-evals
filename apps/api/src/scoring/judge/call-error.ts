/**
 * A judge request that failed after reaching egress: a JudgeError that also
 * says how many calls were made and how long they took, so the score's
 * evidence still records the grading cost of a call that billed and then
 * failed. Its own file, so the scorer (llm-judge.ts) can recognise it
 * without importing the egress client and its dependencies.
 */
import {
  JudgeError,
  type JudgeCallRecord,
  type JudgeErrorKind,
  type JudgeTokens,
} from './contracts.js';

export class JudgeCallError extends JudgeError {
  constructor(
    kind: JudgeErrorKind,
    message: string,
    status: number | null,
    tokens: JudgeTokens,
    /** Calls made: 1, or 2 when the first failed in transport or with a 5xx. */
    readonly calls: number,
    /** Wall time of the request, retry included. */
    readonly latencyMs: number,
    /** Each call in order, one per call made. */
    readonly callLog: readonly JudgeCallRecord[],
  ) {
    super(kind, message, status, tokens);
  }
}
