<script setup lang="ts">
import type { UploadProblem } from '@/api/types/resources';
import CodeText from '@/components/suites/CodeText.vue';

/** A rejected zip's problems (SA.10): each one in red, with what to do about it. */
defineProps<{ problems: UploadProblem[] }>();
</script>

<template>
  <div
    v-for="problem in problems"
    :key="problem.title"
    role="alert"
    class="flex items-start gap-10 rounded-4 border border-fail bg-fail-soft px-12 py-10"
    data-testid="zip-rejected"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      class="mt-2 flex-none text-fail-text"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 4.5v4M8 11h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
    <span class="flex flex-col gap-2">
      <b class="text-fail-text"><CodeText :text="problem.title" /></b>
      <span v-if="problem.detail" class="text-text-2"><CodeText :text="problem.detail" /></span>
    </span>
  </div>
</template>
