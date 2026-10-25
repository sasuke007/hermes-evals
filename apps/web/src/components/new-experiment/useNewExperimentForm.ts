/**
 * The New experiment form's state and rules (NewExperiment board, UI_FLOWS 11.1): what is
 * chosen, what it multiplies to, the first unmet requirement (Launch's reason), the field
 * errors, the estimate query and the launch body. The page owns one; the sections and the
 * summary panel read and write it.
 *
 *   runs = tasks × configurations × repetitions
 *
 * Configurations: any number can be ticked; the radio marks the baseline (and ticks it). The
 * order everywhere is the baseline first, then the other ticked ones as the table lists them.
 */
import { computed, inject, provide, reactive, ref, type InjectionKey, type Ref } from 'vue';
import {
  LaunchExperimentInputSchema,
  MAX_CONCURRENCY,
  MAX_REPETITIONS,
} from '@hermes-evals/shared';
import type {
  EstimateQuery,
  LaunchExperimentInput,
  NewExperimentConfigOption,
  NewExperimentDraft,
  NewExperimentOptions,
  NewExperimentSuiteOption,
} from '@/api/types/experiments';

export interface NewExperimentFormState {
  name: string;
  description: string;
  suiteId: string | null;
  /** Selected task keys; only valid tasks of the suite can be in it. */
  taskKeys: string[];
  /** Ticked configuration version ids. */
  chosen: string[];
  baselineVersionId: string | null;
  /** null: the stepper's text is not a whole number. */
  repetitions: number | null;
  concurrency: number | null;
  /** The fields as typed; empty means none. */
  spendCeiling: string;
  timeBudget: string;
}

/** A verdict needs at least this many tasks (the statistics' too_few_tasks gate). */
export const MIN_TASKS_FOR_VERDICT = 3;

const NUMBER = /^\s*\d+(\.\d+)?\s*$/;
const WHOLE = /^\s*\d+\s*$/;

/** The issue LaunchExperimentInputSchema reports for one field, if any. */
function schemaIssue(field: keyof LaunchExperimentInput, value: unknown): string | null {
  const shape = LaunchExperimentInputSchema.shape[field];
  const result = shape.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'invalid');
}

export function useNewExperimentForm(options: Ref<NewExperimentOptions | null>) {
  const state = reactive<NewExperimentFormState>({
    name: '',
    description: '',
    suiteId: null,
    taskKeys: [],
    chosen: [],
    baselineVersionId: null,
    repetitions: 5,
    concurrency: 3,
    spendCeiling: '',
    timeBudget: '',
  });
  /** The name field was left, or Launch was tried: show its error under it. */
  const nameTouched = ref(false);

  // ── what is offered ───────────────────────────────────────────────────────
  const suites = computed(() => options.value?.suites ?? []);
  const configurations = computed(() => options.value?.configurations ?? []);
  const suite = computed<NewExperimentSuiteOption | null>(
    () => suites.value.find((s) => s.suiteId === state.suiteId) ?? null,
  );
  const validKeys = computed(
    () => suite.value?.tasks.filter((t) => t.valid).map((t) => t.key) ?? [],
  );
  /** Most runs at once: the live workers' capacity (at least 1, so the stepper works). */
  const maxConcurrency = computed(() =>
    Math.max(1, Math.min(MAX_CONCURRENCY, options.value?.maxConcurrency ?? MAX_CONCURRENCY)),
  );

  // ── what is chosen ────────────────────────────────────────────────────────
  /** Selected keys in the suite's order. */
  const selectedTasks = computed(() => validKeys.value.filter((k) => state.taskKeys.includes(k)));
  const byVersion = computed(
    () => new Map(configurations.value.map((c) => [c.versionId, c] as const)),
  );
  /** Ticked configurations, baseline first. */
  const ordered = computed<NewExperimentConfigOption[]>(() => {
    const ticked = configurations.value.filter((c) => state.chosen.includes(c.versionId));
    const base = ticked.find((c) => c.versionId === state.baselineVersionId);
    return base ? [base, ...ticked.filter((c) => c !== base)] : ticked;
  });
  const baseline = computed(() =>
    ordered.value[0]?.versionId === state.baselineVersionId ? ordered.value[0]! : null,
  );
  const candidates = computed(() => (baseline.value ? ordered.value.slice(1) : ordered.value));
  const roleOf = (versionId: string): 'baseline' | 'candidate' | 'not included' => {
    if (!state.chosen.includes(versionId)) return 'not included';
    return versionId === state.baselineVersionId ? 'baseline' : 'candidate';
  };

  /**
   * Chosen configurations with no past runs on this suite: their per-run estimate assumes the
   * budget while the others' use measured medians (the estimate's basis is the weakest one).
   */
  const withoutHistory = computed<string[]>(() => {
    const id = suite.value?.suiteId;
    if (!id) return [];
    return ordered.value.filter((c) => c.estimates[id]?.basis === 'budget').map((c) => c.name);
  });

  /** Tokens per run the estimate assumes on this suite: the most of the chosen configurations. */
  const perRunTokens = computed<number | null>(() => {
    const id = suite.value?.suiteId;
    const tokens = ordered.value.flatMap((c) =>
      id && c.estimates[id] ? [c.estimates[id].tokens] : [],
    );
    return tokens.length > 0 ? Math.max(...tokens) : null;
  });
  const taskCount = computed(() => selectedTasks.value.length);
  const configCount = computed(() => ordered.value.length);
  /** The multiplication, when every factor is there (fewer than two configurations: none). */
  const runs = computed<number | null>(() =>
    taskCount.value > 0 && configCount.value >= 2 && state.repetitions !== null
      ? taskCount.value * configCount.value * state.repetitions
      : null,
  );

  // ── fields ────────────────────────────────────────────────────────────────
  const nameError = computed(() => {
    if (state.name.trim() === '') return nameTouched.value ? 'Name is required.' : null;
    return schemaIssue('name', state.name);
  });
  const descriptionError = computed(() => schemaIssue('description', state.description));
  const repetitionsError = computed(() =>
    state.repetitions === null
      ? `Repetitions is a whole number from 1 to ${MAX_REPETITIONS}.`
      : schemaIssue('repetitions', state.repetitions),
  );
  const concurrencyError = computed(() => {
    if (state.concurrency === null) {
      return `Concurrency is a whole number from 1 to ${maxConcurrency.value}.`;
    }
    if (state.concurrency > maxConcurrency.value) {
      return `At most ${maxConcurrency.value} runs can execute at once on the live workers.`;
    }
    return schemaIssue('concurrency', state.concurrency);
  });
  const spendCeilingUsd = computed<number | null>(() =>
    NUMBER.test(state.spendCeiling) ? Number(state.spendCeiling) : null,
  );
  const spendCeilingError = computed(() => {
    if (state.spendCeiling.trim() === '') return null;
    if (spendCeilingUsd.value === null) return 'Enter an amount in dollars, such as 2.00.';
    return schemaIssue('spendCeilingUsd', spendCeilingUsd.value);
  });
  const timeBudgetS = computed<number | null>(() =>
    WHOLE.test(state.timeBudget) ? Number(state.timeBudget) : null,
  );
  const timeBudgetError = computed(() => {
    if (state.timeBudget.trim() === '') return null;
    if (timeBudgetS.value === null) return 'the time budget is whole seconds';
    return schemaIssue('timeBudgetOverrideS', timeBudgetS.value);
  });

  /**
   * The first unmet requirement, in the board's order; null when the form can launch. The
   * summary shows it as Launch's reason.
   */
  const invalidReason = computed<string | null>(() => {
    if (suites.value.length === 0 || !suite.value) return 'Load a suite first.';
    if (state.name.trim() === '') return 'Give the experiment a name.';
    if (nameError.value) return `Name: ${nameError.value}`;
    if (descriptionError.value) return `Description: ${descriptionError.value}`;
    if (taskCount.value === 0) return 'Select at least one task.';
    if (configCount.value < 2) return 'Pick at least two configurations.';
    if (!baseline.value) return 'Mark one of the chosen configurations as the baseline.';
    if (state.repetitions === null || state.repetitions < 1) {
      return 'Repetitions must be at least 1.';
    }
    if (repetitionsError.value) return `Repetitions: ${repetitionsError.value}`;
    if (concurrencyError.value) return `Concurrency: ${concurrencyError.value}`;
    if (spendCeilingError.value) return `Spend ceiling: ${spendCeilingError.value}`;
    if (timeBudgetError.value) return `Per-run time budget: ${timeBudgetError.value}`;
    return null;
  });

  /** GET /experiments/estimate for the form as it is, or null while it cannot be sized. */
  const estimateQuery = computed<EstimateQuery | null>(() => {
    if (!suite.value || runs.value === null) return null;
    if (state.repetitions === null || repetitionsError.value) return null;
    if (state.concurrency === null || concurrencyError.value || timeBudgetError.value) return null;
    return {
      suiteId: suite.value.suiteId,
      versionIds: ordered.value.map((c) => c.versionId),
      taskCount: taskCount.value,
      repetitions: state.repetitions,
      concurrency: state.concurrency,
      ...(timeBudgetS.value === null ? {} : { budgetS: timeBudgetS.value }),
    };
  });

  /** The POST /experiments body; null while the form is not valid. */
  function launchInput(): LaunchExperimentInput | null {
    if (invalidReason.value !== null || !suite.value || !baseline.value) return null;
    const versions = ordered.value;
    return {
      name: state.name.trim(),
      description: state.description,
      suiteId: suite.value.suiteId,
      taskKeys: selectedTasks.value,
      baselineVersionId: baseline.value.versionId,
      candidateVersionIds: candidates.value.map((c) => c.versionId),
      repetitions: state.repetitions!,
      concurrency: state.concurrency!,
      spendCeilingUsd: state.spendCeiling.trim() === '' ? null : spendCeilingUsd.value,
      timeBudgetOverrideS: state.timeBudget.trim() === '' ? null : timeBudgetS.value,
      expectedConfigHashes: Object.fromEntries(versions.map((c) => [c.versionId, c.configHash])),
    };
  }

  // ── edits ─────────────────────────────────────────────────────────────────
  function selectSuite(id: string): void {
    state.suiteId = id;
    state.taskKeys = [...validKeys.value];
  }
  function toggleTask(key: string, on: boolean): void {
    if (!validKeys.value.includes(key)) return;
    const rest = state.taskKeys.filter((k) => k !== key);
    state.taskKeys = on ? [...rest, key] : rest;
  }
  /** The header checkbox: every valid task, or none. */
  function toggleAllTasks(): void {
    state.taskKeys =
      selectedTasks.value.length === validKeys.value.length ? [] : [...validKeys.value];
  }
  function toggleConfiguration(versionId: string, on: boolean): void {
    const rest = state.chosen.filter((v) => v !== versionId);
    state.chosen = on ? [...rest, versionId] : rest;
  }
  /** The baseline radio: marks it, and ticks it if it was not. */
  function makeBaseline(versionId: string): void {
    state.baselineVersionId = versionId;
    if (!state.chosen.includes(versionId)) state.chosen = [...state.chosen, versionId];
  }

  /** A fresh form on these options: the first suite with all its valid tasks, the defaults. */
  function reset(next: NewExperimentOptions): void {
    state.name = '';
    state.description = '';
    state.suiteId = next.suites[0]?.suiteId ?? null;
    state.taskKeys = next.suites[0]?.tasks.filter((t) => t.valid).map((t) => t.key) ?? [];
    state.chosen = [];
    state.baselineVersionId = null;
    state.repetitions = next.defaults.repetitions;
    const max = Math.max(1, Math.min(MAX_CONCURRENCY, next.maxConcurrency));
    state.concurrency = Math.min(next.defaults.concurrency, max);
    state.spendCeiling = '';
    state.timeBudget = '';
    nameTouched.value = false;
  }

  /**
   * Prefill from a Duplicate draft. Removed and now-invalid tasks are already left out; a
   * configuration version the form no longer offers is dropped. The name says which suite
   * version it now runs on when that moved ("… (v5)").
   */
  function applyDraft(draft: NewExperimentDraft, next: NewExperimentOptions): void {
    reset(next);
    const { values, changes } = draft;
    const moved = changes.suiteVersionTo !== changes.suiteVersionFrom;
    state.name = moved ? `${values.name} (v${changes.suiteVersionTo})` : values.name;
    state.description = values.description;
    const draftSuite = next.suites.find((s) => s.suiteId === values.suiteId);
    if (draftSuite) {
      state.suiteId = draftSuite.suiteId;
      const valid = new Set(draftSuite.tasks.filter((t) => t.valid).map((t) => t.key));
      state.taskKeys = values.taskKeys.filter((k) => valid.has(k));
    }
    const offered = new Set(next.configurations.map((c) => c.versionId));
    state.chosen = [values.baselineVersionId, ...values.candidateVersionIds].filter((v) =>
      offered.has(v),
    );
    state.baselineVersionId = offered.has(values.baselineVersionId)
      ? values.baselineVersionId
      : null;
    state.repetitions = values.repetitions;
    state.concurrency = Math.min(values.concurrency, Math.max(1, next.maxConcurrency));
    state.spendCeiling = values.spendCeilingUsd === null ? '' : values.spendCeilingUsd.toFixed(2);
    state.timeBudget =
      values.timeBudgetOverrideS === null ? '' : String(values.timeBudgetOverrideS);
  }

  /**
   * After a 409 "configuration changed": the options are reloaded, and each chosen version
   * moves to its configuration's latest one, so the comparison shows what launch would freeze.
   */
  function remap(previous: NewExperimentOptions, next: NewExperimentOptions): void {
    const configurationOf = new Map(
      previous.configurations.map((c) => [c.versionId, c.configurationId]),
    );
    const latestOf = new Map(next.configurations.map((c) => [c.configurationId, c.versionId]));
    const move = (v: string): string | null => {
      const id = configurationOf.get(v);
      return (
        (id && latestOf.get(id)) ?? (next.configurations.some((c) => c.versionId === v) ? v : null)
      );
    };
    state.chosen = state.chosen.flatMap((v) => move(v) ?? []);
    state.baselineVersionId = state.baselineVersionId ? move(state.baselineVersionId) : null;
  }

  return {
    state,
    nameTouched,
    suites,
    configurations,
    suite,
    validKeys,
    maxConcurrency,
    selectedTasks,
    byVersion,
    ordered,
    baseline,
    candidates,
    roleOf,
    perRunTokens,
    withoutHistory,
    taskCount,
    configCount,
    runs,
    nameError,
    descriptionError,
    repetitionsError,
    concurrencyError,
    spendCeilingUsd,
    spendCeilingError,
    timeBudgetS,
    timeBudgetError,
    invalidReason,
    estimateQuery,
    launchInput,
    selectSuite,
    toggleTask,
    toggleAllTasks,
    toggleConfiguration,
    makeBaseline,
    reset,
    applyDraft,
    remap,
  };
}

export type NewExperimentForm = ReturnType<typeof useNewExperimentForm>;

/** The page provides its form; the sections inject it (no prop drilling, no prop mutation). */
export const NEW_EXPERIMENT_FORM: InjectionKey<NewExperimentForm> = Symbol('new-experiment-form');

export function provideNewExperimentForm(form: NewExperimentForm): void {
  provide(NEW_EXPERIMENT_FORM, form);
}

export function useFormContext(): NewExperimentForm {
  const form = inject(NEW_EXPERIMENT_FORM, null);
  if (!form) throw new Error('a New experiment section is used outside NewExperimentPage');
  return form;
}
