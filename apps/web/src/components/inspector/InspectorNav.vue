<script setup lang="ts">
import type { RunPosition } from '@/stores/inspector';

/**
 * The drawer's top row (RunInspector): where the run sits in the list it was opened from
 * ("Comparison · grid order · run 15 of 120"), Prev and Next through that list (K and J),
 * and Close (Esc). Drawn in every state, so a run that failed to load can still be stepped
 * past (ExperimentStates › Run inspector drawer: "Prev and next still work"). At either end
 * of the list Prev or Next is aria-disabled rather than disabled, so a button that just took
 * the user there keeps focus.
 */
defineProps<{
  runId: string;
  position: RunPosition | null;
  prev: string | null;
  next: string | null;
}>();
const emit = defineEmits<{ close: []; navigate: [runId: string] }>();
</script>

<template>
  <div class="flex items-center justify-between gap-12">
    <nav
      aria-label="Run position"
      class="flex min-w-0 items-center gap-8 text-12 text-text-3"
      data-testid="run-position"
    >
      <template v-if="position">
        <span>{{ position.label }}</span
        ><span class="font-mono">{{ position.run }}</span>
      </template>
      <span v-else class="font-mono">{{ runId }}</span>
    </nav>
    <div class="flex items-center gap-6">
      <button
        type="button"
        class="btn mid"
        aria-label="Previous run (K)"
        :title="prev ? 'Previous run · K' : 'No previous run in this list'"
        :aria-disabled="!prev || undefined"
        data-testid="prev-run"
        @click="prev && emit('navigate', prev)"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M7.5 2.5L4 6l3.5 3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          /></svg
        >Prev
      </button>
      <button
        type="button"
        class="btn mid"
        aria-label="Next run (J)"
        :title="next ? 'Next run · J' : 'No next run in this list'"
        :aria-disabled="!next || undefined"
        data-testid="next-run"
        @click="next && emit('navigate', next)"
      >
        Next<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M4.5 2.5L8 6 4.5 9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="btn mid ghost"
        aria-label="Close run inspector (Esc)"
        title="Close · Esc"
        data-primary
        data-testid="close-inspector"
        @click="emit('close')"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M3.5 3.5l7 7M10.5 3.5l-7 7"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  </div>
</template>
