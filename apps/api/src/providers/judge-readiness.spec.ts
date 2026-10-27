import { describe, expect, it } from 'vitest';
import type { Provider, VerificationEntry } from '@hermes-evals/shared';
import { validateEnv } from '../config/env.js';
import { judgeSettingsOf } from '../scoring/judge/contracts.js';
import { judgeReadiness, namedKeys, noJudgeModelReason } from './judge-readiness.js';
import type { ProviderReadiness } from './readiness.js';

const entry = (type: VerificationEntry['type'], params: Record<string, unknown> = {}) => ({
  type,
  params,
});

const tasks = [
  {
    verification: [
      entry('json_match', { pass_at: 1 }),
      entry('llm_judge', { rubric: 'rubric.md' }),
    ],
  },
  { verification: [entry('exact_match')] },
];

/** A readiness answer per provider, recording what was asked. */
function readinessOf(answers: Partial<Record<Provider, ProviderReadiness | Error>>) {
  const asked: Provider[] = [];
  return {
    asked,
    deps: {
      readiness: async (provider: Provider): Promise<ProviderReadiness> => {
        asked.push(provider);
        const answer = answers[provider];
        if (answer instanceof Error) throw answer;
        return answer ?? { ready: true, status: 'configured', reason: null };
      },
    },
  };
}

const NOT_CONNECTED: ProviderReadiness = {
  ready: false,
  status: 'not_connected',
  reason: 'Nous Portal is not connected.',
};

describe('judgeReadiness', () => {
  it('is ready without asking anyone when no task has an llm_judge key', async () => {
    const { asked, deps } = readinessOf({ nous: NOT_CONNECTED });
    expect(
      await judgeReadiness([entry('json_match'), entry('trajectory_match')], { model: 'm' }, deps),
    ).toEqual({ ready: true, reason: null, provider: null, judgeKeys: 0, unconfigured: 0 });
    expect(asked).toEqual([]);
  });

  it('refuses with the provider’s reason when the judge’s provider is not ready', async () => {
    const { asked, deps } = readinessOf({ nous: NOT_CONNECTED });
    const result = await judgeReadiness(
      tasks.flatMap((t) => t.verification),
      { provider: 'nous', model: 'openai/gpt-6.1-sol' },
      deps,
    );
    expect(result).toEqual({
      ready: false,
      reason: "The LLM judge's provider is not ready: Nous Portal is not connected.",
      provider: 'nous',
      judgeKeys: 1,
      unconfigured: 0,
    });
    expect(asked).toEqual(['nous']);
  });

  it('asks once for many keys, on JUDGE_PROVIDER, and on nous when it is unset', async () => {
    const many = [
      entry('llm_judge', { rubric: 'a.md' }),
      entry('llm_judge', { rubric: 'b.md', model: 'judge/strict' }),
    ];
    const keyed = readinessOf({});
    expect(
      await judgeReadiness(many, { provider: 'openrouter', model: 'judge/default' }, keyed.deps),
    ).toMatchObject({ ready: true, provider: 'openrouter', judgeKeys: 2 });
    expect(keyed.asked).toEqual(['openrouter']);
    const unset = readinessOf({ nous: NOT_CONNECTED });
    expect(await judgeReadiness([many[1]!], {}, unset.deps)).toMatchObject({
      ready: false,
      provider: 'nous',
    });
  });

  it('blocks keys that have no judge model, with the fix, before asking any provider', async () => {
    const { asked, deps } = readinessOf({ nous: NOT_CONNECTED });
    expect(
      await judgeReadiness(
        [{ ...entry('llm_judge', { rubric: 'r.md' }), key: 'tone', task: 'late_fees' }],
        { provider: 'nous' },
        deps,
      ),
    ).toEqual({
      ready: false,
      reason:
        'The LLM judge has no model for late_fees.tone: set JUDGE_MODEL (and JUDGE_PROVIDER, nous when unset) in .env, then docker compose up -d api worker, or give the check its own model: in task.yaml.',
      provider: null,
      judgeKeys: 1,
      unconfigured: 1,
    });
    expect(asked).toEqual([]);
    // One key with a model does not lift the refusal for the other.
    const mixed = await judgeReadiness(
      [
        { ...entry('llm_judge', { rubric: 'a.md', model: 'judge/strict' }), key: 'method' },
        { ...entry('llm_judge', { rubric: 'b.md', model: '  ' }), key: 'tone' },
      ],
      { provider: 'nous' },
      deps,
    );
    expect(mixed).toMatchObject({ ready: false, provider: 'nous', judgeKeys: 2, unconfigured: 1 });
    expect(mixed.reason).toMatch(/^The LLM judge has no model for tone: /);
    expect(asked).toEqual([]);
  });

  it("refuses, as with no model, when .env sets only JUDGE_PROVIDER beside Compose's mock defaults", async () => {
    // JUDGE_PROVIDER=openrouter in .env; Compose still passes the mock's model and base URL.
    // env.ts reads mock/scripted beside a real provider as unset, so the launch answers 409
    // instead of sending every judge call to OpenRouter with a model it does not have.
    const env = validateEnv({
      JUDGE_PROVIDER: 'openrouter',
      JUDGE_MODEL: 'mock/scripted',
      JUDGE_BASE_URL: 'http://mock-model:8090/v1',
    });
    const { asked, deps } = readinessOf({});
    expect(
      await judgeReadiness(
        [{ ...entry('llm_judge', { rubric: 'r.md' }), key: 'disputed', task: 'inv_007' }],
        judgeSettingsOf(env),
        deps,
      ),
    ).toEqual({
      ready: false,
      reason: noJudgeModelReason(['inv_007.disputed']),
      provider: null,
      judgeKeys: 1,
      unconfigured: 1,
    });
    expect(asked).toEqual([]);
  });

  it('names at most five keys, and counts the rest', () => {
    expect(namedKeys(['a'])).toBe('a');
    expect(namedKeys(['a', 'b'])).toBe('a and b');
    expect(namedKeys(['a', 'b', 'c'])).toBe('a, b and c');
    expect(namedKeys(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and 2 more');
  });

  it('counts a check that cannot be answered as not ready, with why', async () => {
    const { deps } = readinessOf({ openrouter: new Error('no worker is connected') });
    expect(
      await judgeReadiness(tasks[0]!.verification, { provider: 'openrouter', model: 'm' }, deps),
    ).toMatchObject({
      ready: false,
      reason:
        "Whether the LLM judge's provider (openrouter) is ready could not be checked: no worker is connected",
    });
  });
});
