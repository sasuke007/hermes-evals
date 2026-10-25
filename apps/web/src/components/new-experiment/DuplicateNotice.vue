<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { NewExperimentDraft } from '@/api/types/experiments';
import { ROUTE_NAMES } from '@/router';

/**
 * Above the form when it was opened by Duplicate (NewExperiment board, variant="duplicated";
 * UI_FLOWS 11.3): which experiment it copies and on which suite version, the version it now
 * uses, the tasks that changed since (their results are not comparable with the original's),
 * and the tasks left out with why: removed from the suite, or now invalid.
 */
const props = defineProps<{
  draft: NewExperimentDraft;
  /** The original experiment's name. */
  sourceName: string;
}>();

const changes = computed(() => props.draft.changes);
const moved = computed(() => changes.value.suiteVersionTo !== changes.value.suiteVersionFrom);
const leftOut = computed(() => [
  ...changes.value.removedTasks.map((key) => ({
    key,
    why: `no longer in the suite (v${changes.value.suiteVersionTo})`,
    title: null as string | null,
  })),
  ...changes.value.invalidTasks.map((t) => ({
    key: t.key,
    why: 'now invalid (self-check failed)',
    title: t.reason,
  })),
]);
</script>

<template>
  <div
    class="flex flex-col gap-10 rounded-6 border border-border-strong bg-accent-soft px-14 py-12"
    role="status"
    data-testid="duplicate-notice"
  >
    <div class="flex items-start gap-10">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class="mt-2 flex-none text-accent"
      >
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 7.2v4M8 4.8h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
      <div class="text-text-2">
        Duplicated from
        <RouterLink
          :to="{ name: ROUTE_NAMES.experimentOverview, params: { id: draft.sourceExperimentId } }"
          ><code>{{ sourceName }}</code></RouterLink
        >
        (suite v{{ changes.suiteVersionFrom }}).
        <template v-if="moved">
          <b class="text-text">Now using v{{ changes.suiteVersionTo }}.</b>
        </template>
        <template v-if="changes.changedTasks.length > 0">
          Changed since then:
          <template v-for="(key, i) in changes.changedTasks" :key="key"
            ><code>{{ key }}</code
            >{{ i < changes.changedTasks.length - 1 ? ', ' : '' }}</template
          >. Results on changed tasks are not comparable with the original.
        </template>
      </div>
    </div>
    <div v-if="leftOut.length > 0" class="flex flex-col gap-4 pl-26">
      <span class="text-12 font-semibold text-text-2">Left out of this experiment</span>
      <span
        v-for="task in leftOut"
        :key="task.key"
        class="text-12"
        :title="task.title ?? undefined"
        data-testid="left-out"
        ><code>{{ task.key }}</code
        >: <span class="text-text-2">{{ task.why }}</span></span
      >
    </div>
  </div>
</template>
