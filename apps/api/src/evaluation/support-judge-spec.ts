/**
 * An in-process JudgeClient for the evaluation specs: it records every
 * request and answers from a function, so no model is ever called (S10).
 * Not a spec itself.
 */
import type {
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
  JudgeSettings,
} from '../scoring/judge/contracts.js';

/** The judge settings of the specs: the scripted mock model, as the live check configures it. */
export const MOCK_JUDGE_SETTINGS: JudgeSettings = {
  provider: 'custom',
  model: 'mock/judge',
  baseUrl: 'http://mock-model:8090/v1',
};

/** A judge answer with plausible metering. */
export const judgeAnswer = (text: string, finishReason: string | null = 'stop'): JudgeResponse => ({
  text,
  tokens: { input: 900, output: 30, total: 930 },
  model: 'mock/judge',
  finishReason,
  calls: 1,
  latencyMs: 12,
});

/** `{"score": …, "comment": …}` as the judge is told to answer. */
export const verdictText = (score: number, comment: string): string =>
  JSON.stringify({ score, comment });

export class FakeJudge implements JudgeClient {
  readonly requests: JudgeRequest[] = [];

  constructor(
    private readonly answer: (request: JudgeRequest) => Promise<JudgeResponse> | JudgeResponse,
  ) {}

  async complete(request: JudgeRequest): Promise<JudgeResponse> {
    this.requests.push(request);
    return this.answer(request);
  }
}
