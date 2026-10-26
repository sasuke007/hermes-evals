import { beforeEach, describe, expect, it } from 'vitest';
import {
  emptyFilterCopy,
  numberWord,
  provisionalBanner,
  sensitivitySentence,
  splitLead,
  statisticsReading,
} from '../readings';
import { getComparison } from '@/api/experiments';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import type { ComparisonView } from '@/api/types/experiments';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

beforeEach(() => useScenario(null));

describe('How to read this', () => {
  it('explains a better verdict with the numbers of the view', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    const reading = statisticsReading(view);
    expect(reading?.read1).toBe(
      "The 12 tasks were resampled with replacement 10,000 times. Each resample recomputed the difference in pass rate between with-skill and baseline, keeping each task's runs together. 95% of those differences fall between +0.117 and +0.333, and the observed difference is +0.217. Because the whole interval lies above zero, the improvement is unlikely to come from which runs happened to pass, so the verdict is better.",
    );
    expect(reading?.read2).toMatch(/^An interval that crossed zero would give inconclusive\./);
  });

  it('names the execution error an inconclusive verdict counts (Flow B)', async () => {
    const view = await getComparison(EXPERIMENT_IDS.mcpSmoke);
    const reading = statisticsReading(view);
    expect(reading?.read1).toContain(
      'Because the interval crosses zero, three repetitions cannot tell the two apart, so the verdict is inconclusive.',
    );
    expect(reading?.read2).toBe(
      'Inconclusive does not mean equivalent: a real difference of that size could still exist. One with-mcp cell is an execution error, not a wrong answer (currency_mix, rep 2). It counts against with-mcp here, and retrying it recomputes the verdict. More repetitions narrow the interval.',
    );
  });

  it('reads provisional figures as a progress check', async () => {
    const view = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    const reading = statisticsReading(view);
    const { baseline, candidate } = view.passCounts;
    expect(reading?.read1).toContain(
      `These numbers come from the runs scored so far: ${baseline.counted} of baseline's 60 and ${candidate.counted} of with-mcp's 60.`,
    );
    expect(reading?.read2).toBe(
      'The interval is recomputed as each run is scored, so it can still move either way, and no verdict is given until all 120 runs are scored. Read it as a progress check, not a result.',
    );
    expect(provisionalBanner(view).lead).toBe(
      `Still running: ${view.progress.scored} of 120 runs scored.`,
    );
  });

  it('words the banner for a paused or failed experiment', async () => {
    const view = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    expect(provisionalBanner({ ...view, experimentStatus: 'paused' }).lead).toMatch(/^Paused: /);
    expect(provisionalBanner({ ...view, experimentStatus: 'failed' }).lead).toMatch(/^Stopped: /);
  });
});

describe('sensitivity', () => {
  it('says what the verdict is without the runs that broke', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    expect(sensitivitySentence(view)).toBe(
      'Sensitivity: if the 3 baseline runs that broke rather than answered (1 execution_error, 2 ungradable) are excluded, the baseline pass rate is 38 / 57 = 0.667 and the difference is +0.204 [+0.104, +0.312]. The verdict does not depend on them.',
    );
  });

  it('names both sides and a verdict that depends on them', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    const s = view.sensitivity!;
    const both: ComparisonView = {
      ...view,
      sensitivity: {
        ...s,
        excludedCandidate: { executionErrors: 0, ungradable: 0, error: 1 },
        verdict: 'inconclusive',
        verdictChanges: true,
      },
    };
    expect(sensitivitySentence(both)).toContain(
      '(3 baseline: 1 execution_error, 2 ungradable; 1 with-skill: 1 error), the pass rates are 38 / 57 = 0.667 and',
    );
    expect(sensitivitySentence(both)).toMatch(
      /Without them the verdict would be inconclusive, so it depends on them\.$/,
    );
    expect(sensitivitySentence({ ...view, sensitivity: null })).toBeNull();
  });
});

describe('other copy', () => {
  it('explains an empty filter', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    expect(emptyFilterCopy('regressed', view)).toEqual({
      title: 'No regressed tasks',
      body: 'with-skill did not do worse than baseline on any of the 12 tasks. The filter shows "Regressed 0", so this view is empty, not broken.',
    });
    expect(emptyFilterCopy('improved', view).body).toBe('No task matches the improved filter.');
  });

  it('bolds a message up to its first full stop or colon', () => {
    expect(
      splitLead(
        'No interval with 1 repetition. Pass rates: baseline 0.58, with-skill 0.83 on 12 tasks.',
      ),
    ).toEqual({
      lead: 'No interval with 1 repetition.',
      rest: 'Pass rates: baseline 0.58, with-skill 0.83 on 12 tasks.',
    });
    expect(splitLead('No interval: 2 tasks counted fewer than 2 runs.').lead).toBe('No interval:');
    expect(numberWord(3)).toBe('three');
    expect(numberWord(12)).toBe('12');
  });
});
