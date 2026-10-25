import { describe, expect, it } from 'vitest';
import { validateEnv } from '../../config/env.js';
import {
  DEFAULT_JUDGE_PROVIDER,
  JudgeError,
  judgeSettingsOf,
  NO_JUDGE_MODEL_MESSAGE,
  resolveJudgeModel,
} from './contracts.js';

describe('resolveJudgeModel (S3)', () => {
  it('takes the check’s model before the platform default, on JUDGE_PROVIDER', () => {
    const settings = { provider: 'openrouter' as const, model: 'judge/default' };
    expect(resolveJudgeModel({ model: 'judge/strict' }, settings)).toEqual({
      provider: 'openrouter',
      model: 'judge/strict',
      baseUrl: null,
      source: 'check',
    });
    expect(resolveJudgeModel({}, settings)).toEqual({
      provider: 'openrouter',
      model: 'judge/default',
      baseUrl: null,
      source: 'settings',
    });
  });

  it('runs a check’s model on nous when JUDGE_PROVIDER is unset', () => {
    expect(DEFAULT_JUDGE_PROVIDER).toBe('nous');
    expect(resolveJudgeModel({ model: 'openai/gpt-6.1-sol' }, {})).toEqual({
      provider: 'nous',
      model: 'openai/gpt-6.1-sol',
      baseUrl: null,
      source: 'check',
    });
  });

  it('gives a custom judge its base URL, and no other provider one', () => {
    const custom = judgeSettingsOf(
      validateEnv({
        JUDGE_PROVIDER: 'custom',
        JUDGE_MODEL: 'mock/scripted',
        JUDGE_BASE_URL: 'http://mock-model:8090/v1',
      }),
    );
    expect(resolveJudgeModel({}, custom)).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      baseUrl: 'http://mock-model:8090/v1',
      source: 'settings',
    });
    expect(
      resolveJudgeModel({}, { provider: 'nous', model: 'm', baseUrl: 'http://stray:1/v1' }),
    ).toMatchObject({ baseUrl: null });
  });

  it('is null when neither names a model, blank names included', () => {
    expect(resolveJudgeModel({}, {})).toBeNull();
    expect(resolveJudgeModel({}, { provider: 'nous' })).toBeNull();
    expect(resolveJudgeModel({ model: '  ' }, { model: '' })).toBeNull();
    expect(resolveJudgeModel({}, judgeSettingsOf(validateEnv({ JUDGE_MODEL: '' })))).toBeNull();
    expect(NO_JUDGE_MODEL_MESSAGE).toBe(
      'No judge model is configured (set JUDGE_PROVIDER and JUDGE_MODEL, or model: in the check)',
    );
  });
});

describe('JudgeError', () => {
  it('carries its kind, the status and the tokens already used', () => {
    const plain = new JudgeError('timeout', 'no answer within 60 s');
    expect(plain).toBeInstanceOf(Error);
    expect([plain.name, plain.kind, plain.status, plain.tokens.total]).toEqual([
      'JudgeError',
      'timeout',
      null,
      0,
    ]);
    const billed = new JudgeError('transport', 'upstream answered 502', 502, {
      input: 10,
      output: 0,
      total: 10,
    });
    expect([billed.status, billed.tokens.total]).toEqual([502, 10]);
  });
});
