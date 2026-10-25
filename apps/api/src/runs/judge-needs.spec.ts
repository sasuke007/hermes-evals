/**
 * What Re-score needs from the judge (S3): the provider of the platform's
 * judge for a task's llm_judge keys, from the check's `model:` or
 * JUDGE_MODEL, on JUDGE_PROVIDER or `nous`.
 */
import { describe, expect, it } from 'vitest';
import type { VerificationEntry } from '@hermes-evals/shared';
import { judgeNeedsOf, judgeSettingsFrom } from './judge-needs.js';
import { runNeeds } from './views/config-ref.js';

const answer: VerificationEntry = {
  key: 'answer',
  type: 'exact_match',
  primary: true,
  params: { path: 'answer' },
};
const judge = (key: string, model?: string): VerificationEntry => ({
  key,
  type: 'llm_judge',
  primary: false,
  params: { rubric: 'rubric.md', ...(model === undefined ? {} : { model }) },
});

describe('judgeNeedsOf', () => {
  it('needs nothing for a task without llm_judge keys', () => {
    expect(judgeNeedsOf([answer], { provider: 'openrouter', model: 'm' })).toEqual({
      keys: [],
      judged: [],
      provider: null,
    });
  });

  it('runs every key on JUDGE_PROVIDER, the check’s model or JUDGE_MODEL', () => {
    expect(
      judgeNeedsOf([answer, judge('method'), judge('tone', 'x/y')], {
        provider: 'openrouter',
        model: 'judge/default',
      }),
    ).toEqual({ keys: ['method', 'tone'], judged: ['method', 'tone'], provider: 'openrouter' });
  });

  it('runs a check’s own model on nous when JUDGE_PROVIDER is unset', () => {
    expect(judgeNeedsOf([judge('method', 'x/y')], {})).toEqual({
      keys: ['method'],
      judged: ['method'],
      provider: 'nous',
    });
  });

  it('needs no provider when no key has a model: those keys are scored error', () => {
    expect(judgeNeedsOf([judge('method'), judge('tone', ' ')], { provider: 'custom' })).toEqual({
      keys: ['method', 'tone'],
      judged: [],
      provider: null,
    });
  });

  it('feeds the run views’ needs', () => {
    expect(runNeeds({ provider: 'custom' }, [answer, judge('method')], {})).toEqual({
      provider: 'custom',
      judgeKeys: ['method'],
      judgeProvider: null,
    });
    expect(
      runNeeds({ provider: 'custom' }, [judge('method')], { provider: 'anthropic', model: 'm' }),
    ).toEqual({ provider: 'custom', judgeKeys: ['method'], judgeProvider: 'anthropic' });
  });
});

describe('judgeSettingsFrom', () => {
  it('reads the three settings and nothing else', () => {
    const env: Record<string, string> = {
      JUDGE_PROVIDER: 'custom',
      JUDGE_MODEL: 'mock/scripted',
      JUDGE_BASE_URL: 'http://mock-model:8090/v1',
      OPENROUTER_API_KEY: 'never-read',
    };
    const asked: string[] = [];
    const settings = judgeSettingsFrom({
      get: ((key: string) => {
        asked.push(key);
        return env[key];
      }) as never,
    });
    expect(settings).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      baseUrl: 'http://mock-model:8090/v1',
    });
    expect(asked.sort()).toEqual(['JUDGE_BASE_URL', 'JUDGE_MODEL', 'JUDGE_PROVIDER']);
  });
});
