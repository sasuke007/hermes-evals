<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ExperimentDetail } from '@/api/types/experiments';
import FormField from '@/components/ui/FormField.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { formatUsd, plural } from '@/lib/format';
import { formatHourMinute } from './overview';

/**
 * Paused by the spend ceiling (ExperimentStates › paused by spend ceiling): the guard paused
 * the experiment before a claim, in-flight runs finished, and Resume needs a higher ceiling.
 * The form proposes one that covers the estimated rest; `resume` carries the new ceiling.
 */
const props = withDefaults(defineProps<{ detail: ExperimentDetail; busy?: boolean }>(), {
  busy: false,
});
const emit = defineEmits<{ resume: [spendCeilingUsd: number] }>();

const spend = computed(() => props.detail.spend);
const ceiling = computed(() => spend.value.ceilingUsd ?? 0);
/** Above this the API accepts the ceiling: the old ceiling and the spend so far. */
const floor = computed(() => Math.max(ceiling.value, spend.value.spentUsd));
const waiting = computed(() => props.detail.counts.queued);

/** A ceiling that covers the estimate for the rest, rounded up to whole dollars. */
function proposal(): string {
  const need = floor.value + (spend.value.remainingEstimateUsd ?? 0);
  let next = Math.ceil(need);
  if (next <= floor.value) next = Math.floor(floor.value) + 1;
  return next.toFixed(2);
}

const value = ref(proposal());
const error = ref<string | null>(null);
watch(floor, () => (value.value = proposal()));

const headline = computed(() => {
  const at = props.detail.pausedAt ? ` at ${formatHourMinute(props.detail.pausedAt)}` : '';
  return `Paused${at}: spend reached the ${formatUsd(ceiling.value)} ceiling (${props.detail.counts.scored} / ${props.detail.totalRuns} scored)`;
});

function submit(): void {
  const n = Number(value.value);
  if (!Number.isFinite(n) || value.value.trim() === '') {
    error.value = 'Enter an amount in dollars, for example 3.00.';
    return;
  }
  if (n <= floor.value) {
    error.value = `Raise it above ${formatUsd(floor.value)}.`;
    return;
  }
  if (n > 10_000) {
    error.value = 'The spend ceiling is at most $10,000.';
    return;
  }
  error.value = null;
  emit('resume', Math.round(n * 100) / 100);
}
</script>

<template>
  <section
    class="flex flex-col gap-12 rounded-6 border border-border bg-surface p-16"
    aria-label="Paused by the spend ceiling"
    data-testid="spend-ceiling-pause"
  >
    <div class="flex flex-wrap items-center gap-10">
      <StatusChip kind="experiment" status="paused" />
      <span class="font-semibold">{{ headline }}</span>
    </div>
    <p class="text-text-2">
      Runs that were already in flight finished before pausing; no run was cut off.
      {{ plural(waiting, 'run') }} {{ waiting === 1 ? 'is' : 'are' }} waiting. Resume continues only
      if the ceiling is raised.
    </p>
    <form
      class="flex flex-wrap items-end gap-10 rounded-6 border border-border bg-surface-2 p-12"
      novalidate
      @submit.prevent="submit"
    >
      <FormField v-slot="{ id, describedBy, invalid }" label="Raise ceiling to $" :error="error">
        <input
          :id="id"
          v-model="value"
          class="input w-110 font-mono"
          inputmode="decimal"
          :aria-describedby="describedBy"
          :aria-invalid="invalid"
          :disabled="busy"
        />
      </FormField>
      <button type="submit" class="btn primary" :disabled="busy" :aria-busy="busy || undefined">
        {{ busy ? 'Resuming…' : 'Resume' }}
      </button>
      <span
        v-if="spend.remainingEstimateUsd !== null"
        class="pb-8 text-12 text-text-3"
        data-testid="remaining-cost"
        >≈ {{ formatUsd(spend.remainingEstimateUsd) }} more is needed to finish the remaining
        {{ plural(waiting, 'run') }}</span
      >
    </form>
  </section>
</template>
