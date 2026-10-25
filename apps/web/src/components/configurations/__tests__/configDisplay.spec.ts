import { describe, expect, it } from 'vitest';
import type { ConfigurationUsage } from '@/api/types/configurations';
import {
  joinSeries,
  modelHelp,
  usageRate,
  usageVerdict,
} from '@/components/configurations/configDisplay';
import { formOptionsFixture } from '@/fixtures/configurations';

const usage = (over: Partial<ConfigurationUsage>): ConfigurationUsage => ({
  experimentId: 'exp_1',
  experimentName: 'Skill vs no skill, invoices-v1',
  role: 'candidate',
  status: 'completed',
  version: 1,
  repetitions: 5,
  passRate: 0.85,
  scored: 60,
  total: 60,
  verdict: 'better',
  verdictReason: null,
  baselinePassRate: 0.633,
  ...over,
});

describe('configuration display rules', () => {
  it('joins experiment names into a sentence', () => {
    expect(joinSeries(['A, x'])).toBe('A, x');
    expect(joinSeries(['A, x', 'B'])).toBe('A, x and B');
    expect(joinSeries(['A, x', 'B, y', 'C'])).toBe('A, x; B, y; and C');
  });

  it('prices a known model and warns about an unknown one', () => {
    const { models } = formOptionsFixture(false);
    expect(modelHelp('', models)).toEqual({
      text: 'Pick a known model or type any model id.',
      warning: false,
    });
    expect(modelHelp(' openai/gpt-6.1-sol ', models)).toEqual({
      text: '$0.60 in / $2.40 out per 1M tokens',
      warning: false,
    });
    expect(modelHelp('anthropic/claude-5.1-sonnet', models)).toEqual({
      text: 'Not in the price table; cost estimates will be unavailable',
      warning: true,
    });
  });

  it('gives the final pass rate once completed and the scored count before', () => {
    expect(usageRate(usage({}))).toEqual({ value: '0.850', final: true, caption: null });
    expect(
      usageRate(usage({ status: 'running', passRate: 0.846, scored: 13, verdict: 'provisional' })),
    ).toEqual({ value: '0.85', final: false, caption: '13 of 60 scored' });
    expect(usageRate(usage({ status: 'running', passRate: null, scored: 0, total: 180 }))).toEqual({
      value: null,
      final: false,
      caption: '0 of 180 scored',
    });
    // A failed experiment with nothing scored shows the en dash only.
    expect(usageRate(usage({ status: 'failed', passRate: 0, scored: 0 }))).toEqual({
      value: null,
      final: false,
      caption: null,
    });
  });

  it('says the verdict, or why there is none', () => {
    expect(usageVerdict(usage({}))).toEqual({ chip: 'better', caption: 'vs baseline 0.633' });
    expect(usageVerdict(usage({ verdict: 'provisional' }))).toEqual({
      chip: null,
      caption: 'Provisional',
    });
    expect(
      usageVerdict(usage({ verdict: 'not_computable', verdictReason: 'single_repetition' })),
    ).toEqual({ chip: null, caption: 'No interval (1 rep)' });
    expect(
      usageVerdict(usage({ verdict: 'not_computable', verdictReason: 'too_few_tasks' })).caption,
    ).toBe('No interval (fewer than 3 tasks)');
    expect(usageVerdict(usage({ role: 'baseline', verdict: null }))).toEqual({
      chip: null,
      caption: null,
    });
  });
});
