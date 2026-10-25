<script setup lang="ts">
import { computed } from 'vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import FormSection from './FormSection.vue';
import NumberStepper from './NumberStepper.vue';
import { useFormContext } from './useNewExperimentForm';

/**
 * Section 5, Limits (NewExperiment board): concurrency (up to what the live workers can run at
 * once), an optional spend ceiling, and an optional per-run time budget. The budget replaces
 * each configuration's own time budget in every run, so every arm gets the same one (plan 7.1;
 * Phase 2 question 9); the estimate and the runs use it the same way.
 */
const form = useFormContext();

/** BaseInput's model is string | number | null; the form keeps the text as typed. */
const text = (key: 'spendCeiling' | 'timeBudget') =>
  computed({
    get: () => form.state[key],
    set: (value: string | number | null) => (form.state[key] = value === null ? '' : String(value)),
  });
const spendCeiling = text('spendCeiling');
const timeBudget = text('timeBudget');

const concurrencyHelp = computed(
  () =>
    `Runs executing at once. Limited by your provider's rate limit and the worker count (${form.maxConcurrency.value}).`,
);
const budgetHelp = computed(() => {
  const suite = form.suite.value;
  const declared = suite ? ` Tasks in ${suite.name} declare ${suite.budgetS} s.` : '';
  return `Optional. Replaces each configuration's own budget in every run, so every configuration gets the same.${declared}`;
});
</script>

<template>
  <FormSection :number="5" title="Limits">
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-16">
      <NumberStepper
        id="ne-conc"
        v-model="form.state.concurrency"
        label="Concurrency"
        :max="form.maxConcurrency.value"
        decrease-label="Lower concurrency"
        increase-label="Higher concurrency"
        :help="concurrencyHelp"
        :error="form.concurrencyError.value"
      />
      <BaseInput
        id="ne-ceil"
        v-model="spendCeiling"
        label="Spend ceiling (USD)"
        mono
        placeholder="No ceiling"
        help="Optional. The experiment pauses when estimated spend reaches it."
        :error="form.spendCeilingError.value"
      />
      <BaseInput
        id="ne-budget"
        v-model="timeBudget"
        label="Per-run time budget (s)"
        mono
        placeholder="Each configuration's own"
        :help="budgetHelp"
        :error="form.timeBudgetError.value"
      />
    </div>
  </FormSection>
</template>
