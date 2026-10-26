<script setup lang="ts">
import { computed } from 'vue';
import type { SuiteZipTask } from '@/api/types/authoring';
import CodeText from '@/components/suites/CodeText.vue';
import { isInvalid, splitTasks, taskLine } from './zipFormat';

/**
 * The tasks of a validated zip (SA.10): a tick and "valid" per task, an invalid one tinted
 * with its reason, and past eight tasks the valid rest on one line ("and 4 more valid: …").
 * Invalid tasks are imported too, and stay out of experiments until they are fixed.
 */
const props = defineProps<{ tasks: SuiteZipTask[] }>();

const split = computed(() => splitTasks(props.tasks));
const detailed = computed(() => props.tasks.length === 1);
</script>

<template>
  <ul
    class="flex flex-col rounded-4 border border-border"
    aria-label="Tasks"
    data-testid="zip-tasks"
  >
    <li
      v-for="task in split.shown"
      :key="task.key"
      class="flex items-start gap-8 border-b border-border px-12 py-6 last:border-b-0"
      :class="{ 'bg-err-soft': isInvalid(task), 'py-8': detailed }"
      :data-task="task.key"
      :data-readiness="task.readiness"
    >
      <span
        v-if="isInvalid(task)"
        class="mt-6 size-8 flex-none rounded-full border-[1.5px] border-dotted border-err bg-err-soft"
        aria-hidden="true"
      />
      <span
        v-else-if="task.readiness === 'not_run'"
        class="mt-6 size-8 flex-none rounded-full border-[1.5px] border-que"
        aria-hidden="true"
      />
      <svg
        v-else
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        class="mt-3 flex-none text-pass"
      >
        <path
          d="M2.5 7.5l3 3 6-7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span v-if="isInvalid(task)" class="flex flex-col gap-2">
        <span
          ><code>{{ task.key }}</code>
          <span class="font-medium text-err-text">
            · invalid<template v-if="task.problem">: </template></span
          ><CodeText v-if="task.problem" class="text-err-text" :text="task.problem"
        /></span>
      </span>
      <span v-else
        ><code>{{ task.key }}</code>
        <span class="text-text-2"> · {{ taskLine(task, detailed) }}</span></span
      >
    </li>
    <li v-if="split.more.length" class="flex items-start gap-8 px-12 py-6" data-testid="zip-more">
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        class="mt-3 flex-none text-pass"
      >
        <path
          d="M2.5 7.5l3 3 6-7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="text-text-2"
        >and {{ split.more.length }} more valid:
        <template v-for="(key, i) in split.more" :key="key"
          ><code>{{ key }}</code
          >{{ i < split.more.length - 1 ? ', ' : '' }}</template
        ></span
      >
    </li>
  </ul>
</template>
