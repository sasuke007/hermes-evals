/**
 * The form's remap after a 409 "configuration changed" (plan 12.2 item 4): GET
 * /experiments/new-options lists each configuration at its latest version only, so the version
 * the form chose is gone from the reloaded options and each choice moves to its
 * configuration's latest version.
 */
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { NewExperimentOptions } from '@/api/types/experiments';
import { useNewExperimentForm } from '@/components/new-experiment/useNewExperimentForm';
import { newExperimentOptionsFixture } from '@/fixtures/experiments';

/** `previous` with one configuration moved on to version 2. */
function edited(previous: NewExperimentOptions, name: string) {
  const old = previous.configurations.find((c) => c.name === name)!;
  const moved = {
    ...old,
    versionId: `${old.versionId}-v2`,
    version: 2,
    configHash: 'f'.repeat(64),
  };
  const next: NewExperimentOptions = {
    ...previous,
    configurations: previous.configurations.map((c) => (c === old ? moved : c)),
  };
  return { old, moved, next };
}

describe('useNewExperimentForm remap', () => {
  it('moves each chosen version to its configuration’s latest one', () => {
    const previous = newExperimentOptionsFixture(() => false);
    const baseline = previous.configurations.find((c) => c.name === 'baseline')!;
    const { old, moved, next } = edited(previous, 'with-skill');
    const options = ref<NewExperimentOptions | null>(previous);
    const form = useNewExperimentForm(options);
    form.state.chosen = [baseline.versionId, old.versionId];
    form.state.baselineVersionId = baseline.versionId;

    options.value = next;
    form.remap(previous, next);

    expect(form.state.chosen).toEqual([baseline.versionId, moved.versionId]);
    expect(form.state.baselineVersionId).toBe(baseline.versionId);
  });

  it('moves the baseline too when it is the configuration that changed', () => {
    const previous = newExperimentOptionsFixture(() => false);
    const skill = previous.configurations.find((c) => c.name === 'with-skill')!;
    const { old, moved, next } = edited(previous, 'baseline');
    const form = useNewExperimentForm(ref<NewExperimentOptions | null>(previous));
    form.state.chosen = [old.versionId, skill.versionId];
    form.state.baselineVersionId = old.versionId;

    form.remap(previous, next);

    expect(form.state.chosen).toEqual([moved.versionId, skill.versionId]);
    expect(form.state.baselineVersionId).toBe(moved.versionId);
  });
});

describe('useNewExperimentForm withoutHistory', () => {
  it('names the chosen configurations that have no past runs on the chosen suite', () => {
    const previous = newExperimentOptionsFixture(() => false);
    const suiteId = previous.suites[0]!.suiteId;
    const baseline = previous.configurations.find((c) => c.name === 'baseline')!;
    const skill = previous.configurations.find((c) => c.name === 'with-skill')!;
    const fresh = {
      ...skill,
      estimates: {
        ...skill.estimates,
        [suiteId]: { ...skill.estimates[suiteId]!, basis: 'budget' as const, pastRuns: 0 },
      },
    };
    const options = ref<NewExperimentOptions | null>({
      ...previous,
      configurations: previous.configurations.map((c) => (c === skill ? fresh : c)),
    });
    const form = useNewExperimentForm(options);
    form.state.suiteId = suiteId;
    form.state.chosen = [baseline.versionId, skill.versionId];
    form.state.baselineVersionId = baseline.versionId;
    expect(form.withoutHistory.value).toEqual(['with-skill']);

    form.state.chosen = [baseline.versionId];
    expect(form.withoutHistory.value).toEqual([]);
  });
});
