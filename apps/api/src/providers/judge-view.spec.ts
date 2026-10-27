/**
 * The judge as the pages see it (Phase 8 G2): JUDGE_PROVIDER (nous when
 * unset), JUDGE_MODEL, whether the route is the scripted mock model, and
 * whether the model is the mock's name on a route that is not the mock.
 */
import { describe, expect, it } from 'vitest';
import { JudgeViewSchema, MOCK_MODEL_BASE_URL, MOCK_MODEL_NAME } from '@hermes-evals/shared';
import { validateEnv } from '../config/env.js';
import { judgeSettingsOf } from '../scoring/judge/contracts.js';
import { hasLlmJudge, judgeView, judgeViewFrom } from './judge-view.js';

describe('judgeView', () => {
  it('is nous with no model and not the mock when nothing is set', () => {
    expect(JudgeViewSchema.parse(judgeView({}))).toEqual({
      provider: 'nous',
      model: null,
      mock: false,
      mockModelName: false,
    });
  });

  it("is the mock for Compose's default: custom on the mock model's base URL", () => {
    expect(
      judgeView({ provider: 'custom', model: MOCK_MODEL_NAME, baseUrl: MOCK_MODEL_BASE_URL }),
    ).toEqual({ provider: 'custom', model: 'mock/scripted', mock: true, mockModelName: false });
  });

  it('is a real judge on any other route, whatever the model is called', () => {
    expect(
      judgeView({ provider: 'custom', model: 'qwen/judge', baseUrl: 'http://vllm:8000/v1' }),
    ).toMatchObject({ mock: false, mockModelName: false });
    expect(judgeView({ provider: 'openrouter', model: 'openai/gpt-6.1-sol' })).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-6.1-sol',
      mock: false,
      mockModelName: false,
    });
    // A base URL only counts for custom (env.ts allows it only there anyway).
    expect(judgeView({ provider: 'nous', baseUrl: MOCK_MODEL_BASE_URL }).mock).toBe(false);
  });

  it("flags the mock's model name on a custom route that is not the mock, and keeps it", () => {
    // JUDGE_PROVIDER=custom and a real JUDGE_BASE_URL in .env; Compose still gives mock/scripted.
    const env = validateEnv({
      JUDGE_PROVIDER: 'custom',
      JUDGE_MODEL: MOCK_MODEL_NAME,
      JUDGE_BASE_URL: 'https://judge.example.com/v1',
    });
    expect(judgeView(judgeSettingsOf(env))).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: false,
      mockModelName: true,
    });
    // A mock reached at another host, as in development outside Compose, is flagged too.
    expect(
      judgeView({
        provider: 'custom',
        model: ' mock/scripted ',
        baseUrl: 'http://localhost:8090/v1',
      }).mockModelName,
    ).toBe(true);
  });

  it('shows a blank model as none, as resolveJudgeModel reads it', () => {
    expect(judgeView({ model: '  ' }).model).toBeNull();
    expect(judgeView({ model: ' judge/model ' }).model).toBe('judge/model');
  });

  it("reads the process's settings through ConfigService", () => {
    const env: Record<string, string> = {
      JUDGE_PROVIDER: 'custom',
      JUDGE_MODEL: 'mock/scripted',
      JUDGE_BASE_URL: 'http://mock-model:8090/v1',
    };
    const config = { get: (key: string) => env[key] } as Parameters<typeof judgeViewFrom>[0];
    expect(judgeViewFrom(config)).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: true,
      mockModelName: false,
    });
  });
});

describe('hasLlmJudge', () => {
  it('is true exactly when some key is an llm_judge', () => {
    expect(hasLlmJudge([{ type: 'exact_match' }, { type: 'llm_judge' }])).toBe(true);
    expect(hasLlmJudge([{ type: 'exact_match' }, { type: 'verifier_script' }])).toBe(false);
    expect(hasLlmJudge([])).toBe(false);
  });
});
