import { describe, expect, it } from 'vitest';
import type { ConfigurationUsage } from '@/api/types/configurations';
import {
  joinSeries,
  launchToolsets,
  launchToolsetsNote,
  matchesName,
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
  taskCount: 12,
  delta: null,
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
      usageVerdict(
        usage({ verdict: 'not_computable', verdictReason: 'too_few_tasks', taskCount: 2 }),
      ).caption,
    ).toBe('No interval (2 tasks)');
    expect(
      usageVerdict(
        usage({ verdict: 'not_computable', verdictReason: 'too_few_tasks', taskCount: 1 }),
      ).caption,
    ).toBe('No interval (1 task)');
    expect(usageVerdict(usage({ role: 'baseline', verdict: null }))).toEqual({
      chip: null,
      caption: null,
    });
  });

  it('adds the candidate\'s Δ whenever there is one (ConfigDetail\'s "Δ +0.056")', () => {
    expect(
      usageVerdict(usage({ verdict: 'inconclusive', delta: 0.056, baselinePassRate: null })),
    ).toEqual({ chip: 'inconclusive', caption: 'Δ +0.056' });
    expect(usageVerdict(usage({ delta: 0.217 }))).toEqual({
      chip: 'better',
      caption: 'Δ +0.217 · vs baseline 0.633',
    });
    expect(usageVerdict(usage({ verdict: 'provisional', delta: -0.05 })).caption).toBe(
      'Provisional · Δ −0.050',
    );
    expect(
      usageVerdict(
        usage({
          verdict: 'not_computable',
          verdictReason: 'too_few_tasks',
          taskCount: 2,
          delta: 0.25,
        }),
      ).caption,
    ).toBe('No interval (2 tasks) · Δ +0.250');
  });
});

describe('launchToolsets (Phase 6b #12)', () => {
  it('adds memory with memory on and skills on demand, each once', () => {
    const v = {
      toolsets: ['file', 'terminal'],
      memoryEnabled: false,
      skillLoading: 'preload' as const,
    };
    expect(launchToolsets(v)).toEqual([]);
    expect(launchToolsets({ ...v, memoryEnabled: true })).toEqual(['memory']);
    expect(launchToolsets({ ...v, skillLoading: 'on_demand' })).toEqual(['skills']);
    expect(
      launchToolsets({
        toolsets: ['memory', 'skills'],
        memoryEnabled: true,
        skillLoading: 'on_demand',
      }),
    ).toEqual([]);
    expect(launchToolsetsNote(['memory', 'skills'])).toBe(
      '+ memory and skills at launch: memory is on and skills load on demand',
    );
    expect(launchToolsetsNote(['memory'], { why: false })).toBe('+ memory at launch');
    expect(launchToolsetsNote([])).toBeNull();
  });
});

describe('matchesName (Phase 5 #18)', () => {
  it('needs every word of the query in the name, ignoring case', () => {
    expect(matchesName('with-skill-and-mcp', '')).toBe(true);
    expect(matchesName('with-skill-and-mcp', ' SKILL  mcp ')).toBe(true);
    expect(matchesName('with-skill-and-mcp', 'skill memory')).toBe(false);
  });
});
