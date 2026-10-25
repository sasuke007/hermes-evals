<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import type { SelectOption } from '@/components/ui/types';
import { formatDateTime, shortHash } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import FormSection from './FormSection.vue';
import TaskChecklist from './TaskChecklist.vue';
import { MIN_TASKS_FOR_VERDICT, useFormContext } from './useNewExperimentForm';

/**
 * Section 2, Suite and tasks (NewExperiment board): the suite select with where the suite
 * was loaded from, then the task checklist with every valid task ticked. With no suite loaded
 * the select is replaced by the way to load one (ExperimentStates › no suite loaded).
 */
const props = withDefaults(
  defineProps<{
    /** Duplicate: the original's suite version, for the "changed since" tags. */
    changedSince?: number | null;
    changedTasks?: string[];
  }>(),
  { changedSince: null, changedTasks: () => [] },
);
const form = useFormContext();

const suiteOptions = computed<SelectOption[]>(() =>
  form.suites.value.map((s) => ({
    value: s.suiteId,
    label: `${s.name} · v${s.versionNumber} (${s.taskCount} ${s.taskCount === 1 ? 'task' : 'tasks'}, ${s.validCount} valid)`,
  })),
);
const suiteId = computed({
  get: () => form.state.suiteId ?? '',
  set: (id: string) => form.selectSuite(id),
});
const fewTasks = computed(
  () => form.taskCount.value > 0 && form.taskCount.value < MIN_TASKS_FOR_VERDICT,
);
const changed = computed(() => (props.changedSince === null ? [] : props.changedTasks));
</script>

<template>
  <FormSection :number="2" title="Suite and tasks">
    <template v-if="form.suites.value.length === 0">
      <div class="flex flex-col gap-4">
        <span class="text-12 leading-20 font-medium text-text-2">Suite</span>
        <div
          class="flex h-32 w-280 items-center rounded-4 border border-border-strong bg-surface-2 px-10 text-text-3"
          aria-disabled="true"
        >
          No suites loaded
        </div>
      </div>
      <div
        class="flex flex-col items-start gap-6 rounded-4 border border-dashed border-border-strong p-20"
        data-testid="no-suites"
      >
        <b>No suites found in <code>./suites</code></b>
        <p class="text-text-2">
          Suites are folders on disk. Add one, then reload it on the Suites page.
        </p>
        <RouterLink :to="{ name: ROUTE_NAMES.suites }" class="btn sm">Go to Suites</RouterLink>
      </div>
    </template>

    <template v-else>
      <div class="flex flex-wrap items-end gap-12">
        <div class="w-320 max-sm:w-full">
          <BaseSelect id="ne-suite" v-model="suiteId" :options="suiteOptions" label="Suite" />
        </div>
        <span v-if="form.suite.value" class="pb-8 text-12 text-text-3" data-testid="suite-help">
          Loaded from <code>{{ form.suite.value.path }}</code> · v{{
            form.suite.value.versionNumber
          }}
          <BaseTag>{{ shortHash(form.suite.value.contentHash) }}</BaseTag> · self-check
          {{ formatDateTime(form.suite.value.selfCheckAt) }}
        </span>
      </div>

      <TaskChecklist
        v-if="form.suite.value"
        :suite="form.suite.value"
        :changed-since="changedSince"
        :changed-tasks="changed"
      />

      <div
        v-if="fewTasks"
        role="status"
        class="flex items-start gap-10 rounded-4 border border-ung bg-ung-soft px-12 py-10"
        data-testid="few-tasks-warning"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          class="mt-2 flex-none text-ung-text"
        >
          <path
            d="M8 1.8l6.5 11.4H1.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <path
            d="M8 6.2v3.2M8 11.4h.01"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <div>
          <b class="text-ung-text"
            >Fewer than {{ MIN_TASKS_FOR_VERDICT }} tasks cannot produce a verdict.</b
          >{{ ' '
          }}<span class="text-text-2"
            >You will get pass rates per configuration but no interval: it resamples the tasks, and
            with fewer it cannot say how sure the difference is.</span
          >
        </div>
      </div>
    </template>
  </FormSection>
</template>
