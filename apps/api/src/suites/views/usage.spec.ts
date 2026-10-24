import { describe, expect, it } from 'vitest';
import { TaskExperimentUsageSchema } from '@hermes-evals/shared';
import { taskUsageView, type UsageCounts } from './usage.js';

const counts = (over: Partial<UsageCounts>): UsageCounts => ({
  experimentId: 'exp_1',
  experimentName: 'Skill vs no skill',
  status: 'completed',
  baselineVersionId: 'cv_base',
  candidateVersionIds: ['cv_skill'],
  configurationVersionId: 'cv_base',
  configurationName: 'baseline',
  configurationVersion: 1,
  total: 3,
  counted: 3,
  passed: 2,
  ...over,
});

describe('taskUsageView', () => {
  it('groups by experiment, baseline first, with the pass rate over finished runs', () => {
    const view = taskUsageView([
      counts({
        configurationVersionId: 'cv_skill',
        configurationName: 'with-skill',
        counted: 2,
        passed: 2,
      }),
      counts({}),
      counts({
        experimentId: 'exp_0',
        experimentName: 'First try',
        status: 'running',
        counted: 0,
        passed: 0,
      }),
    ]);
    expect(TaskExperimentUsageSchema.array().parse(view)).toEqual([
      {
        experimentId: 'exp_1',
        experimentName: 'Skill vs no skill',
        status: 'completed',
        rows: [
          { configuration: 'baseline', role: 'baseline', passRate: 2 / 3, scored: 3, total: 3 },
          { configuration: 'with-skill', role: 'candidate', passRate: 1, scored: 2, total: 3 },
        ],
      },
      {
        experimentId: 'exp_0',
        experimentName: 'First try',
        status: 'running',
        rows: [
          { configuration: 'baseline', role: 'baseline', passRate: null, scored: 0, total: 3 },
        ],
      },
    ]);
  });

  it('names the version when two versions of one configuration are compared', () => {
    const view = taskUsageView([
      counts({}),
      counts({ configurationVersionId: 'cv_skill', configurationVersion: 2 }),
    ]);
    expect(view[0]!.rows.map((r) => r.configuration)).toEqual(['baseline v1', 'baseline v2']);
  });
});
