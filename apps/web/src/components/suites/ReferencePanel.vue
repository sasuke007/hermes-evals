<script setup lang="ts">
import { computed } from 'vue';
import type { JsonValue } from '@hermes-evals/shared';
import { formatJson } from './suiteFormat';
import ZoneLabel from './ZoneLabel.vue';

/**
 * The task's hidden answer (TaskDetail board): reference.json on a hatched, dashed panel,
 * marked "Hidden from the agent", because it is never copied into a run. The user sees it:
 * it is their own task.
 */
const props = defineProps<{ reference: { file: string; value: JsonValue } }>();

const text = computed(() => formatJson(props.reference.value));
</script>

<template>
  <section
    aria-labelledby="task-reference"
    class="flex flex-col rounded-6 border border-dashed border-border-strong bg-[repeating-linear-gradient(135deg,var(--surface)_0_10px,var(--surface-2)_10px_20px)]"
    data-testid="reference"
  >
    <div
      class="flex items-center justify-between gap-10 border-b border-dashed border-border-strong px-16 py-12"
    >
      <h2 id="task-reference" class="flex items-center gap-8 text-15 font-semibold">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z M2.5 13.5l11-11"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        Reference answer
      </h2>
      <ZoneLabel zone="hidden" />
    </div>
    <div class="flex flex-col gap-8 px-16 py-14">
      <pre
        class="rounded-4 border border-border bg-surface px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
        >{{ text }}</pre>
      <p class="text-12 text-text-3">
        {{ reference.file }} · Never copied into a run. Only the checks read it.
      </p>
    </div>
  </section>
</template>
