<script setup lang="ts">
import { computed } from 'vue';
import type { RunRow, RunSummaryCounts } from '@/api/types/runs';
import { useProvidersStore } from '@/stores/providers';
import type { BulkAction } from '@/stores/runs';
import { plural } from '@/lib/format';
import { bulkRules } from './bulkRules';
import { providerState } from './modelAccess';

/**
 * The line above the Runs table (Runs board). With nothing selected: "120 of 120 runs ·
 * 89 passed · 28 failed" and the execution-error and ungradable shortcut chips, which toggle
 * those filters. With a selection: the bulk bar, "3 selected · Re-score 3 · Retry execution",
 * the first reason an action is unavailable (amber, with Connect, when model access is in the
 * way) and Clear selection. On the right, always: what Re-score does.
 */
const props = withDefaults(
  defineProps<{
    summary: RunSummaryCounts | null;
    /** Rows shown. */
    shown: number;
    selected: RunRow[];
    busy?: BulkAction | null;
    execError?: boolean;
    ungradable?: boolean;
  }>(),
  { busy: null, execError: false, ungradable: false },
);
const emit = defineEmits<{
  rescore: [];
  retry: [];
  'clear-selection': [];
  'toggle-exec-error': [];
  'toggle-ungradable': [];
}>();

const providers = useProvidersStore();
const rules = computed(() =>
  bulkRules(props.selected, (row, side) => {
    const id = side === 'judge' ? row.needs.judgeProvider : row.needs.provider;
    return id ? providerState(providers, id) : null;
  }),
);

function connect(): void {
  void providers.connect('other');
}
</script>

<template>
  <div class="flex min-h-36 flex-wrap items-center justify-between gap-10">
    <div
      v-if="selected.length === 0"
      class="flex flex-wrap items-center gap-14 text-text-2"
      data-testid="runs-count-line"
    >
      <span
        ><b class="text-text">{{ shown }}</b> of {{ summary?.total ?? shown }} runs</span
      >
      <template v-if="summary">
        <span class="text-12 text-text-3" aria-hidden="true">·</span>
        <span
          >{{ summary.passed }} passed · {{ summary.failed }} failed<template v-if="summary.error">
            · {{ summary.error }} error</template
          ></span
        >
        <button
          v-if="summary.executionErrors > 0"
          type="button"
          class="chip cursor-pointer border-0 bg-err-soft text-err-text"
          :aria-pressed="execError ? 'true' : 'false'"
          data-testid="chip-exec-error"
          @click="emit('toggle-exec-error')"
        >
          {{ plural(summary.executionErrors, 'execution error', 'execution errors') }}
        </button>
        <button
          v-if="summary.ungradable > 0"
          type="button"
          class="chip cursor-pointer border-0 bg-ung-soft text-ung-text"
          :aria-pressed="ungradable ? 'true' : 'false'"
          data-testid="chip-ungradable"
          @click="emit('toggle-ungradable')"
        >
          {{ summary.ungradable }} ungradable
        </button>
      </template>
    </div>
    <div
      v-else
      role="toolbar"
      aria-label="Bulk actions"
      class="flex min-h-36 flex-wrap items-center gap-8 rounded-4 bg-accent-soft px-10 py-4"
      data-testid="bulk-bar"
    >
      <span class="font-medium">{{ selected.length }} selected</span>
      <button
        type="button"
        class="btn sm"
        :disabled="rules.rescoreDisabled || !!busy"
        :title="rules.rescoreTitle"
        :aria-busy="busy === 'rescore' || undefined"
        data-testid="bulk-rescore"
        @click="emit('rescore')"
      >
        {{ busy === 'rescore' ? 'Re-scoring…' : `Re-score ${selected.length}` }}
      </button>
      <button
        type="button"
        class="btn sm"
        :disabled="rules.retryDisabled || !!busy"
        :title="rules.retryTitle"
        :aria-busy="busy === 'retry' || undefined"
        data-testid="bulk-retry"
        @click="emit('retry')"
      >
        {{ busy === 'retry' ? 'Retrying…' : 'Retry execution' }}
      </button>
      <span
        v-if="rules.hint.length"
        class="text-12"
        :class="rules.blocked ? 'text-ung-text' : 'text-text-3'"
        data-testid="bulk-hint"
        ><template v-for="(part, i) in rules.hint" :key="i"
          ><code v-if="part.code">{{ part.text }}</code
          ><template v-else>{{ part.text }}</template></template
        ></span
      >
      <button
        v-if="rules.connect"
        type="button"
        class="linkbtn text-12"
        data-testid="bulk-connect"
        @click="connect"
      >
        Connect
      </button>
      <button type="button" class="btn sm ghost" @click="emit('clear-selection')">
        Clear selection
      </button>
    </div>
    <span class="text-12 text-text-3"
      >Re-score re-runs scorers on the stored output; it never re-executes the agent.</span
    >
  </div>
</template>
