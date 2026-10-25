<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ExperimentDetail } from '@/api/types/experiments';
import BaseTag from '@/components/ui/BaseTag.vue';
import { shortHash, plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { hermesLabel, taskCount } from './overview';

/**
 * Frozen snapshot (OverviewRunning): one wrapping line of what the experiment froze at
 * launch, the suite version with its hash, each configuration version with "view as of this
 * experiment", the Hermes build and the score keys.
 */
const props = defineProps<{ detail: ExperimentDetail }>();

const configs = computed(() => [props.detail.baseline, ...props.detail.candidates]);
const scoreKeys = computed(() =>
  props.detail.scoreKey === 'primary' ? 'primary per task' : props.detail.scoreKey,
);
</script>

<template>
  <section
    class="flex flex-wrap items-center gap-x-32 gap-y-10 rounded-6 border border-border bg-surface px-16 py-14"
    aria-labelledby="snapshot-strip"
    data-testid="snapshot-strip"
  >
    <h2 id="snapshot-strip" class="text-13 font-semibold">Frozen snapshot</h2>
    <span class="inline-flex flex-wrap items-baseline gap-x-4 text-text-2">
      <span>Suite</span>
      <span class="font-mono text-text">{{ detail.suite.name }}</span>
      <span class="font-semibold text-text">v{{ detail.suite.versionNumber }}</span>
      <span class="text-text-3">· {{ plural(taskCount(detail), 'task') }}</span>
      <BaseTag>{{ shortHash(detail.suite.contentHash) }}</BaseTag>
      <RouterLink :to="{ name: ROUTE_NAMES.suite, params: { id: detail.suite.suiteId } }"
        >view v{{ detail.suite.versionNumber }}</RouterLink
      >
    </span>
    <span
      v-for="c in configs"
      :key="c.versionId"
      class="inline-flex flex-wrap items-baseline gap-x-4 text-text-2"
    >
      <span class="font-mono text-text">{{ c.name }}</span>
      <BaseTag>v{{ c.version }}</BaseTag>
      <RouterLink
        :to="{
          name: ROUTE_NAMES.configuration,
          params: { id: c.configurationId },
          query: { version: String(c.version) },
        }"
        >view as of this experiment</RouterLink
      >
    </span>
    <span class="inline-flex flex-wrap items-baseline gap-x-4 text-text-2">
      <span>Hermes</span>
      <span class="font-mono text-text">{{ hermesLabel(detail) }}</span>
    </span>
    <span class="inline-flex flex-wrap items-baseline gap-x-4 text-text-2">
      <span>Score keys</span>
      <span class="font-mono text-text">{{ scoreKeys }}</span>
    </span>
  </section>
</template>
