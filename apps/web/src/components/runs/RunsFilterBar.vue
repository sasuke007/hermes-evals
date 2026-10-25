<script setup lang="ts">
import { computed } from 'vue';
import { RUN_STATUSES, SCORE_STATUSES } from '@hermes-evals/shared';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ToggleButton from '@/components/ui/ToggleButton.vue';
import type { SelectOption } from '@/components/ui/types';
import { toneVars } from '@/lib/statusTones';

/**
 * The Runs tab's filters (Runs board): Configuration, Task, Run status and Score status
 * selects, the "Has execution error" and "Ungradable" toggles (one at a time), and Clear
 * filters while any is set. The page mirrors every value in the URL.
 */
const props = defineProps<{ configurations: string[]; tasks: string[] }>();

const config = defineModel<string>('config', { required: true });
const task = defineModel<string>('task', { required: true });
const status = defineModel<string>('status', { required: true });
const scoreStatus = defineModel<string>('scoreStatus', { required: true });
const execError = defineModel<boolean>('execError', { required: true });
const ungradable = defineModel<boolean>('ungradable', { required: true });
const emit = defineEmits<{ clear: [] }>();

const configOptions = computed<SelectOption[]>(() => [
  { value: 'all', label: 'All' },
  ...props.configurations.map((name) => ({ value: name, label: name })),
]);
const taskOptions = computed<SelectOption[]>(() => [
  { value: 'all', label: `All ${props.tasks.length} tasks` },
  ...props.tasks.map((key) => ({ value: key, label: key })),
]);
const statusOptions: SelectOption[] = [
  { value: 'any', label: 'Any' },
  ...RUN_STATUSES.map((s) => ({ value: s, label: s })),
];
const scoreOptions: SelectOption[] = [
  { value: 'any', label: 'Any' },
  ...SCORE_STATUSES.map((s) => ({ value: s, label: s })),
];

const anyFilter = computed(
  () =>
    config.value !== 'all' ||
    task.value !== 'all' ||
    status.value !== 'any' ||
    scoreStatus.value !== 'any' ||
    execError.value ||
    ungradable.value,
);

/** The two toggles exclude each other, as on the board. */
const exec = computed({
  get: () => execError.value,
  set: (on: boolean) => {
    execError.value = on;
    if (on) ungradable.value = false;
  },
});
const ung = computed({
  get: () => ungradable.value,
  set: (on: boolean) => {
    ungradable.value = on;
    if (on) execError.value = false;
  },
});
const ungHatch = computed(() => {
  const v = toneVars('ung');
  return { background: `repeating-linear-gradient(135deg, ${v.solid} 0 2px, ${v.soft} 2px 4px)` };
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-8" role="group" aria-label="Filter runs">
    <label class="text-12 text-text-2" for="runs-config">Configuration</label>
    <BaseSelect id="runs-config" v-model="config" :options="configOptions" size="sm" />
    <label class="ml-6 text-12 text-text-2" for="runs-task">Task</label>
    <BaseSelect id="runs-task" v-model="task" :options="taskOptions" size="sm" />
    <label class="ml-6 text-12 text-text-2" for="runs-status">Run status</label>
    <BaseSelect id="runs-status" v-model="status" :options="statusOptions" size="sm" />
    <label class="ml-6 text-12 text-text-2" for="runs-score">Score status</label>
    <BaseSelect id="runs-score" v-model="scoreStatus" :options="scoreOptions" size="sm" />
    <ToggleButton v-model="exec" data-testid="toggle-exec-error"
      ><span class="size-8 rounded-full bg-err" aria-hidden="true" />Has execution
      error</ToggleButton
    >
    <ToggleButton v-model="ung" data-testid="toggle-ungradable"
      ><span
        class="size-8 rounded-2"
        :style="ungHatch"
        aria-hidden="true"
      />Ungradable</ToggleButton
    >
    <button v-if="anyFilter" type="button" class="btn sm ghost" @click="emit('clear')">
      Clear filters
    </button>
  </div>
</template>
