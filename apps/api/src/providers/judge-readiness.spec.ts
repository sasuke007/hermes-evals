import { describe, expect, it } from 'vitest';
import type { Provider, VerificationEntry } from '@hermes-evals/shared';
import { judgeReadiness } from './judge-readiness.js';
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

  it('does not block keys that have no judge model, and counts them', async () => {
    const { asked, deps } = readinessOf({ nous: NOT_CONNECTED });
    expect(
      await judgeReadiness([entry('llm_judge', { rubric: 'r.md' })], { provider: 'nous' }, deps),
    ).toEqual({ ready: true, reason: null, provider: null, judgeKeys: 1, unconfigured: 1 });
    expect(asked).toEqual([]);
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
