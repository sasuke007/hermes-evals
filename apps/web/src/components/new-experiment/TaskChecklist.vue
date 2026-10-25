<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { RouterLink } from 'vue-router';
import type { NewExperimentSuiteOption } from '@/api/types/experiments';
import { ROUTE_NAMES } from '@/router';
import { useFormContext } from './useNewExperimentForm';

/**
 * The task checklist of section 2 (NewExperiment board; ExperimentStates › invalid task row):
 * a header with select-all and the count, then one row per task of the suite. An invalid task
 * is listed but cannot be selected: its row is greyed, its checkbox disabled, and its
 * self-check reason shows as a caption under the summary and in a card on the chip (hover or
 * focus; Esc hides it) with a link to the self-check output. On a duplicate, a task changed
 * since the original's suite version carries a tag saying so.
 */
const props = defineProps<{
  suite: NewExperimentSuiteOption;
  changedSince: number | null;
  changedTasks: string[];
}>();
const form = useFormContext();

const total = computed(() => props.suite.tasks.length);
const validCount = computed(() => form.validKeys.value.length);
const selected = computed(() => form.taskCount.value);
const allSelected = computed(() => validCount.value > 0 && selected.value === validCount.value);
const someSelected = computed(() => selected.value > 0 && !allSelected.value);

const selectAll = ref<HTMLInputElement | null>(null);
watchEffect(() => {
  if (selectAll.value) selectAll.value.indeterminate = someSelected.value;
});

const isSelected = (key: string): boolean => form.selectedTasks.value.includes(key);
const isChanged = (key: string): boolean => props.changedTasks.includes(key);

/** The reason card the user dismissed with Esc, until the pointer or focus leaves it. */
const dismissed = ref<string | null>(null);
function onKeydown(event: KeyboardEvent, key: string): void {
  if (event.key === 'Escape' && dismissed.value !== key) {
    dismissed.value = key;
    event.stopPropagation();
  }
}

const suiteRoute = computed(() => ({
  name: ROUTE_NAMES.suite,
  params: { id: props.suite.suiteId },
}));
const reasonId = (key: string): string => `ne-task-why-${key}`;
</script>

<template>
  <div class="rounded-4 border border-border" data-testid="task-checklist">
    <div
      class="flex flex-wrap items-center justify-between gap-8 rounded-t-4 border-b border-border bg-surface-2 px-14 py-6"
    >
      <label class="inline-flex cursor-pointer items-center gap-8 font-medium">
        <input
          ref="selectAll"
          type="checkbox"
          class="size-14 accent-accent"
          :checked="allSelected"
          :disabled="validCount === 0"
          @change="form.toggleAllTasks()"
        />
        {{ selected }} of {{ total }} tasks selected
      </label>
      <span class="text-12 text-text-3">Invalid tasks are listed but cannot be selected</span>
    </div>
    <table class="dt inset14" aria-label="Tasks">
      <thead>
        <tr>
          <th class="w-36 rounded-none"><span class="sr-only">Include</span></th>
          <th>Task</th>
          <th>Summary</th>
          <th class="text-right">Verification</th>
          <th>Validity</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="task in suite.tasks"
          :key="task.key"
          :class="{ '[&>td]:bg-surface-2': !task.valid }"
          :data-task="task.key"
          :data-valid="task.valid ? 'true' : 'false'"
        >
          <td class="w-36">
            <input
              v-if="task.valid"
              type="checkbox"
              class="size-14 accent-accent"
              :checked="isSelected(task.key)"
              :aria-label="`Include ${task.key}`"
              @change="form.toggleTask(task.key, ($event.target as HTMLInputElement).checked)"
            />
            <input
              v-else
              type="checkbox"
              class="size-14"
              disabled
              :aria-label="`${task.key} cannot be selected`"
              :aria-describedby="reasonId(task.key)"
            />
          </td>
          <td class="font-mono text-12" :class="{ 'text-text-3': !task.valid }">{{ task.key }}</td>
          <td class="py-6 whitespace-normal" :class="task.valid ? 'text-text-2' : 'text-text-3'">
            {{ task.summary }}
            <span
              v-if="!task.valid"
              :id="reasonId(task.key)"
              class="block text-12 leading-18"
              data-testid="invalid-caption"
              >{{ task.invalidReason ?? 'Its self-check failed.' }}</span
            >
          </td>
          <td class="text-right" :class="{ 'text-text-3': !task.valid }">
            {{ task.verificationCount }}
          </td>
          <td>
            <span class="inline-flex flex-wrap items-center gap-6">
              <span v-if="task.valid" class="inline-flex items-center gap-6 text-12 text-pass-text">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M2 6.5l2.5 2.5L10 3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                valid
              </span>
              <span
                v-else
                class="group/why relative inline-flex"
                @keydown="onKeydown($event, task.key)"
                @mouseleave="dismissed = null"
                @focusout="dismissed = null"
              >
                <span
                  tabindex="0"
                  class="chip bg-fail-soft text-fail-text"
                  :aria-describedby="`${reasonId(task.key)}-card`"
                  >self-check failed</span
                >
                <span
                  :id="`${reasonId(task.key)}-card`"
                  role="tooltip"
                  class="invisible absolute top-full right-0 z-10 w-360 pt-6"
                  :class="
                    dismissed === task.key
                      ? 'hidden'
                      : 'group-focus-within/why:visible group-hover/why:visible'
                  "
                >
                  <span
                    class="flex flex-col gap-4 rounded-6 border border-border bg-surface px-12 py-10 whitespace-normal shadow-float"
                  >
                    <b class="text-12">{{ task.key }} cannot be selected</b>
                    <span class="text-12 leading-18 text-text-2">{{
                      task.invalidReason ?? 'Its self-check failed.'
                    }}</span>
                    <RouterLink :to="suiteRoute" class="text-12"
                      >See the self-check output</RouterLink
                    >
                  </span>
                </span>
              </span>
              <span
                v-if="isChanged(task.key)"
                class="tag"
                :title="`Changed since the original experiment's suite v${changedSince}`"
                data-testid="changed-tag"
                >v{{ task.version }} · changed since v{{ changedSince }}</span
              >
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
