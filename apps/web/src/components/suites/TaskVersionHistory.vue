<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { TaskVersionEntry } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import { formatDateTime } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { taskVersionTitle } from './suiteFormat';

/**
 * A task's versions, newest first (TaskDetail board, plan 4.5): what each changed, the suite
 * version it first appeared in, and a link to its diff against the version before it (the
 * first version lists its files). The version on screen is tinted.
 */
const props = withDefaults(
  defineProps<{
    history: TaskVersionEntry[];
    taskKey: string;
    /** Task version on screen. */
    viewingVersion: number;
    /** The current version failed its self-check ("now invalid"). */
    currentInvalid?: boolean;
  }>(),
  { currentInvalid: false },
);

const isOld = (): boolean =>
  props.history.some((h) => h.current && h.version !== props.viewingVersion);
const tinted = (h: TaskVersionEntry): boolean =>
  isOld() ? h.version === props.viewingVersion : h.current;

function diffTo(i: number) {
  const entry = props.history[i]!;
  const previous = props.history[i + 1];
  return {
    name: ROUTE_NAMES.task,
    params: { id: entry.suiteId, key: props.taskKey },
    query: { diff: previous ? previous.suiteId : entry.suiteId },
  };
}
</script>

<template>
  <BasePanel title="History" meta="task versions · opens the diff">
    <div class="flex flex-col">
      <RouterLink
        v-for="(h, i) in history"
        :key="h.version"
        :to="diffTo(i)"
        class="grid grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-10 border-b border-border px-16 py-10 text-text last:border-b-0 hover:bg-surface-2 hover:text-text hover:no-underline"
        :class="{ 'bg-surface-2': tinted(h) }"
        :data-version="h.version"
      >
        <span class="font-mono font-semibold">v{{ h.version }}</span>
        <span class="flex flex-col gap-2">
          <span
            >{{ taskVersionTitle(h, i === history.length - 1)
            }}{{ isOld() && h.version === viewingVersion ? ' · viewing' : '' }}</span
          >
          <span class="text-12 text-text-3"
            >suite v{{ h.introducedInSuiteVersion }} · {{ formatDateTime(h.loadedAt)
            }}{{ h.current && currentInvalid ? ' · now invalid' : '' }}</span
          >
        </span>
        <span class="flex items-center gap-6">
          <span v-if="h.current" class="chip h-18 bg-surface-3 text-text">current</span>
          <span class="text-12 text-accent">{{
            i < history.length - 1 ? `Diff with v${history[i + 1]!.version}` : 'View files'
          }}</span>
        </span>
      </RouterLink>
    </div>
  </BasePanel>
</template>
