<script setup lang="ts">
import { computed, useId } from 'vue';
import CandidateSelect from './CandidateSelect.vue';
import { SCORE_KEY_HELP } from './readings';
import type { ComparisonFilter, ComparisonView } from '@/api/types/experiments';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import SegmentedControl from '@/components/ui/SegmentedControl.vue';
import type { SegmentOption, SelectOption } from '@/components/ui/types';

/**
 * The Comparison control bar (Comparison board): the baseline, fixed by the experiment; the
 * candidate (a select from two candidates on, else "only one"); the score key the cells and
 * the statistics follow; and the task filter with its counts. The selects show the selection
 * the URL names when the view has it, so a choice whose load failed keeps its value.
 */
const props = withDefaults(
  defineProps<{
    view: ComparisonView;
    filter: ComparisonFilter;
    /** false hides the filter (one repetition, nothing scored: no task has a change). */
    showFilter?: boolean;
    /** The candidate version the URL names (null: the view's). */
    selectedCandidate?: string | null;
    /** The score key the URL names (null: the view's). */
    selectedKey?: string | null;
  }>(),
  { showFilter: true, selectedCandidate: null, selectedKey: null },
);
const emit = defineEmits<{
  'update:candidate': [versionId: string];
  'update:scoreKey': [key: string];
  'update:filter': [filter: ComparisonFilter];
}>();

const uid = useId();
const candidateLabelId = `cmp-candidate-label-${uid}`;
const candidateId = `cmp-candidate-${uid}`;

const keyOptions = computed<SelectOption<string>[]>(() =>
  props.view.scoreKeyOptions.map((o) => ({ value: o.value, label: o.label })),
);
const candidateValue = computed(() => {
  const id = props.selectedCandidate;
  return id && props.view.candidates.some((o) => o.configuration.versionId === id)
    ? id
    : props.view.candidate.versionId;
});
const scoreKey = computed({
  get: () => {
    const key = props.selectedKey;
    return key && props.view.scoreKeyOptions.some((o) => o.value === key)
      ? key
      : props.view.scoreKey;
  },
  set: (key: string) => emit('update:scoreKey', key),
});
const filterModel = computed({
  get: () => props.filter,
  set: (filter: ComparisonFilter) => emit('update:filter', filter),
});
const filterOptions = computed<SegmentOption<ComparisonFilter>[]>(() => {
  const n = props.view.filterCounts;
  return [
    { value: 'all', label: 'All tasks', count: n.all },
    { value: 'improved', label: 'Improved', count: n.improved },
    { value: 'regressed', label: 'Regressed', count: n.regressed },
    { value: 'unchanged', label: 'Unchanged', count: n.unchanged },
  ];
});
</script>

<template>
  <div
    class="flex flex-wrap items-end gap-x-24 gap-y-16 rounded-6 border border-border bg-surface px-16 py-12"
    data-testid="comparison-controls"
  >
    <div class="flex flex-col gap-4">
      <span class="text-12 leading-20 font-medium text-text-2">Baseline</span>
      <div
        class="input flex w-200 items-center gap-8 bg-surface-2"
        title="Fixed by the experiment"
        data-testid="baseline"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          class="flex-none text-text-3"
        >
          <rect
            x="2.5"
            y="5.5"
            width="7"
            height="5"
            rx="1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path
            d="M4 5.5V4a2 2 0 0 1 4 0v1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
        </svg>
        <span class="truncate font-mono" :title="view.baseline.name">{{ view.baseline.name }}</span>
      </div>
    </div>

    <div class="flex flex-col gap-4">
      <template v-if="view.candidates.length > 1">
        <label
          :id="candidateLabelId"
          :for="candidateId"
          class="text-12 leading-20 font-medium text-text-2"
          >Candidate</label
        >
        <CandidateSelect
          :id="candidateId"
          :labelledby="candidateLabelId"
          :options="view.candidates"
          :model-value="candidateValue"
          @update:model-value="emit('update:candidate', $event)"
        />
      </template>
      <template v-else>
        <span class="text-12 leading-20 font-medium text-text-2">Candidate</span>
        <div class="input flex w-200 items-center gap-8 bg-surface-2" data-testid="candidate">
          <span class="truncate font-mono" :title="view.candidate.name">{{
            view.candidate.name
          }}</span>
          <span class="ml-auto flex-none text-12 whitespace-nowrap text-text-3">only one</span>
        </div>
      </template>
    </div>

    <div class="w-260">
      <BaseSelect
        id="cmp-key"
        v-model="scoreKey"
        label="Score key"
        :options="keyOptions"
        :help="SCORE_KEY_HELP"
        :title="SCORE_KEY_HELP"
        width="100%"
      />
    </div>

    <div class="flex-1" />

    <div v-if="showFilter" class="flex max-w-full flex-col gap-4">
      <span class="text-12 leading-20 font-medium text-text-2">Show</span>
      <!-- Narrow screens scroll the filter rather than wrap its labels. -->
      <SegmentedControl
        v-model="filterModel"
        class="max-w-full overflow-x-auto"
        size="md"
        label="Filter tasks"
        :options="filterOptions"
      />
    </div>
  </div>
</template>
