<script setup lang="ts">
import { computed } from 'vue';
import type { RunRow } from '@/api/types/runs';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import type { BulkError, BulkOutcome } from '@/stores/runs';

/**
 * What a bulk Re-score or Retry execution did (UI_FLOWS 17): the runs that could not be
 * enqueued, each with the API's reason (ErrorBanner, ?scenario=bulk-refused), or a short line
 * saying what was queued. A request that failed outright quotes the server's message, and the
 * fields it refused (a 400's issues) as the hint.
 */
const props = withDefaults(
  defineProps<{
    outcome: BulkOutcome | null;
    error?: BulkError | null;
    /** Rows by id, to name a refused run by task, configuration and repetition. */
    records: Record<string, RunRow>;
  }>(),
  { error: null },
);
defineEmits<{ dismiss: [] }>();

const VERB = { rescore: 're-scored', retry: 'retried' } as const;

function runName(runId: string): string {
  const row = props.records[runId];
  return row ? `${row.taskKey} · ${row.configuration.name} · rep ${row.repetition}` : runId;
}
const runs = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`;

const refusedTitle = computed(() => {
  const o = props.outcome;
  if (!o) return '';
  return `${o.refused.length} of ${runs(o.requested)} could not be ${VERB[o.action]}`;
});
const queuedLine = computed(() => {
  const o = props.outcome;
  if (!o || o.enqueued.length === 0) return null;
  return o.action === 'rescore'
    ? `Re-score queued for ${runs(o.enqueued.length)}. The current results stay until the new scores publish.`
    : `Retry queued for ${runs(o.enqueued.length)}. Each starts a new attempt in a fresh trial container.`;
});
</script>

<template>
  <ErrorBanner
    v-if="error"
    :title="error.action === 'rescore' ? 'Could not re-score' : 'Could not retry'"
    :detail="error.message"
    :hint="error.issues"
    retry-label="Dismiss"
    data-testid="bulk-error"
    @retry="$emit('dismiss')"
  />
  <ErrorBanner
    v-else-if="outcome && outcome.refused.length"
    :title="refusedTitle"
    retry-label="Dismiss"
    data-testid="bulk-refused"
    @retry="$emit('dismiss')"
  >
    <ul class="flex flex-col gap-2 text-text-2">
      <li v-for="r in outcome.refused" :key="r.runId">
        <span class="font-mono text-12 text-text">{{ runName(r.runId) }}</span
        >: <code>{{ r.reason }}</code>
      </li>
    </ul>
    <template v-if="queuedLine" #hint>{{ queuedLine }}</template>
  </ErrorBanner>
  <ErrorBanner
    v-else-if="queuedLine"
    tone="info"
    :title="queuedLine"
    retry-label="Dismiss"
    data-testid="bulk-queued"
    @retry="$emit('dismiss')"
  />
</template>
