<script setup lang="ts">
import { RouterLink, useRoute, type RouteLocationRaw } from 'vue-router';
import type { FeedEntry } from '@/api/types/experiments';
import BasePanel from '@/components/ui/BasePanel.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { formatClock } from '@/lib/format';
import { formatSeconds } from './overview';

/**
 * Latest completions (OverviewRunning): the last ten runs that finished, newest first. A row
 * that arrived live is highlighted for 2 s; clicking a row opens it in the run inspector over
 * the Overview (`?run=`), which keeps updating behind the scrim (Flow C step 4).
 */
withDefaults(
  defineProps<{
    feed: FeedEntry[];
    /** Rows that arrived live (the arrival highlight). */
    arrived?: string[];
  }>(),
  { arrived: () => [] },
);
const emit = defineEmits<{ open: [runId: string] }>();
const route = useRoute();

const runLink = (runId: string): RouteLocationRaw => ({ query: { ...route.query, run: runId } });

function onRow(entry: FeedEntry, event: MouseEvent | KeyboardEvent): void {
  if ((event.target as HTMLElement | null)?.closest('a')) return;
  emit('open', entry.runId);
}
</script>

<template>
  <BasePanel
    title="Latest completions"
    meta="last 10 · newest first"
    clip
    data-testid="latest-completions"
  >
    <table v-if="feed.length" class="dt clickable" aria-label="Latest completions">
      <thead>
        <tr>
          <th scope="col">Finished</th>
          <th scope="col">Task</th>
          <th scope="col">Configuration</th>
          <th scope="col" class="text-right">Rep</th>
          <th scope="col">Result</th>
          <th scope="col" class="text-right">Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in feed"
          :key="entry.runId"
          :class="{ '[&>td]:animate-arrive': arrived.includes(entry.runId) }"
          :data-run-id="entry.runId"
          @click="onRow(entry, $event)"
        >
          <td class="font-mono text-12 text-text-2">{{ formatClock(entry.finishedAt) }}</td>
          <td>
            <RouterLink
              :to="runLink(entry.runId)"
              class="font-mono text-12 text-text hover:text-text"
              >{{ entry.taskKey }}</RouterLink
            >
          </td>
          <td class="font-mono text-12">{{ entry.configuration }}</td>
          <td class="text-right">{{ entry.repetition }}</td>
          <td>
            <StatusChip
              :kind="entry.result === 'execution_error' ? 'run' : 'score'"
              :status="entry.result"
            />
          </td>
          <td class="text-right font-mono text-12">{{ formatSeconds(entry.durationS) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="px-16 py-24 text-text-2" data-testid="feed-empty">
      No run has finished yet. Each run appears here as it is scored or fails.
    </p>
  </BasePanel>
</template>
