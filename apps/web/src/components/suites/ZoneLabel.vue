<script setup lang="ts">
/**
 * Says whether a part of a task reaches the agent (TaskDetail, TaskDiff boards): "Visible
 * to the agent" (outlined, eye) on the prompt and fixtures, "Hidden from the agent"
 * (inverse, eye struck through) on the checks, the reference answer and the verifier.
 */
withDefaults(
  defineProps<{
    zone: 'visible' | 'hidden';
    /** Replaces the words, for a narrower use: "Agent sees · prompt.md", "Hidden · checks only". */
    label?: string | null;
  }>(),
  { label: null },
);
</script>

<template>
  <span
    class="inline-flex h-22 items-center gap-6 rounded-3 px-8 text-12 font-medium whitespace-nowrap"
    :class="zone === 'visible' ? 'border border-border bg-surface text-text-2' : 'bg-text text-bg'"
    :data-zone="zone"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="zone === 'visible'">
        <path
          d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
        />
        <circle cx="12" cy="12" r="3" />
      </template>
      <template v-else>
        <path
          d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
        />
        <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
        <path
          d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
        />
        <path d="m2 2 20 20" />
      </template>
    </svg>
    {{ label ?? (zone === 'visible' ? 'Visible to the agent' : 'Hidden from the agent') }}
  </span>
</template>
