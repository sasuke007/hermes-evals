<script setup lang="ts">
import { MAX_REPETITIONS } from '@hermes-evals/shared';
import FormSection from './FormSection.vue';
import NumberStepper from './NumberStepper.vue';
import { useFormContext } from './useNewExperimentForm';

/**
 * Section 4, Repetitions (NewExperiment board): the stepper (default 5, at least 1, at most
 * 20), what a repetition is and what more of them buys, and at 1 the warning that there will
 * be pass rates but no verdict.
 */
const form = useFormContext();
</script>

<template>
  <FormSection :number="4" title="Repetitions">
    <div class="flex flex-wrap items-start gap-16">
      <NumberStepper
        id="ne-reps"
        v-model="form.state.repetitions"
        label="Repetitions per task and configuration"
        :max="MAX_REPETITIONS"
        decrease-label="Fewer repetitions"
        increase-label="More repetitions"
        :error="form.repetitionsError.value"
      />
      <p class="max-w-520 pt-24 text-12 text-text-3">
        Each repetition is an independent run in a fresh trial home. The interval narrows roughly
        with the square root of the count: going from 5 to 10 repetitions makes it about 30%
        narrower and doubles the runs.
      </p>
    </div>
    <div
      v-if="form.state.repetitions === 1"
      role="status"
      class="flex items-start gap-10 rounded-4 border border-ung bg-ung-soft px-12 py-10"
      data-testid="single-rep-warning"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class="mt-2 flex-none text-ung-text"
      >
        <path
          d="M8 1.8l6.5 11.4H1.5z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path
          d="M8 6.2v3.2M8 11.4h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
      <div>
        <b class="text-ung-text">A single repetition cannot produce a confidence interval.</b
        >{{ ' '
        }}<span class="text-text-2"
          >You will get pass rates per configuration but no verdict. Use this only to smoke-test a
          configuration.</span
        >
      </div>
    </div>
  </FormSection>
</template>
